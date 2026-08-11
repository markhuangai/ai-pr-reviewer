import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

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
const MAX_PROMPT_DIFF_LENGTH = 30_000;

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

async function allowsRepositoryPath(cwd: string, candidate: string): Promise<boolean> {
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
      return isWithinRepository(cwd, await realpath(resolve(cwd, parent)));
    } catch {
      return true;
    }
  }
  try {
    return isWithinRepository(cwd, await realpath(resolve(cwd, candidate)));
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
  const globPattern = input.tool_name === "Glob" ? toolInput.pattern : undefined;
  const globPath = typeof globPattern === "string" ? globPattern.replace(/^!/, "") : globPattern;
  const patternAllowed =
    globPattern === undefined ||
    (typeof globPath === "string" && (await allowsRepositoryPath(input.cwd, globPath)));
  if (
    !pathAllowed ||
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

function changedFilePrompt(files: readonly ChangedFile[]): string {
  let remainingPatchLength = MAX_PROMPT_DIFF_LENGTH;
  const entries = files.map((file) => {
    const patch =
      file.patch === undefined ? "(patch unavailable; inspect the checked-out file)" : file.patch;
    let patchExcerpt = patch;
    if (file.patch !== undefined) {
      if (remainingPatchLength <= 0) {
        patchExcerpt = "(patch excerpt omitted; inspect the checked-out file)";
      } else if (patch.length > remainingPatchLength) {
        patchExcerpt = `${patch.slice(0, remainingPatchLength)}\n(patch excerpt truncated; inspect the checked-out file)`;
        remainingPatchLength = 0;
      } else {
        remainingPatchLength -= patch.length;
      }
    }
    return `### ${file.path} [${file.status}]\n${patchExcerpt}`;
  });
  return entries.join("\n\n");
}

function buildGoalPrompt(
  goal: string,
  context: PullRequestContext,
  files: readonly ChangedFile[],
): string {
  return `You are an isolated pull-request reviewer. Treat the following instruction as your one review goal:

${goal}

Review pull request #${context.number} (${context.title}) at head ${context.headSha}. The checkout is the repository under the current working directory. The changed-file list and diff excerpts are below:

${changedFilePrompt(files)}

Read the relevant changed files and nearby definitions before deciding. This session is read-only: use only Read, Glob, Grep, the explicitly configured HTTP MCP tools, and the internal review output tool. Never use Bash, Edit, Write, NotebookEdit, WebFetch, WebSearch, Task, Agent, or project settings. Do not make assumptions about code that you did not inspect.

When finished, you MUST call mcp__review_output__submit_review exactly once. Submit only actionable, evidence-based findings. Use a changed-file path and an added-line number only when the line is present in the supplied pull-request diff; otherwise omit the location and explain the evidence in the body. Include an empty findings array when this goal found no actionable issue. Do not put markdown outside the tool call.`;
}

function repairPrompt(attempt: number): string {
  return `The previous turn did not produce an accepted review submission. This is repair attempt ${attempt} of ${MAX_REPAIR_ATTEMPTS}. Do not continue investigating. Call mcp__review_output__submit_review now with a schema-valid JSON object containing summary and findings. Use an empty findings array if no issue is supported by the evidence.`;
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
      "You are a security-conscious, read-only code reviewer. Every claim must be grounded in inspected repository content or an explicitly available MCP response. Never modify files, execute commands, access the web, or reveal credentials.",
  };
}

export async function runReviewGoal(
  goal: string,
  goalIndex: number,
  context: PullRequestContext,
  files: readonly ChangedFile[],
  config: ReviewConfig,
  cwd = process.env.GITHUB_WORKSPACE ?? process.cwd(),
): Promise<GoalResult> {
  let submission: GoalSubmission | undefined;
  let toolCallCount = 0;
  const outputTool = tool(
    "submit_review",
    "Submit the validated findings for this isolated review goal.",
    submissionSchema.shape,
    (input): Promise<CallToolResult> => {
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
      instructions: "Call submit_review exactly once when the review goal is complete.",
      tools: [outputTool],
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
    input.push(makeUserMessage(buildGoalPrompt(goal, context, files)));
    for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
      const result = await turn.promise;
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
      if (attempt < MAX_REPAIR_ATTEMPTS) input.push(makeUserMessage(repairPrompt(attempt + 1)));
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
  }
}

export async function runReviewGoals(
  context: PullRequestContext,
  files: readonly ChangedFile[],
  config: ReviewConfig,
): Promise<readonly GoalResult[]> {
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
      results[index] = await runReviewGoal(prompt, index, context, files, config);
    }
  };
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
}

export const agentInternals = {
  changedFilePrompt,
  isWithinRepository,
  makeUserMessage,
  repairPrompt,
};
