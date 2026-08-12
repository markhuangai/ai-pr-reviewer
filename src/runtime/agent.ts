import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, realpath, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import * as core from "@actions/core";
import {
  createSdkMcpServer,
  query as sdkQuery,
  tool,
  type McpServerConfig,
  type Options,
  type HookCallback,
  type HookInput,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { reviewSecretCandidates } from "../lib/input.js";
import type {
  ChangedFile,
  GoalResult,
  GoalSubmission,
  HttpMcpServer,
  PullRequestContext,
  ReviewConfig,
  ReviewFinding,
} from "../lib/types.js";

const MAX_REPAIR_ATTEMPTS = 5;
const MAX_GOAL_CONDITION_LENGTH = 4_000;
const GOAL_CONDITION_PREFIX = "Complete the pull-request review goal: ";
const GOAL_CONDITION_SUFFIX = " [full goal is in the review prompt]";
const DIFF_PAGE_BYTES = 48 * 1024;
const MAX_GIT_STDERR_BYTES = 64 * 1024;
const MAX_AGENT_LOG_PREVIEW_LENGTH = 200;
const MAX_AGENT_LOG_PROJECTION_CHARACTERS = 1_024;
const MAX_AGENT_LOG_PROJECTION_NODES = 100;
const MAX_AGENT_LOG_PROJECTION_DEPTH = 8;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

const execFileAsync = promisify(execFile);

const findingSchema = z
  .object({
    title: z.string().min(1).max(200),
    severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]),
    body: z.string().min(1).max(8_000),
    path: z.string().min(1).max(500).optional(),
    line: z.number().int().min(1).max(1_000_000).optional(),
    endLine: z.number().int().min(1).max(1_000_000).optional(),
    confidence: z.enum(["high", "medium", "low"]).optional(),
  })
  .strict();

const submissionSchema = z
  .object({
    summary: z.string().max(10_000),
    findings: z.array(findingSchema).max(100),
  })
  .strict();

type SubmissionInput = z.infer<typeof submissionSchema>;

class PromptStream implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private finished = false;

  push(value: SDKUserMessage): void {
    if (this.finished) throw new Error("Cannot add input after the review session has finished.");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.queue.push(value);
  }

  finish(): void {
    this.finished = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ done: true, value: undefined });
  }

  async next(): Promise<IteratorResult<SDKUserMessage>> {
    const value = this.queue.shift();
    if (value) return { done: false, value };
    if (this.finished) return { done: true, value: undefined };
    return new Promise<IteratorResult<SDKUserMessage>>((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return this;
  }
}

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

function errorMessage(error: unknown): string {
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

function redactAgentLog(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => redactAgentLogSecret(result, secret), value);
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

function boundedAgentLogValue(value: unknown, secrets: readonly string[]): string {
  const result = serializeAgentLogValue(value, secrets);
  const redacted = result.serialized;
  const preview =
    redacted.length > MAX_AGENT_LOG_PREVIEW_LENGTH
      ? `${redacted.slice(0, MAX_AGENT_LOG_PREVIEW_LENGTH - 1)}…`
      : redacted;
  const display = typeof value === "string" ? JSON.stringify(preview) : preview;
  const length =
    result.originalLength === undefined ? "payload truncated" : `${result.originalLength} chars`;
  return `${display} [${length}]`;
}

type AgentToolKind = "agent" | "mcp";

interface AgentToolUse {
  readonly kind: AgentToolKind;
  readonly label: string;
}

type AgentLogWriter = (line: string) => void;

function isMcpToolName(name: string): boolean {
  return name.startsWith("mcp__");
}

function agentLogLine(
  goalIndex: number,
  kind: string,
  label: string,
  field: string,
  value: unknown,
  secrets: readonly string[],
): string {
  return `[ai-pr-reviewer][goal ${goalIndex + 1}] ${kind}${label.length === 0 ? "" : ` ${label}`} ${field}: ${boundedAgentLogValue(value, secrets)}`;
}

function logAgentMessage(
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
        write(agentLogLine(goalIndex, "assistant message", "", "text", block.text, secrets));
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
      const output = {
        ...(typeof block.is_error === "boolean" ? { is_error: block.is_error } : {}),
        content: block.content,
      };
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
      loggedResult = true;
    }
  }
  if (!loggedResult && message.tool_use_result !== undefined) {
    const toolUse =
      typeof message.parent_tool_use_id === "string"
        ? toolUses.get(message.parent_tool_use_id)
        : undefined;
    write(
      agentLogLine(
        goalIndex,
        toolUse?.kind === "mcp" ? "MCP tool result" : "agent tool result",
        toolUse?.label ?? message.parent_tool_use_id ?? "unknown",
        "output",
        message.tool_use_result,
        secrets,
      ),
    );
  }
}

