import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import type {
  McpServerConfig,
  Options,
  Query,
  SDKActiveGoalMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ReviewConfig, GoalTokenUsage } from "../lib/types.js";
import { toSdkMcpServer, type AgentQuery } from "./agent-session.js";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { toClaudeTool } from "./review-tool.js";
import type { ReviewTool } from "./review-tool.js";
import { CodexSession } from "./codex-session.js";
import type { ReviewContextDelivery } from "./review-context-delivery.js";
import { createDeferred, makeUserMessage } from "./session-runner.js";

export type ReviewSession = AsyncIterable<SDKMessage | SDKActiveGoalMessage> &
  Pick<Query, "interrupt" | "mcpServerStatus"> & {
    close(): void | Promise<void>;
    nativeModelTurns?: () => number;
  };

export interface ReviewSessionInput {
  readonly config: ReviewConfig;
  readonly cwd: string;
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: Options;
  readonly tools: readonly ReviewTool[];
  readonly outputServerName: string;
  readonly cleanup?: () => Promise<void>;
  readonly isAccepted?: () => boolean;
  readonly sessionHome?: string;
  readonly forkFrom?: string;
  readonly inheritedUsage?: GoalTokenUsage;
  readonly contextDelivery?: ReviewContextDelivery;
}

export function createReviewSession(query: AgentQuery, input: ReviewSessionInput): ReviewSession {
  if (input.config.executor === "codex") return new CodexSession(input);
  const delivery = input.contextDelivery;
  const boundedGoal = delivery !== undefined && input.forkFrom !== undefined;
  const forkReady = createDeferred<boolean>();
  const activationClosed = () => closing || input.options.abortController?.signal.aborted === true;
  const responseIds = new Set<string>();
  async function* withContext(): AsyncGenerator<SDKUserMessage> {
    let first = true;
    for await (const message of input.prompt) {
      if (first) {
        first = false;
        if (boundedGoal) {
          yield { ...message, shouldQuery: false };
          const ready = await Promise.race([forkReady.promise, wait(3_000, true, { ref: false })]);
          if (!ready || activationClosed()) return;
          await delivery.refresh();
          if (activationClosed()) return;
          const packet = delivery.stage();
          if (packet !== undefined)
            yield { ...makeUserMessage(packet.text), client_composed: true, shouldQuery: false };
          continue;
        }
        const packet = delivery?.stage();
        if (packet !== undefined) {
          if (typeof message.message.content === "string") {
            yield {
              ...message,
              client_composed: true as const,
              message: {
                role: "user" as const,
                content: [
                  { type: "text" as const, text: message.message.content },
                  { type: "text" as const, text: packet.text },
                ],
              },
            };
            continue;
          }
        }
      }
      yield message;
    }
  }
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<void> | undefined;
  let closing = false;
  let shutdown: Promise<void> | undefined;
  const session = query({
    prompt: delivery === undefined ? input.prompt : withContext(),
    options: {
      ...input.options,
      ...(boundedGoal
        ? {
            hooks: {
              ...input.options.hooks,
              PreToolUse: [
                ...(input.options.hooks?.PreToolUse ?? []),
                {
                  hooks: [
                    () =>
                      Promise.resolve(
                        responseIds.size <= input.config.maxTurns
                          ? {}
                          : {
                              continue: false,
                              stopReason: "The configured native turn limit was reached.",
                              hookSpecificOutput: {
                                hookEventName: "PreToolUse",
                                permissionDecision: "deny",
                                permissionDecisionReason:
                                  "The configured native turn limit was reached.",
                              },
                            },
                      ),
                  ],
                },
              ],
              PostToolBatch: [
                ...(input.options.hooks?.PostToolBatch ?? []),
                {
                  hooks: [
                    () =>
                      Promise.resolve(
                        responseIds.size >= input.config.maxTurns
                          ? {
                              continue: false,
                              stopReason: "The configured native turn limit was reached.",
                            }
                          : {},
                      ),
                  ],
                },
              ],
            },
          }
        : {}),
      ...(input.sessionHome === undefined
        ? {}
        : {
            env: { ...input.options.env, CLAUDE_CONFIG_DIR: input.sessionHome },
            persistSession: true,
          }),
      ...(input.forkFrom === undefined ? {} : { resume: input.forkFrom, forkSession: true }),
      ...(input.sessionHome === undefined
        ? {}
        : {
            spawnClaudeCodeProcess: (options) => {
              if (closing) throw new Error("The shared Claude session closed before spawn.");
              child = spawn(options.command, options.args, {
                cwd: options.cwd,
                env: options.env,
                signal: options.signal,
                stdio: "pipe",
                windowsHide: true,
              });
              child.stderr.on("data", (data: Buffer) =>
                input.options.stderr?.(data.toString("utf8")),
              );
              exited = new Promise<void>((resolve) => {
                child?.once("close", () => {
                  resolve();
                });
              });
              return child;
            },
          }),
    },
  });
  if (input.sessionHome === undefined) return session;
  return {
    ...(boundedGoal ? { nativeModelTurns: () => responseIds.size } : {}),
    async *[Symbol.asyncIterator]() {
      for await (const message of session) {
        if (message.type === "system" && message.subtype === "init")
          delivery?.history.attach({ sessionId: message.session_id, executor: "claude" });
        if (boundedGoal && message.type === "result" && message.num_turns === 0)
          forkReady.resolve(message.subtype === "success" && !message.is_error);
        if (
          boundedGoal &&
          message.type === "assistant" &&
          message.parent_tool_use_id === null &&
          message.message.model !== "<synthetic>" &&
          message.error === undefined
        )
          responseIds.add(message.message.id);
        yield message;
      }
    },
    interrupt: () => session.interrupt(),
    mcpServerStatus: () => session.mcpServerStatus(),
    close: () =>
      (shutdown ??= (async () => {
        closing = true;
        forkReady.resolve(false);
        session.close();
        // The SDK's seven-second kill fallback exceeds the host's five-second closure deadline.
        const kill = setTimeout(() => {
          child?.kill("SIGKILL");
        }, 3_000);
        try {
          await Promise.all([exited, session[Symbol.asyncDispose]()]);
        } finally {
          clearTimeout(kill);
        }
      })()),
  };
}

