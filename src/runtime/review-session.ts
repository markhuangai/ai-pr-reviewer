import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

export type ReviewSession = AsyncIterable<SDKMessage | SDKActiveGoalMessage> &
  Pick<Query, "interrupt" | "mcpServerStatus"> & { close(): void | Promise<void> };

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
}

export function createReviewSession(query: AgentQuery, input: ReviewSessionInput): ReviewSession {
  if (input.config.executor === "codex") return new CodexSession(input);
  let child: ChildProcessWithoutNullStreams | undefined;
  let exited: Promise<void> | undefined;
  let closing = false;
  let shutdown: Promise<void> | undefined;
  const session = query({
    prompt: input.prompt,
    options: {
      ...input.options,
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
    [Symbol.asyncIterator]: () => session[Symbol.asyncIterator](),
    interrupt: () => session.interrupt(),
    mcpServerStatus: () => session.mcpServerStatus(),
    close: () =>
      (shutdown ??= (async () => {
        closing = true;
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
): Record<string, McpServerConfig> {
  const mcpServers: Record<string, McpServerConfig> = {
    ["review_output"]: createSdkMcpServer({
      name: "review_output",
      version: "2.0.0",
      instructions:
        phase === "discovery"
          ? "Start with read_change_overview, selectively inspect fixed-revision source, and finish_discovery with a bounded neutral change map and explicit unknowns. The complete briefing and diff are optional during orientation; every child review independently completes required coverage."
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