function logAgentMessageSafely(
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWithinRepository(cwd: string, candidate: string): boolean {
  const root = resolve(cwd);
  const target = resolve(root, candidate);
  const relativePath = relative(root, target);
  return (
    relativePath.length === 0 ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith(sep))
  );
}

function isGitMetadataPath(candidate: string): boolean {
  return /(?:^|[\\/{,])\.git(?:$|[\\/},])/i.test(candidate);
}

function isSafeGlobPattern(pattern: string): boolean {
  const normalized = pattern.replace(/^!/, "");
  if (normalized.includes("..")) return false;
  let braceDepth = 0;
  for (const character of normalized) {
    if (character === "{") braceDepth += 1;
    if (character === "}") braceDepth -= 1;
    if (braceDepth < 0 || braceDepth > 1) return false;
  }
  if (braceDepth !== 0) return false;
  for (const match of normalized.matchAll(/\{([^{}]*)\}/g)) {
    for (const alternative of (match[1] ?? "").split(",")) {
      if (alternative.startsWith("/") || alternative.startsWith("\\")) return false;
      if (/^[A-Za-z]:[\\/]/.test(alternative)) return false;
    }
  }
  return true;
}

function isSafeGrepGlob(cwd: string, pathCandidate: unknown, pattern: string | undefined): boolean {
  const searchRoot =
    typeof pathCandidate !== "string" || resolve(cwd, pathCandidate) === resolve(cwd);
  if (pattern === undefined) return !searchRoot;
  const normalized = pattern.replace(/^!/, "");
  if (isGitMetadataPath(normalized)) return false;
  const firstSegment = normalized.split(/[\\/]/, 1)[0] ?? "";
  return (
    !searchRoot ||
    !["*", "?", "[", "]", "{", "}"].some((character) => firstSegment.includes(character))
  );
}

function isSafeResolvedPath(cwd: string, candidate: string): boolean {
  const root = resolve(cwd);
  const resolved = resolve(candidate);
  return isWithinRepository(cwd, resolved) && !isGitMetadataPath(relative(root, resolved));
}

async function allowsRepositoryPath(cwd: string, candidate: string): Promise<boolean> {
  if (isGitMetadataPath(candidate)) return false;
  if (!isWithinRepository(cwd, candidate)) return false;
  const wildcardIndex = ["*", "?", "[", "]", "{", "}", "!"]
    .map((character) => candidate.indexOf(character))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (wildcardIndex !== undefined) {
    const prefix = candidate.slice(0, wildcardIndex);
    const separatorIndex = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
    const parent = separatorIndex < 0 ? "." : prefix.slice(0, separatorIndex) || sep;
    try {
      return isSafeResolvedPath(cwd, await realpath(resolve(cwd, parent)));
    } catch {
      return true;
    }
  }
  try {
    return isSafeResolvedPath(cwd, await realpath(resolve(cwd, candidate)));
  } catch {
    return true;
  }
}

