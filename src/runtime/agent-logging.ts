import * as core from "@actions/core";
import type {
  SDKActiveGoalMessage,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type { GoalResult, ReviewModelUsage } from "../lib/types.js";

const MAX_AGENT_LOG_PREVIEW_LENGTH = 200;
const MAX_AGENT_LOG_CHUNK_LENGTH = 8_000;
const MAX_AGENT_LOG_PROJECTION_CHARACTERS = 1_024;
const MAX_AGENT_LOG_PROJECTION_NODES = 100;
const MAX_AGENT_LOG_PROJECTION_DEPTH = 8;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactAgentLogSecret(value: string, secret: string): string {
  if (secret.length < 8 && /^[A-Za-z0-9]+$/u.test(secret)) {
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(secret)}(?![A-Za-z0-9])`, "gu");
    return value.replace(pattern, "[REDACTED]");
  }
  return value.split(secret).join("[REDACTED]");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function redactAgentLog(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => redactAgentLogSecret(result, secret), value);
}

function projectCompleteAgentLogValue(
  value: unknown,
  secrets: readonly string[],
  stack = new Set<object>(),
): unknown {
  if (typeof value === "string") return redactAgentLog(value, secrets);
  if (typeof value === "bigint") throw new TypeError("BigInt is not JSON serializable.");
  if (typeof value !== "object" || value === null) return value;
  if (stack.has(value)) throw new TypeError("Circular agent log value.");

  stack.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => projectCompleteAgentLogValue(item, secrets, stack));

    const projected: Record<string, unknown> = {};
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      projected[redactAgentLog(key, secrets)] = projectCompleteAgentLogValue(
        (value as Record<string, unknown>)[key],
        secrets,
        stack,
      );
    }
    return projected;
  } finally {
    stack.delete(value);
  }
}

export function completeAgentLogValue(value: unknown, secrets: readonly string[]): string {
  try {
    const projected = projectCompleteAgentLogValue(value, secrets);
    if (projected === undefined) return "undefined";
    return JSON.stringify(projected);
  } catch {
    return "[unserializable value]";
  }
}

export function chunkAgentLogValue(
  value: string,
  maxLength = MAX_AGENT_LOG_CHUNK_LENGTH,
): readonly string[] {
  if (!Number.isInteger(maxLength) || maxLength < 2)
    throw new RangeError("Agent log chunk length must be an integer of at least 2.");
  if (value.length === 0) return [""];

  const chunks: string[] = [];
  for (let offset = 0; offset < value.length;) {
    let end = Math.min(offset + maxLength, value.length);
    if (
      end < value.length &&
      /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "") &&
      /[\uDC00-\uDFFF]/u.test(value[end] ?? "")
    ) {
      end -= 1;
    }
    chunks.push(value.slice(offset, end));
    offset = end;
  }
  return chunks;
}

function redactBoundedAgentLogString(
  value: string,
  secrets: readonly string[],
  maxLength: number,
): string {
  const prefix = value.slice(0, maxLength);
  let crossingSecretStart = prefix.length;
  if (value.length > prefix.length) {
    for (const secret of secrets) {
      if (secret.length < 2) continue;
      const firstCharacter = secret[0];
      if (firstCharacter === undefined) continue;
      const minimumStart = Math.max(0, prefix.length - secret.length + 1);
      let start = prefix.lastIndexOf(firstCharacter);
      while (start >= minimumStart) {
        if (start + secret.length > prefix.length && value.startsWith(secret, start)) {
          crossingSecretStart = Math.min(crossingSecretStart, start);
          break;
        }
        start = prefix.lastIndexOf(firstCharacter, start - 1);
      }
    }
  }
  const bounded =
    crossingSecretStart < prefix.length
      ? `${prefix.slice(0, crossingSecretStart)}[REDACTED]`
      : prefix;
  return redactAgentLog(bounded, secrets);
}

interface AgentLogProjectionState {
  remainingCharacters: number;
  remainingNodes: number;
  truncated: boolean;
  readonly stack: Set<object>;
}

interface AgentLogProjection {
  readonly raw: unknown;
  readonly redacted: unknown;
}

function projectAgentLogString(
  value: string,
  secrets: readonly string[],
  state: AgentLogProjectionState,
): AgentLogProjection {
  const length = Math.min(value.length, state.remainingCharacters);
  const raw = value.slice(0, length);
  const redacted = redactBoundedAgentLogString(value, secrets, length);
  state.remainingCharacters -= length;
  if (length < value.length) state.truncated = true;
  return { raw, redacted };
}

function projectAgentLogValue(
  value: unknown,
  secrets: readonly string[],
  state: AgentLogProjectionState,
  depth = 0,
): AgentLogProjection {
  if (state.remainingNodes === 0 || depth > MAX_AGENT_LOG_PROJECTION_DEPTH) {
    state.truncated = true;
    return { raw: "[truncated]", redacted: "[truncated]" };
  }
  state.remainingNodes -= 1;
  if (typeof value === "string") return projectAgentLogString(value, secrets, state);
  if (typeof value === "bigint") throw new TypeError("BigInt is not JSON serializable.");
  if (typeof value !== "object" || value === null) return { raw: value, redacted: value };
  if (state.stack.has(value)) throw new TypeError("Circular agent log value.");

  state.stack.add(value);
  try {
    if (Array.isArray(value)) {
      const raw: unknown[] = [];
      const redacted: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (state.remainingNodes === 0 || state.remainingCharacters === 0) {
          state.truncated = true;
          break;
        }
        const item = projectAgentLogValue(value[index], secrets, state, depth + 1);
        raw.push(item.raw);
        redacted.push(item.redacted);
      }
      return { raw, redacted };
    }

    const raw: Record<string, unknown> = {};
    const redacted: Record<string, unknown> = {};
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (state.remainingNodes === 0 || state.remainingCharacters === 0) {
        state.truncated = true;
        break;
      }
      const projectedKey = projectAgentLogString(key, secrets, state);
      const projectedValue = projectAgentLogValue(
        (value as Record<string, unknown>)[key],
        secrets,
        state,
        depth + 1,
      );
      raw[String(projectedKey.raw)] = projectedValue.raw;
      redacted[String(projectedKey.redacted)] = projectedValue.redacted;
    }
    return { raw, redacted };
  } finally {
    state.stack.delete(value);
  }
}

interface SerializedAgentLogValue {
  readonly serialized: string;
  readonly originalLength?: number;
}

function serializeAgentLogValue(
  value: unknown,
  secrets: readonly string[],
): SerializedAgentLogValue {
  if (typeof value === "string") {
    return {
      serialized: redactBoundedAgentLogString(value, secrets, MAX_AGENT_LOG_PROJECTION_CHARACTERS),
      originalLength: value.length,
    };
  }
  try {
    const state: AgentLogProjectionState = {
      remainingCharacters: MAX_AGENT_LOG_PROJECTION_CHARACTERS,
      remainingNodes: MAX_AGENT_LOG_PROJECTION_NODES,
      truncated: false,
      stack: new Set(),
    };
    const projection = projectAgentLogValue(value, secrets, state);
    const serialized = JSON.stringify(projection.redacted) as string | undefined;
    const redacted = redactAgentLog(serialized ?? String(projection.redacted), secrets);
    if (state.truncated) return { serialized: redacted };
    const raw = JSON.stringify(projection.raw) as string | undefined;
    return { serialized: redacted, originalLength: (raw ?? String(projection.raw)).length };
  } catch {
    return { serialized: "[unserializable value]", originalLength: 22 };
  }
}

export function boundedAgentLogValue(value: unknown, secrets: readonly string[]): string {
  const result = serializeAgentLogValue(value, secrets);
  const display = typeof value === "string" ? JSON.stringify(result.serialized) : result.serialized;
  const preview =
    display.length > MAX_AGENT_LOG_PREVIEW_LENGTH
      ? `${display.slice(0, MAX_AGENT_LOG_PREVIEW_LENGTH - 1)}…`
      : display;
  const length =
    result.originalLength === undefined ? "payload truncated" : `${result.originalLength} chars`;
  return `${preview} [${length}]`;
}

type AgentToolKind = "agent" | "mcp";

export interface AgentToolUse {
  readonly kind: AgentToolKind;
  readonly label: string;
}

export type AgentLogWriter = (line: string) => void;

export interface AgentLifecycleState {
  sessionId?: string;
  turnResults: number;
  latestTurnCount: number;
  apiRetries: number;
  goalIterations: number;
  compactionStarts: number;
  compactionSuccesses: number;
  compactionFailures: number;
  compactionBoundaries: number;
}

export function createAgentLifecycleState(): AgentLifecycleState {
  return {
    turnResults: 0,
    latestTurnCount: 0,
    apiRetries: 0,
    goalIterations: 0,
    compactionStarts: 0,
    compactionSuccesses: 0,
    compactionFailures: 0,
    compactionBoundaries: 0,
  };
}

function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

function isInternalReviewTool(label: string): boolean {
  return (
    label === "review_output.read_pr_conversation" ||
    label === "review_output.read_pr_diff" ||
    label === "review_output.read_context_file" ||
    label === "review_output.submit_review" ||
    label === "mcp__review_output__read_pr_conversation" ||
    label === "mcp__review_output__read_pr_diff" ||
    label === "mcp__review_output__read_context_file" ||
    label === "mcp__review_output__submit_review"
  );
}

function isContextFileTool(label: string): boolean {
  return (
    label === "review_output.read_context_file" || label === "mcp__review_output__read_context_file"
  );
}

function loggableToolOutput(label: string, output: unknown): unknown {
  if (!isContextFileTool(label)) return output;
  const isError = isRecord(output) && (output.is_error === true || output.isError === true);
  return {
    ...(isError ? { is_error: true } : {}),
    content: "[context file page omitted from logs]",
  };
}

export function agentLogLine(
  goalIndex: number,
  kind: string,
  label: string,
  field: string,
  value: unknown,
  secrets: readonly string[],
): string {
  return `[ai-pr-reviewer][goal ${goalIndex + 1}] ${kind}${label.length === 0 ? "" : ` ${label}`} ${field}: ${boundedAgentLogValue(value, secrets)}`;
}

export function writeCompleteAgentLog(
  goalIndex: number,
  kind: string,
  label: string,
  field: string,
  value: unknown,
  secrets: readonly string[],
  write: AgentLogWriter,
): void {
  const serialized = completeAgentLogValue(value, secrets);
  const chunks = chunkAgentLogValue(serialized);
  for (let index = 0; index < chunks.length; index += 1) {
    const part = chunks.length === 1 ? "" : ` part ${index + 1}/${chunks.length}`;
    write(
      `[ai-pr-reviewer][goal ${goalIndex + 1}] ${kind}${label.length === 0 ? "" : ` ${label}`} ${field}${part}: ${chunks[index]}`,
    );
  }
}

export function writeAgentLifecycleLog(
  goalIndex: number,
  event: string,
  value: unknown,
  secrets: readonly string[],
  write: AgentLogWriter = (line) => {
    core.info(line);
  },
): void {
  write(agentLogLine(goalIndex, "session", event, "details", value, secrets));
}

function userMessageText(message: SDKUserMessage): string | undefined {
  const content = message.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string")
      parts.push(block.text);
  }
  const text = parts.join("\n");
  return text.length > 0 ? text : undefined;
}

export function logQueuedUserMessage(
  message: SDKUserMessage,
  label: string,
  goalIndex: number,
  secrets: readonly string[],
  write: AgentLogWriter = (line) => {
    core.info(line);
  },
): void {
  const text = userMessageText(message);
  if (text !== undefined)
    writeCompleteAgentLog(goalIndex, "user message", label, "text", text, secrets, write);
}

export function logAgentEventSafely(
  goalIndex: number,
  secrets: readonly string[],
  log: (write: AgentLogWriter) => void,
  write: AgentLogWriter = (line) => {
    core.info(line);
  },
  warn: AgentLogWriter = (line) => {
    core.warning(line);
  },
): void {
  try {
    log(write);
  } catch (error) {
    try {
      warn(agentLogLine(goalIndex, "agent event log", "", "warning", errorMessage(error), secrets));
    } catch {
      // Logging is diagnostic and must not change the review result.
    }
  }
}

export function logAgentLifecycleMessage(
  message: SDKMessage | SDKActiveGoalMessage,
  goalIndex: number,
  secrets: readonly string[],
  state: AgentLifecycleState,
  write: AgentLogWriter = (line) => {
    core.info(line);
  },
): void {
  if (message.type === "active_goal") {
    if (message.value === null) {
      writeAgentLifecycleLog(
        goalIndex,
        "goal-cleared",
        { iterations: state.goalIterations },
        secrets,
        write,
      );
      return;
    }
    state.goalIterations = message.value.iterations;
    writeAgentLifecycleLog(goalIndex, "goal-iteration", message.value, secrets, write);
    return;
  }

  if (message.type === "result") {
    state.turnResults += 1;
    state.latestTurnCount = message.num_turns;
    writeAgentLifecycleLog(
      goalIndex,
      "turn-result",
      {
        result: state.turnResults,
        subtype: message.subtype,
        turns: message.num_turns,
        duration_ms: message.duration_ms,
        duration_api_ms: message.duration_api_ms,
        stop_reason: message.stop_reason,
        is_error: message.is_error,
      },
      secrets,
      write,
    );
    if (message.subtype !== "success" && message.errors.length > 0)
      write(agentLogLine(goalIndex, "session", "turn-result", "errors", message.errors, secrets));
    return;
  }

  if (message.type !== "system") return;
  if (message.subtype === "init") {
    state.sessionId = message.session_id;
    writeAgentLifecycleLog(
      goalIndex,
      "init",
      {
        session_id: message.session_id,
        model: message.model,
        claude_code_version: message.claude_code_version,
      },
      secrets,
      write,
    );
    return;
  }
  if (message.subtype === "api_retry") {
    state.apiRetries += 1;
    writeAgentLifecycleLog(
      goalIndex,
      "api-retry",
      {
        retry: state.apiRetries,
        attempt: message.attempt,
        max_retries: message.max_retries,
        retry_delay_ms: message.retry_delay_ms,
        error_status: message.error_status,
        error: message.error,
      },
      secrets,
      write,
    );
    return;
  }
  if (message.subtype === "status") {
    if (message.status === "compacting") {
      state.compactionStarts += 1;
      writeAgentLifecycleLog(
        goalIndex,
        "compaction-start",
        { attempt: state.compactionStarts },
        secrets,
        write,
      );
    }
    if (message.compact_result !== undefined) {
      if (message.compact_result === "success") state.compactionSuccesses += 1;
      else state.compactionFailures += 1;
      writeAgentLifecycleLog(
        goalIndex,
        "compaction-result",
        {
          result: message.compact_result,
          successes: state.compactionSuccesses,
          failures: state.compactionFailures,
        },
        secrets,
        write,
      );
      if (message.compact_error !== undefined)
        write(
          agentLogLine(
            goalIndex,
            "session",
            "compaction-result",
            "error",
            message.compact_error,
            secrets,
          ),
        );
    }
    return;
  }
  if (message.subtype === "compact_boundary") {
    state.compactionBoundaries += 1;
    writeAgentLifecycleLog(
      goalIndex,
      "compaction-boundary",
      {
        boundary: state.compactionBoundaries,
        ...message.compact_metadata,
      },
      secrets,
      write,
    );
  }
}

export function logAgentMessage(
  message: SDKMessage,
  goalIndex: number,
  secrets: readonly string[],
  toolUses: Map<string, AgentToolUse>,
  write: AgentLogWriter = (line) => {
    core.info(line);
  },
): void {
  if (message.type === "assistant") {
    const content = isRecord(message.message) ? message.message.content : undefined;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!isRecord(block) || typeof block.type !== "string") continue;
      if (block.type === "text" && typeof block.text === "string") {
        writeCompleteAgentLog(
          goalIndex,
          "assistant message",
          "",
          "text",
          block.text,
          secrets,
          write,
        );
        continue;
      }
      if (
        (block.type !== "tool_use" && block.type !== "mcp_tool_use") ||
        typeof block.id !== "string" ||
        typeof block.name !== "string"
      ) {
        continue;
      }
      const kind: AgentToolKind =
        block.type === "mcp_tool_use" || isMcpToolName(block.name) ? "mcp" : "agent";
      const label =
        block.type === "mcp_tool_use" && typeof block.server_name === "string"
          ? `${block.server_name}.${block.name}`
          : block.name;
      toolUses.set(block.id, { kind, label });
      write(
        agentLogLine(
          goalIndex,
          kind === "mcp" ? "MCP tool use" : "agent tool use",
          label,
          "input",
          block.input,
          secrets,
        ),
      );
    }
    return;
  }

  if (message.type !== "user") return;
  const content = isRecord(message.message) ? message.message.content : undefined;
  let loggedResult = false;
  if (Array.isArray(content)) {
    for (const block of content) {
      const blockType: string | undefined =
        isRecord(block) && typeof block.type === "string" ? block.type : undefined;
      if (
        !isRecord(block) ||
        (blockType !== "tool_result" && blockType !== "mcp_tool_result") ||
        typeof block.tool_use_id !== "string"
      ) {
        continue;
      }
      const toolUse = toolUses.get(block.tool_use_id);
      const kind: AgentToolKind =
        blockType === "mcp_tool_result" || toolUse?.kind === "mcp" ? "mcp" : "agent";
      const label = toolUse?.label ?? block.tool_use_id;
      const isError = block.is_error === true || block.isError === true;
      const output = loggableToolOutput(label, {
        ...(typeof block.is_error === "boolean" || typeof block.isError === "boolean"
          ? { is_error: isError }
          : {}),
        content: block.content,
      });
      if (isError && isInternalReviewTool(label)) {
        writeCompleteAgentLog(
          goalIndex,
          kind === "mcp" ? "MCP tool result" : "agent tool result",
          label,
          "output",
          output,
          secrets,
          write,
        );
      } else {
        write(
          agentLogLine(
            goalIndex,
            kind === "mcp" ? "MCP tool result" : "agent tool result",
            label,
            "output",
            output,
            secrets,
          ),
        );
      }
      loggedResult = true;
    }
  }
  if (!loggedResult && message.tool_use_result !== undefined) {
    const toolUse =
      typeof message.parent_tool_use_id === "string"
        ? toolUses.get(message.parent_tool_use_id)
        : undefined;
    const isError =
      isRecord(message.tool_use_result) &&
      (message.tool_use_result.isError === true || message.tool_use_result.is_error === true);
    const label = toolUse?.label ?? message.parent_tool_use_id ?? "unknown";
    if (isError && isInternalReviewTool(label)) {
      writeCompleteAgentLog(
        goalIndex,
        toolUse?.kind === "mcp" ? "MCP tool result" : "agent tool result",
        label,
        "output",
        loggableToolOutput(label, message.tool_use_result),
        secrets,
        write,
      );
    } else {
      write(
        agentLogLine(
          goalIndex,
          toolUse?.kind === "mcp" ? "MCP tool result" : "agent tool result",
          label,
          "output",
          loggableToolOutput(label, message.tool_use_result),
          secrets,
        ),
      );
    }
  }
}

export function logAgentMessageSafely(
  message: SDKMessage,
  goalIndex: number,
  secrets: readonly string[],
  toolUses: Map<string, AgentToolUse>,
  write: AgentLogWriter = (line) => {
    core.info(line);
  },
  warn: AgentLogWriter = (line) => {
    core.warning(line);
  },
): void {
  try {
    logAgentMessage(message, goalIndex, secrets, toolUses, write);
  } catch (error) {
    try {
      warn(agentLogLine(goalIndex, "agent event log", "", "warning", errorMessage(error), secrets));
    } catch {
      // Logging is diagnostic and must not change the review result.
    }
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function modelUsageSnapshot(value: unknown): readonly ReviewModelUsage[] | undefined {
  if (!isRecord(value)) return undefined;
  const models: ReviewModelUsage[] = [];
  for (const [model, rawUsage] of Object.entries(value)) {
    if (!isRecord(rawUsage)) return undefined;
    const inputTokens = rawUsage.inputTokens;
    const outputTokens = rawUsage.outputTokens;
    const cacheReadInputTokens = rawUsage.cacheReadInputTokens;
    const cacheCreationInputTokens = rawUsage.cacheCreationInputTokens;
    if (
      !isTokenCount(inputTokens) ||
      !isTokenCount(outputTokens) ||
      !isTokenCount(cacheReadInputTokens) ||
      !isTokenCount(cacheCreationInputTokens)
    ) {
      return undefined;
    }
    if (
      rawUsage.canonicalModel !== undefined &&
      (typeof rawUsage.canonicalModel !== "string" || rawUsage.canonicalModel.length === 0)
    ) {
      return undefined;
    }
    models.push({
      model,
      ...(rawUsage.canonicalModel === undefined ? {} : { canonicalModel: rawUsage.canonicalModel }),
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
    });
  }
  return models.sort(
    (left, right) =>
      left.model.localeCompare(right.model) ||
      (left.canonicalModel ?? "").localeCompare(right.canonicalModel ?? ""),
  );
}

export function withTokenUsage(
  result: Omit<GoalResult, "tokenUsage">,
  models: readonly ReviewModelUsage[],
  complete: boolean,
): GoalResult {
  return { ...result, tokenUsage: { models, complete } };
}