export function createReviewMcpServers(
  config: ReviewConfig,
  tools: readonly ReviewTool[],
  hasContextFiles: boolean,
  phase: "review" | "discovery" = "review",
  hasContextPackets = false,
): Record<string, McpServerConfig> {
  const mcpServers: Record<string, McpServerConfig> = {
    ["review_output"]: createSdkMcpServer({
      name: "review_output",
      version: "2.0.0",
      instructions:
        phase === "discovery"
          ? "Start with read_change_overview, selectively inspect fixed-revision source, and finish_discovery with a bounded neutral change map and explicit unknowns. The complete briefing and diff are optional during orientation; every child review independently completes required coverage."
          : hasContextPackets
            ? "Inspect the shared user-role packets. When more=true, call advance_review_context when ready for the next packet. Use the paged tools for targeted investigation or unconfirmed ranges. After the sweep, complete outstanding checks and call submit_review."
            : !hasContextFiles
              ? "Call read_review_briefing until done=true, then investigate with the repository and Git tools. Read prior discussion and the diff as needed before submitting the complete review. Recover existing evidence and validation gaps with read_review_state after compaction or rejection; validation allows five corrections, while required inspection has separate bounded recovery. Refresh state after recovery pages to avoid overlapping reads."
              : "Call read_review_briefing until done=true, then investigate with the repository and Git tools. Optionally call read_context_file only for an authorized path relevant to the goal. Read prior discussion and the diff as needed before submitting the complete review. Recover existing evidence and validation gaps with read_review_state after compaction or rejection; validation allows five corrections, while required inspection has separate bounded recovery. Refresh state after recovery pages to avoid overlapping reads.",
      tools: tools.map(toClaudeTool),
      alwaysLoad: true,
    }),
  };
  for (const [name, server] of Object.entries(config.mcpServers))
    mcpServers[name] = toSdkMcpServer(server);
  return mcpServers;
}