const repositoryReadHook: HookCallback = async (input: HookInput) => {
  if (input.hook_event_name !== "PreToolUse") return { continue: true };
  const toolInput = isRecord(input.tool_input) ? input.tool_input : undefined;
  if (!toolInput) return { continue: true };
  const pathCandidate = input.tool_name === "Read" ? toolInput.file_path : toolInput.path;
  const pathAllowed =
    pathCandidate === undefined ||
    (typeof pathCandidate === "string" && (await allowsRepositoryPath(input.cwd, pathCandidate)));
  const globPattern =
    input.tool_name === "Glob"
      ? toolInput.pattern
      : input.tool_name === "Grep"
        ? toolInput.glob
        : undefined;
  const globPath = typeof globPattern === "string" ? globPattern.replace(/^!/, "") : globPattern;
  const grepScopeAllowed =
    input.tool_name !== "Grep" ||
    isSafeGrepGlob(input.cwd, pathCandidate, typeof globPath === "string" ? globPath : undefined);
  const patternAllowed =
    globPattern === undefined ||
    (typeof globPath === "string" &&
      isSafeGlobPattern(globPath) &&
      (await allowsRepositoryPath(input.cwd, globPath)));
  if (
    !pathAllowed ||
    !grepScopeAllowed ||
    !patternAllowed ||
    (input.tool_name === "Glob" && typeof globPattern !== "string")
  ) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: "Read access is limited to the checked-out repository.",
      },
    };
  }
  return { continue: true };
};

function toSubmission(input: SubmissionInput): GoalSubmission {
  const findings: ReviewFinding[] = input.findings.map((finding) => ({
    title: finding.title,
    severity: finding.severity,
    body: finding.body,
    ...(finding.path === undefined ? {} : { path: finding.path }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.endLine === undefined ? {} : { endLine: finding.endLine }),
    ...(finding.confidence === undefined ? {} : { confidence: finding.confidence }),
  }));
  return { summary: input.summary, findings };
}

function safeAgentEnvironment(config: ReviewConfig): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("INPUT_")) Reflect.deleteProperty(environment, key);
  }
  for (const key of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "NODE_OPTIONS",
    "NODE_PATH",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_EXECUTABLE",
  ]) {
    Reflect.deleteProperty(environment, key);
  }
  environment.ANTHROPIC_BASE_URL = config.aiBaseUrl;
  if (config.aiAuthMode === "api-key") {
    environment.ANTHROPIC_API_KEY = config.aiSecret;
    delete environment.ANTHROPIC_AUTH_TOKEN;
  } else {
    environment.ANTHROPIC_AUTH_TOKEN = config.aiSecret;
    delete environment.ANTHROPIC_API_KEY;
  }
  environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  environment.CLAUDE_CODE_AUTO_COMPACT = "1";
  environment.CLAUDE_AGENT_SDK_CLIENT_APP = "ai-pr-reviewer/0.1";
  return environment;
}

function toSdkMcpServer(server: HttpMcpServer): McpServerConfig {
  return {
    type: "http",
    url: server.url,
    ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
    ...(server.tools === undefined ? {} : { tools: [...server.tools] }),
    ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
    ...(server.alwaysLoad === undefined ? {} : { alwaysLoad: server.alwaysLoad }),
  };
}

interface PullRequestDiffPage {
  readonly page: number;
  readonly content: string;
  readonly done: boolean;
}

class PullRequestDiffReader {
  private file: FileHandle | undefined;
  private offset = 0;
  private page = 0;
  private reachedEnd = false;
  private closed = false;
  private operation: Promise<void> = Promise.resolve();
  private readonly decoder = new StringDecoder("utf8");

  constructor(
    private readonly path: string,
    private readonly size: number,
  ) {}

  get complete(): boolean {
    return this.reachedEnd;
  }

  readNext(): Promise<PullRequestDiffPage> {
    const result = this.operation.then(() => this.readNextPage());
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    await this.operation;
    if (this.closed) return;
    this.closed = true;
    await this.file?.close();
    this.file = undefined;
  }

  private async readNextPage(): Promise<PullRequestDiffPage> {
    if (this.closed) throw new Error("Cannot read a closed pull request diff.");
    if (this.reachedEnd) return { page: this.page, content: "", done: true };
    this.file ??= await open(this.path, "r");
    this.page += 1;
    if (this.size === 0) {
      this.reachedEnd = true;
      return { page: this.page, content: this.decoder.end(), done: true };
    }
    const buffer = Buffer.allocUnsafe(Math.min(DIFF_PAGE_BYTES, this.size - this.offset));
    const { bytesRead } = await this.file.read(buffer, 0, buffer.length, this.offset);
    if (bytesRead === 0) {
      throw new Error("The pull request diff ended before its recorded size.");
    }
    this.offset += bytesRead;
    const done = this.offset === this.size;
    const content =
      this.decoder.write(buffer.subarray(0, bytesRead)) + (done ? this.decoder.end() : "");
    this.reachedEnd = done;
    return { page: this.page, content, done };
  }
}

