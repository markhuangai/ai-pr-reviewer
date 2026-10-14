import type {
  McpServerConfig,
  Options,
  Query,
  SDKActiveGoalMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ReviewConfig } from "../lib/types.js";
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
}

export function createReviewSession(query: AgentQuery, input: ReviewSessionInput): ReviewSession {
  return input.config.executor === "codex"
    ? new CodexSession(input)
    : query({ prompt: input.prompt, options: input.options });
}

export function createReviewMcpServers(
  config: ReviewConfig,
  tools: readonly ReviewTool[],
  hasContextFiles: boolean,
): Record<string, McpServerConfig> {
  const mcpServers: Record<string, McpServerConfig> = {
    ["review_output"]: createSdkMcpServer({
      name: "review_output",
      version: "2.0.0",
      instructions: !hasContextFiles
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
