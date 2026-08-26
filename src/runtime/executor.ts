import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

import type { ExecutorName, ReviewConfig, ReviewModelUsage } from "../lib/types.js";

export interface ExecutorCapabilities {
  readonly goalCommand: boolean;
  readonly maxTurns: boolean;
  readonly inProcessMcp: boolean;
}

export interface ReviewToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly handler: (input: Record<string, unknown>) => Promise<CallToolResult>;
  readonly alwaysLoad: boolean;
}

export interface ReviewSessionInput {
  readonly config: ReviewConfig;
  readonly cwd: string;
  readonly goalIndex: number;
  readonly logSecrets: readonly string[];
  readonly systemPrompt: string;
  readonly outputServerName: string;
  readonly outputServerInstructions: string;
  readonly tools: readonly ReviewToolDefinition[];
  readonly abortController?: AbortController;
}

export interface ReviewTurnResult {
  readonly success: boolean;
  readonly error?: string;
}

export interface ReviewSession {
  runReview(
    goalCommand: string,
    reviewPrompt: string,
    activateTools: () => void,
  ): Promise<ReviewTurnResult>;
  runRepair(prompt: string): Promise<ReviewTurnResult>;
  configuredServerFailures(): Promise<readonly string[]>;
  usage(): {
    readonly models: readonly ReviewModelUsage[];
    readonly complete: boolean;
  };
  close(): Promise<void>;
}

export interface ReviewExecutor {
  readonly name: ExecutorName;
  readonly capabilities: ExecutorCapabilities;
  effectiveFingerprint(config: ReviewConfig): unknown;
  createSession(input: ReviewSessionInput): Promise<ReviewSession>;
}

export function effectiveExecutorFingerprint(config: ReviewConfig): unknown {
  return {
    executor: config.executor,
    apiBaseUrl: config.aiBaseUrl ?? null,
    effort: config.effort ?? null,
    authentication: "api-key",
    repositoryTools: "fixed-revision-v1",
    ...(config.executor === "claude" ? { maxTurns: config.maxTurns ?? 50 } : {}),
  };
}