class PullRequestDiffArtifact {
  constructor(
    readonly mergeBaseSha: string,
    readonly path: string,
    readonly size: number,
    private readonly directory: string,
  ) {}

  createReader(): PullRequestDiffReader {
    return new PullRequestDiffReader(this.path, this.size);
  }

  async cleanup(): Promise<void> {
    await rm(this.directory, { force: true, recursive: true });
  }
}

async function resolveCommit(cwd: string, sha: string, label: string): Promise<string> {
  if (!COMMIT_SHA_PATTERN.test(sha)) throw new Error(`${label} is not a full Git commit SHA.`);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${sha}^{commit}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_GIT_STDERR_BYTES,
    }));
  } catch (error) {
    throw new Error(
      `${label} is not available as a commit in the checkout: ${errorMessage(error)}`,
    );
  }
  const resolved = stdout.trim();
  if (!COMMIT_SHA_PATTERN.test(resolved) || resolved.toLowerCase() !== sha.toLowerCase()) {
    throw new Error(`${label} did not resolve to the exact requested commit.`);
  }
  return resolved;
}

async function resolveMergeBase(cwd: string, baseSha: string, headSha: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["merge-base", baseSha, headSha], {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_GIT_STDERR_BYTES,
    }));
  } catch (error) {
    throw new Error(`Could not resolve the pull request merge base: ${errorMessage(error)}`);
  }
  const mergeBase = stdout.trim();
  if (!COMMIT_SHA_PATTERN.test(mergeBase)) {
    throw new Error("Git returned an invalid pull request merge base.");
  }
  return mergeBase;
}

async function streamGitDiff(
  cwd: string,
  mergeBaseSha: string,
  headSha: string,
  path: string,
): Promise<void> {
  const child = spawn(
    "git",
    [
      `--attr-source=${mergeBaseSha}`,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--full-index",
      mergeBaseSha,
      headSha,
      "--",
    ],
    {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_GIT_STDERR_BYTES) return;
    const available = MAX_GIT_STDERR_BYTES - stderrBytes;
    const bounded = chunk.subarray(0, available);
    stderr.push(bounded);
    stderrBytes += bounded.length;
  });
  const exited = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("close", (code, signal) => {
      resolveExit({ code, signal });
    });
  });
  const streamed = pipeline(
    child.stdout,
    createWriteStream(path, { flags: "wx", mode: 0o600 }),
  ).catch((error: unknown) => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  });
  const [streamOutcome, exitOutcome] = await Promise.allSettled([streamed, exited]);
  const failures: string[] = [];
  if (streamOutcome.status === "rejected") failures.push(errorMessage(streamOutcome.reason));
  if (exitOutcome.status === "rejected") failures.push(errorMessage(exitOutcome.reason));
  else if (exitOutcome.value.code !== 0) {
    const details = Buffer.concat(stderr).toString("utf8").trim();
    const status =
      exitOutcome.value.signal === null
        ? `exit code ${String(exitOutcome.value.code)}`
        : `signal ${exitOutcome.value.signal}`;
    failures.push(`Git diff failed with ${status}${details.length === 0 ? "." : `: ${details}`}`);
  }
  if (failures.length > 0) throw new Error([...new Set(failures)].join("; "));
}

