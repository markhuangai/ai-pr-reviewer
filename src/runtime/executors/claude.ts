import {
  createSdkMcpServer,
  query as sdkQuery,
  tool,
  type McpServerConfig,
  type SDKActiveGoalMessage,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { throwIfAborted } from "../../lib/bootstrap/cancellation.js";
import type { ReviewModelUsage } from "../../lib/types.js";
import {
  createAgentLifecycleState,
  errorMessage,
  logAgentEventSafely,
  logAgentLifecycleMessage,
  logAgentMessageSafely,
  logQueuedUserMessage,
  modelUsageSnapshot,
  writeAgentLifecycleLog,
  writeCompleteAgentLog,
  type AgentToolUse,
} from "../agent-logging.js";
import {
  PromptStream,
  makeOptions,
  makeUserMessage,
  toSdkMcpServer,
  type AgentQuery,
} from "../agent-session.js";
import {
  effectiveExecutorFingerprint,
  type ReviewExecutor,
  type ReviewSession,
  type ReviewSessionInput,
  type ReviewTurnResult,
  type ReviewToolDefinition,
} from "../executor.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function toClaudeTool(definition: ReviewToolDefinition) {
  return tool(
    definition.name,
    definition.description,
    definition.inputSchema,
    (input) => definition.handler(input),
    { alwaysLoad: definition.alwaysLoad },
  );
}

class ClaudeReviewSession implements ReviewSession {
  private readonly input = new PromptStream();
  private turn = deferred<SDKResultMessage>();
  private readonly lifecycle = createAgentLifecycleState();
  private readonly toolUses = new Map<string, AgentToolUse>();
  private readonly configuredMcpNames: ReadonlySet<string>;
  private readonly sdkSession: ReturnType<AgentQuery>;
  private readonly reader: Promise<void>;
  private readerFailure: Error | undefined;
  private models: readonly ReviewModelUsage[] = [];
  private latestSnapshotValid = false;
  private repairAttempts = 0;
  private toolsActive = false;
  private closed = false;

  constructor(
    private readonly sessionInput: ReviewSessionInput,
    queryAgent: AgentQuery,
  ) {
    const {
      config,
      cwd,
      outputServerName,
      outputServerInstructions,
      tools,
      abortController,
      goalIndex,
      logSecrets,
      systemPrompt,
    } = sessionInput;
    const mcpServers: Record<string, McpServerConfig> = {
      [outputServerName]: createSdkMcpServer({
        name: outputServerName,
        version: "1.0.0",
        instructions: outputServerInstructions,
        tools: tools.map(toClaudeTool),
        alwaysLoad: true,
      }),
    };
    for (const [name, server] of Object.entries(config.mcpServers)) {
      mcpServers[name] = toSdkMcpServer(server);
    }
    this.configuredMcpNames = new Set(Object.keys(config.mcpServers));
    logAgentEventSafely(goalIndex, logSecrets, (write) => {
      writeAgentLifecycleLog(goalIndex, "start", { prompt_gate: "closed" }, logSecrets, write);
      writeCompleteAgentLog(
        goalIndex,
        "system message",
        "review",
        "text",
        systemPrompt,
        logSecrets,
        write,
      );
    });
    this.sdkSession = queryAgent({
      prompt: this.input,
      options: makeOptions(
        config,
        cwd,
        mcpServers,
        outputServerName,
        tools.some((candidate) => candidate.name === "read_context_file"),
        abortController,
        systemPrompt,
      ),
    });
    this.reader = this.readMessages();
    const signal = abortController?.signal;
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.abort();
  }

  private readonly abort = (): void => {
    this.input.finish();
    this.turn.reject(
      this.sessionInput.abortController?.signal.reason ??
        new Error("The pull request review was cancelled."),
    );
  };

  private async readMessages(): Promise<void> {
    const { goalIndex, logSecrets, abortController } = this.sessionInput;
    try {
      for await (const message of this.sdkSession as AsyncIterable<
        SDKMessage | SDKActiveGoalMessage
      >) {
        if (message.type !== "active_goal") {
          logAgentMessageSafely(message, goalIndex, logSecrets, this.toolUses);
        }
        logAgentEventSafely(goalIndex, logSecrets, (write) => {
          logAgentLifecycleMessage(message, goalIndex, logSecrets, this.lifecycle, write);
        });
        if (message.type === "result") {
          const snapshot = modelUsageSnapshot(message.modelUsage);
          this.latestSnapshotValid = snapshot !== undefined;
          if (snapshot !== undefined) this.models = snapshot;
          const completedTurn = this.turn;
          this.turn = deferred<SDKResultMessage>();
          completedTurn.resolve(message);
        }
      }
    } catch (error) {
      this.readerFailure = error instanceof Error ? error : new Error(errorMessage(error));
      this.turn.reject(this.readerFailure);
    } finally {
      if (abortController?.signal.aborted) this.turn.reject(abortController.signal.reason);
    }
  }

