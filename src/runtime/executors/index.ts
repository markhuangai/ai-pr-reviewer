import type { ExecutorName, ReviewConfig } from "../../lib/types.js";
import type { ReviewExecutor } from "../executor.js";
import { ClaudeReviewExecutor } from "./claude.js";
import { CodexReviewExecutor } from "./codex.js";

const executors: Readonly<Record<ExecutorName, ReviewExecutor>> = {
  codex: new CodexReviewExecutor(),
  claude: new ClaudeReviewExecutor(),
};

export function reviewExecutor(name: ExecutorName): ReviewExecutor {
  return executors[name];
}

export function reviewExecutorFingerprint(config: ReviewConfig): unknown {
  return reviewExecutor(config.executor).effectiveFingerprint(config);
}

export const registeredReviewExecutors = executors;