async function createPullRequestDiff(
  context: PullRequestContext,
  cwd: string,
  requestedTemporaryRoot = process.env.RUNNER_TEMP?.trim() || tmpdir(),
): Promise<PullRequestDiffArtifact> {
  const repositoryRoot = await realpath(cwd);
  const temporaryRoot = await realpath(resolve(requestedTemporaryRoot));
  if (isWithinRepository(repositoryRoot, temporaryRoot)) {
    throw new Error("The pull request diff temporary directory must be outside the checkout.");
  }
  const baseSha = await resolveCommit(repositoryRoot, context.baseSha, "Pull request base SHA");
  const headSha = await resolveCommit(repositoryRoot, context.headSha, "Pull request head SHA");
  const mergeBaseSha = await resolveMergeBase(repositoryRoot, baseSha, headSha);
  const directory = await mkdtemp(join(temporaryRoot, "ai-pr-reviewer-diff-"));
  const path = join(directory, "pull-request.diff");
  try {
    await streamGitDiff(repositoryRoot, mergeBaseSha, headSha, path);
    const { size } = await stat(path);
    return new PullRequestDiffArtifact(mergeBaseSha, path, size, directory);
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

function changedFilePrompt(files: readonly ChangedFile[]): string {
  if (files.length === 0) return "(GitHub reported no changed files.)";
  return files
    .map((file) => {
      const previousPath =
        file.previousPath === undefined
          ? ""
          : `; previousPath=${JSON.stringify(file.previousPath)}`;
      return `- path=${JSON.stringify(file.path)}; status=${JSON.stringify(file.status)}; additions=${file.additions}; deletions=${file.deletions}${previousPath}`;
    })
    .join("\n");
}

function goalCommand(goal: string): string {
  const normalized = goal.replace(/\s+/gu, " ").trim();
  const availableLength = MAX_GOAL_CONDITION_LENGTH - GOAL_CONDITION_PREFIX.length;
  const condition =
    normalized.length <= availableLength
      ? `${GOAL_CONDITION_PREFIX}${normalized}`
      : `${GOAL_CONDITION_PREFIX}${normalized
          .slice(0, availableLength - GOAL_CONDITION_SUFFIX.length)
          .trimEnd()}${GOAL_CONDITION_SUFFIX}`;
  return `/goal ${condition}`;
}

function buildGoalPrompt(
  goal: string,
  context: PullRequestContext,
  files: readonly ChangedFile[],
  mergeBaseSha: string,
): string {
  return `You are an isolated pull-request reviewer. Treat the following instruction as your one review goal:

${goal}

Review pull request #${context.number} (${context.title}) at head ${context.headSha}. The checkout is the repository under the current working directory. The pull request text diff is fenced from merge base ${mergeBaseSha} to head ${context.headSha}.

${changedFilePrompt(files)}

You MUST call mcp__review_output__read_pr_diff repeatedly until it returns done=true. Each call returns the next bounded page for this session; pages cannot be skipped and every goal receives the complete text diff. Binary file contents are intentionally excluded from review and must not produce a finding merely because their contents are unavailable.

Read the relevant changed files and nearby definitions before deciding. This session is read-only: use only Read, Glob, Grep, the explicitly configured HTTP MCP tools, and the internal review tools. Never use Bash, Edit, Write, NotebookEdit, WebFetch, WebSearch, Task, Agent, or project settings. Do not make assumptions about code that you did not inspect.

After reading the complete diff, call mcp__review_output__submit_review exactly once. Submit only actionable, evidence-based findings. Use a changed-file path and an added-line number only when the line is present in the supplied pull-request diff; otherwise omit the location and explain the evidence in the body. Include an empty findings array when this goal found no actionable issue. Do not put markdown outside the tool call.`;
}

function reviewSubmissionRejection(
  reviewPromptActive: boolean,
  diffComplete: boolean,
): string | undefined {
  if (!reviewPromptActive) return "Wait for the full review prompt before submitting.";
  if (!diffComplete)
    return "Review submission rejected. Read the pull request diff until done=true first.";
  return undefined;
}

function repairPrompt(attempt: number, diffComplete: boolean): string {
  const nextAction = diffComplete
    ? "Do not continue investigating. Call mcp__review_output__submit_review now"
    : "Continue calling mcp__review_output__read_pr_diff until it returns done=true, then call mcp__review_output__submit_review";
  return `The previous turn did not produce an accepted review submission. This is repair attempt ${attempt} of ${MAX_REPAIR_ATTEMPTS}. ${nextAction} with a schema-valid JSON object containing summary and findings. Use an empty findings array if no issue is supported by the evidence.`;
}

function makeUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "",
  };
}