  private async result(): Promise<ReviewTurnResult> {
    throwIfAborted(this.sessionInput.abortController?.signal);
    const result = await this.turn.promise;
    throwIfAborted(this.sessionInput.abortController?.signal);
    if (result.subtype === "success") return { success: true };
    return {
      success: false,
      error: result.errors.join("; ") || `Claude returned ${result.subtype}.`,
    };
  }

  async runReview(
    goalCommand: string,
    reviewPrompt: string,
    activateTools: () => void,
  ): Promise<ReviewTurnResult> {
    const { goalIndex, logSecrets } = this.sessionInput;
    const goalMessage = makeUserMessage(goalCommand);
    const reviewMessage = makeUserMessage(reviewPrompt);
    this.input.push(goalMessage);
    this.input.push(reviewMessage);
    activateTools();
    this.toolsActive = true;
    logAgentEventSafely(goalIndex, logSecrets, (write) => {
      logQueuedUserMessage(goalMessage, "goal", goalIndex, logSecrets, write);
      logQueuedUserMessage(reviewMessage, "review", goalIndex, logSecrets, write);
      writeAgentLifecycleLog(
        goalIndex,
        "prompt-gate-open",
        { queued_messages: 2 },
        logSecrets,
        write,
      );
    });
    return this.result();
  }

  runRepair(prompt: string): Promise<ReviewTurnResult> {
    this.repairAttempts += 1;
    const { goalIndex, logSecrets } = this.sessionInput;
    const repairMessage = makeUserMessage(prompt);
    this.input.push(repairMessage);
    logAgentEventSafely(goalIndex, logSecrets, (write) => {
      logQueuedUserMessage(
        repairMessage,
        `repair-${this.repairAttempts}`,
        goalIndex,
        logSecrets,
        write,
      );
    });
    return this.result();
  }

  async configuredServerFailures(): Promise<readonly string[]> {
    return (await this.sdkSession.mcpServerStatus())
      .filter(
        (status) =>
          this.configuredMcpNames.has(status.name) &&
          (status.status === "failed" || status.status === "needs-auth"),
      )
      .map((status) => `${status.name}: ${status.error ?? status.status}`);
  }

  usage() {
    return {
      models: this.models,
      complete: this.readerFailure === undefined && this.latestSnapshotValid,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.finish();
    await this.reader.catch(() => undefined);
    this.sessionInput.abortController?.signal.removeEventListener("abort", this.abort);
    const { goalIndex, logSecrets } = this.sessionInput;
    logAgentEventSafely(goalIndex, logSecrets, (write) => {
      writeAgentLifecycleLog(
        goalIndex,
        "end",
        {
          executor: "claude",
          session_id: this.lifecycle.sessionId,
          prompt_gate: this.toolsActive ? "open" : "closed",
          turn_results: this.lifecycle.turnResults,
          latest_turn_count: this.lifecycle.latestTurnCount,
          api_retries: this.lifecycle.apiRetries,
          repair_attempts: this.repairAttempts,
          goal_iterations: this.lifecycle.goalIterations,
          compaction_starts: this.lifecycle.compactionStarts,
          compaction_successes: this.lifecycle.compactionSuccesses,
          compaction_failures: this.lifecycle.compactionFailures,
          compaction_boundaries: this.lifecycle.compactionBoundaries,
        },
        logSecrets,
        write,
      );
    });
  }
}

export class ClaudeReviewExecutor implements ReviewExecutor {
  readonly name = "claude" as const;
  readonly capabilities = {
    goalCommand: true,
    maxTurns: true,
    inProcessMcp: true,
  } as const;

  constructor(private readonly queryAgent: AgentQuery = sdkQuery) {}

  effectiveFingerprint(config: ReviewSessionInput["config"]): unknown {
    return effectiveExecutorFingerprint(config);
  }

  createSession(input: ReviewSessionInput): Promise<ReviewSession> {
    if (input.config.aiBaseUrl === undefined) {
      return Promise.reject(new Error("The Claude executor requires an AI base URL."));
    }
    try {
      return Promise.resolve(new ClaudeReviewSession(input, this.queryAgent));
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(errorMessage(error)));
    }
  }
}