function makeOptions(
  config: ReviewConfig,
  cwd: string,
  mcpServers: Record<string, McpServerConfig>,
  outputServerName: string,
): Options {
  const externalNames = Object.keys(config.mcpServers).map((name) => `mcp__${name}__*`);
  return {
    cwd,
    env: safeAgentEnvironment(config),
    model: config.model,
    maxTurns: config.maxTurns,
    tools: ["Read", "Glob", "Grep"],
    allowedTools: [
      "Read",
      "Glob",
      "Grep",
      `mcp__${outputServerName}__read_pr_diff`,
      `mcp__${outputServerName}__submit_review`,
      ...externalNames,
    ],
    disallowedTools: [
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Task",
      "Agent",
      "TodoWrite",
      "AskUserQuestion",
      "Skill",
    ],
    permissionMode: "dontAsk",
    settingSources: [],
    strictMcpConfig: true,
    mcpServers,
    hooks: {
      PreToolUse: [{ matcher: "^(Read|Glob|Grep)$", hooks: [repositoryReadHook] }],
    },
    persistSession: false,
    settings: { autoCompactEnabled: true, precomputeCompactionEnabled: true },
    systemPrompt:
      "You are a security-conscious, read-only code reviewer. Read the internal pull request diff to completion before submitting. Every claim must be grounded in inspected repository content or an explicitly available MCP response. Never modify files, execute commands, access the web, or reveal credentials.",
  };
}

export async function runReviewGoal(
  goal: string,
  goalIndex: number,
  context: PullRequestContext,
  files: readonly ChangedFile[],
  config: ReviewConfig,
  diff: PullRequestDiffArtifact,
  cwd = process.env.GITHUB_WORKSPACE ?? process.cwd(),
): Promise<GoalResult> {
  let submission: GoalSubmission | undefined;
  let reviewPromptActive = false;
  let toolCallCount = 0;
  const logSecrets = reviewSecretCandidates(config);
  const toolUses = new Map<string, AgentToolUse>();
  const diffReader = diff.createReader();
  const diffTool = tool(
    "read_pr_diff",
    "Read the next page of the immutable pull request text diff. Call repeatedly until done is true.",
    {},
    async (): Promise<CallToolResult> => {
      if (!reviewPromptActive) {
        return {
          content: [{ type: "text", text: "Wait for the full review prompt before reading." }],
        };
      }
      const page = await diffReader.readNext();
      return { content: [{ type: "text", text: JSON.stringify(page) }] };
    },
    { alwaysLoad: true },
  );
  const outputTool = tool(
    "submit_review",
    "Submit the validated findings for this isolated review goal.",
    submissionSchema.shape,
    (input): Promise<CallToolResult> => {
      const rejection = reviewSubmissionRejection(reviewPromptActive, diffReader.complete);
      if (rejection !== undefined) {
        return Promise.resolve({
          content: [{ type: "text", text: rejection }],
        });
      }
      toolCallCount += 1;
      if (toolCallCount === 1) submission = toSubmission(input);
      return Promise.resolve({ content: [{ type: "text", text: "Review submission accepted." }] });
    },
    { alwaysLoad: true },
  );
  const outputServerName = "review_output";
  const mcpServers: Record<string, McpServerConfig> = {
    [outputServerName]: createSdkMcpServer({
      name: outputServerName,
      version: "1.0.0",
      instructions:
        "Call read_pr_diff until done=true, then call submit_review exactly once when the review goal is complete.",
      tools: [diffTool, outputTool],
      alwaysLoad: true,
    }),
  };
  for (const [name, server] of Object.entries(config.mcpServers))
    mcpServers[name] = toSdkMcpServer(server);

  const input = new PromptStream();
  let turn = deferred<SDKResultMessage>();
  let readerFailure: Error | undefined;
  let reader: Promise<void> | undefined;
  try {
    const session = sdkQuery({
      prompt: input,
      options: makeOptions(config, cwd, mcpServers, outputServerName),
    });
    const configuredMcpNames = new Set(Object.keys(config.mcpServers));
    reader = (async () => {
      try {
        for await (const message of session as AsyncIterable<SDKMessage>) {
          logAgentMessageSafely(message, goalIndex, logSecrets, toolUses);
          if (message.type === "result") {
            const completedTurn = turn;
            turn = deferred<SDKResultMessage>();
            completedTurn.resolve(message);
          }
        }
      } catch (error) {
        readerFailure = error instanceof Error ? error : new Error(errorMessage(error));
        turn.reject(readerFailure);
      }
    })();
    input.push(makeUserMessage(goalCommand(goal)));
    input.push(makeUserMessage(buildGoalPrompt(goal, context, files, diff.mergeBaseSha)));
    let repairAttempts = 0;
    for (let turnIndex = 0; turnIndex <= MAX_REPAIR_ATTEMPTS + 1; turnIndex += 1) {
      const result = await turn.promise;
      if (!reviewPromptActive) {
        if (result.subtype !== "success") {
          input.finish();
          await reader;
          return {
            prompt: goal,
            status: "failed",
            error: result.errors.join("; ") || `Claude returned ${result.subtype}.`,
          };
        }
        reviewPromptActive = true;
        continue;
      }
      if (submission !== undefined) {
        const mcpFailures = (await session.mcpServerStatus()).filter(
          (status) =>
            configuredMcpNames.has(status.name) &&
            (status.status === "failed" || status.status === "needs-auth"),
        );
        input.finish();
        await reader;
        if (mcpFailures.length > 0) {
          return {
            prompt: goal,
            status: "failed",
            submission,
            error: `Configured MCP server failure: ${mcpFailures.map((status) => `${status.name}: ${status.error ?? status.status}`).join("; ")}`,
          };
        }
        return {
          prompt: goal,
          status: "completed",
          submission,
        };
      }
      if (result.subtype !== "success") {
        input.finish();
        await reader;
        return {
          prompt: goal,
          status: "failed",
          error: result.errors.join("; ") || `Claude returned ${result.subtype}.`,
        };
      }
      if (repairAttempts >= MAX_REPAIR_ATTEMPTS) {
        input.finish();
        await reader;
        return {
          prompt: goal,
          status: "failed",
          error: "Claude did not submit a valid review after five repair attempts.",
        };
      }
      repairAttempts += 1;
      input.push(makeUserMessage(repairPrompt(repairAttempts, diffReader.complete)));
    }
    input.finish();
    await reader;
    return {
      prompt: goal,
      status: "failed",
      error: "Claude did not submit a valid review after five repair attempts.",
    };
  } catch (error) {
    input.finish();
    if (reader) await reader.catch(() => undefined);
    return { prompt: goal, status: "failed", error: readerFailure?.message ?? errorMessage(error) };
  } finally {
    await diffReader.close();
  }
}

export async function runReviewGoals(
  context: PullRequestContext,
  files: readonly ChangedFile[],
  config: ReviewConfig,
  cwd = process.env.GITHUB_WORKSPACE ?? process.cwd(),
): Promise<readonly GoalResult[]> {
  const diff = await createPullRequestDiff(context, cwd);
  const results: Array<GoalResult | undefined> = Array.from(
    { length: config.reviewPrompts.length },
    () => undefined,
  );
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < config.reviewPrompts.length) {
      const index = cursor;
      cursor += 1;
      const prompt = config.reviewPrompts[index];
      if (prompt === undefined) return;
      results[index] = await runReviewGoal(prompt, index, context, files, config, diff, cwd);
    }
  };
  try {
    const workerCount = Math.min(config.parallelCount, config.reviewPrompts.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results.map(
      (result, index) =>
        result ?? {
          prompt: config.reviewPrompts[index] ?? "",
          status: "failed",
          error: "Worker did not return a result.",
        },
    );
  } finally {
    await diff.cleanup();
  }
}

export const agentInternals = {
  boundedAgentLogValue,
  changedFilePrompt,
  createPullRequestDiff,
  goalCommand,
  logAgentMessage,
  logAgentMessageSafely,
  PullRequestDiffReader,
  redactAgentLog,
  reviewSubmissionRejection,
  resolveCommit,
  resolveMergeBase,
  isSafeGlobPattern,
  isSafeGrepGlob,
  isGitMetadataPath,
  isSafeResolvedPath,
  isWithinRepository,
  makeUserMessage,
  repairPrompt,
};
