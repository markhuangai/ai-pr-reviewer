import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";

import { throwIfAborted } from "../../lib/bootstrap/cancellation.js";
import type { HttpMcpServer, ReviewConfig, ReviewModelUsage } from "../../lib/types.js";
import {
  agentLogLine,
  errorMessage,
  logAgentEventSafely,
  writeAgentLifecycleLog,
  writeCompleteAgentLog,
} from "../agent-logging.js";
import { startCodexMcpServer, type CodexMcpServer } from "../codex-mcp-server.js";
import {
  effectiveExecutorFingerprint,
  type ReviewExecutor,
  type ReviewSession,
  type ReviewSessionInput,
  type ReviewTurnResult,
} from "../executor.js";

type CodexConfigValue = string | number | boolean | CodexConfigValue[] | CodexConfigObject;
interface CodexConfigObject {
  [key: string]: CodexConfigValue;
}

export interface CodexThreadLike {
  runStreamed(
    input: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly events: AsyncIterable<ThreadEvent> }>;
}

export interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
}

export type CodexClientFactory = (options: CodexOptions) => CodexClientLike;

interface CodexMcpConfiguration {
  readonly servers: CodexConfigObject;
  readonly environment: Readonly<Record<string, string>>;
}

function configKeySegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(value) ? value : JSON.stringify(value);
}

function externalMcpConfiguration(
  servers: Readonly<Record<string, HttpMcpServer>>,
): CodexMcpConfiguration {
  const configured: CodexConfigObject = {};
  const environment: Record<string, string> = {};
  let serverIndex = 0;
  for (const [name, server] of Object.entries(servers)) {
    const envHttpHeaders: CodexConfigObject = {};
    let headerIndex = 0;
    for (const [header, value] of Object.entries(server.headers ?? {})) {
      const environmentVariable = `AI_PR_REVIEWER_MCP_HEADER_${serverIndex}_${headerIndex}`;
      environment[environmentVariable] = value;
      envHttpHeaders[configKeySegment(header)] = environmentVariable;
      headerIndex += 1;
    }
    const disabledTools = server.tools
      ?.filter((candidate) => candidate.enabled === false)
      .map((candidate) => candidate.name);
    configured[configKeySegment(name)] = {
      url: server.url,
      enabled: true,
      required: server.alwaysLoad ?? false,
      default_tools_approval_mode: "approve",
      ...(server.timeout === undefined
        ? {}
        : { tool_timeout_sec: Math.max(1, Math.ceil(server.timeout / 1_000)) }),
      ...(Object.keys(envHttpHeaders).length === 0 ? {} : { env_http_headers: envHttpHeaders }),
      ...(disabledTools === undefined || disabledTools.length === 0
        ? {}
        : { disabled_tools: disabledTools }),
    };
    serverIndex += 1;
  }
  return { servers: configured, environment };
}

function safeCodexEnvironment(
  codexHome: string,
  cwd: string,
  additions: Readonly<Record<string, string>>,
): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[key] = value;
  }
  for (const key of Object.keys(environment)) {
    if (key.startsWith("INPUT_") || key.startsWith("AI_PR_REVIEWER_MCP_HEADER_")) {
      Reflect.deleteProperty(environment, key);
    }
  }
  for (const key of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_HOME",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "NODE_OPTIONS",
    "NODE_PATH",
  ]) {
    Reflect.deleteProperty(environment, key);
  }
  Object.assign(environment, additions);
  environment.CODEX_HOME = codexHome;
  environment.GITHUB_WORKSPACE = cwd;
  return environment;
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function createCodexHome(
  cwd: string,
  systemPrompt: string,
): Promise<{
  readonly path: string;
  readonly instructions: string;
}> {
  const requestedTemporaryRoot = process.env.RUNNER_TEMP?.trim() || tmpdir();
  await mkdir(requestedTemporaryRoot, { recursive: true });
  const [repositoryRoot, temporaryRoot] = await Promise.all([
    realpath(cwd),
    realpath(requestedTemporaryRoot),
  ]);
  if (isWithin(repositoryRoot, temporaryRoot)) {
    throw new Error("The Codex home directory must be outside the reviewed checkout.");
  }
  const path = await mkdtemp(join(temporaryRoot, "ai-pr-reviewer-codex-"));
  const instructions = join(path, "review-instructions.md");
  try {
    await writeFile(instructions, systemPrompt, { encoding: "utf8", mode: 0o600 });
    return { path, instructions };
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
}

function codexConfig(
  config: ReviewConfig,
  instructionsFile: string,
  internalServer: CodexMcpServer,
  external: CodexMcpConfiguration,
  toolNames: readonly string[],
): CodexConfigObject {
  return {
    model_instructions_file: instructionsFile,
    project_doc_max_bytes: 0,
    project_doc_fallback_filenames: [],
    history: { persistence: "none" },
    approval_policy: "never",
    sandbox_mode: "read-only",
    allow_login_shell: false,
    shell_environment_policy: { inherit: "none" },
    web_search: "disabled",
    tools: { web_search: false, view_image: false },
    apps: { _default: { enabled: false } },
    memories: { use_memories: false, generate_memories: false },
    features: {
      shell_tool: false,
      unified_exec: false,
      shell_snapshot: false,
      multi_agent: false,
      goals: false,
      apps: false,
      hooks: false,
      memories: false,
      plugins: false,
      remote_plugin: false,
      recommended_plugins: false,
      skill_search: false,
      skill_mcp_dependency_install: false,
      view_image: false,
      image_generation: false,
      browser_use: false,
      browser_use_external: false,
      computer_use: false,
      tool_suggest: false,
    },
    ...(config.effort === undefined ? {} : { model_reasoning_effort: config.effort }),
    mcp_servers: {
      [configKeySegment("review_output")]: {
        url: internalServer.url,
        bearer_token_env_var: internalServer.tokenEnvironmentVariable,
        enabled: true,
        required: true,
        enabled_tools: [...toolNames],
        default_tools_approval_mode: "approve",
        startup_timeout_sec: 10,
        tool_timeout_sec: 60,
      },
      ...external.servers,
    },
  };
}

function checkedUsage(value: Usage): Usage | undefined {
  const counts = [
    value.input_tokens,
    value.cached_input_tokens,
    value.cache_write_input_tokens,
    value.output_tokens,
    value.reasoning_output_tokens,
  ];
  return counts.every((count) => Number.isSafeInteger(count) && count >= 0) ? value : undefined;
}

class CodexReviewSession implements ReviewSession {
  private readonly thread: CodexThreadLike;
  private readonly toolPolicies = new Map<
    string,
    { readonly allow?: ReadonlySet<string>; readonly deny: ReadonlySet<string> }
  >();
  private readonly mcpFailures = new Set<string>();
  private tokenCounts = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
  private usageComplete = true;
  private completedTurns = 0;
  private repairAttempts = 0;
  private toolsActive = false;
  private closed = false;

  constructor(
    private readonly sessionInput: ReviewSessionInput,
    private readonly codexHome: string,
    private readonly internalServer: CodexMcpServer,
    client: CodexClientLike,
  ) {
    this.toolPolicies.set(sessionInput.outputServerName, {
      allow: new Set(sessionInput.tools.map((candidate) => candidate.name)),
      deny: new Set(),
    });
    for (const [name, server] of Object.entries(sessionInput.config.mcpServers)) {
      const disabled = new Set(
        server.tools
          ?.filter((candidate) => candidate.enabled === false)
          .map((candidate) => candidate.name) ?? [],
      );
      this.toolPolicies.set(name, { deny: disabled });
    }
    this.thread = client.startThread({
      model: sessionInput.config.model,
      sandboxMode: "read-only",
      workingDirectory: sessionInput.cwd,
      webSearchMode: "disabled",
      approvalPolicy: "never",
    });
    logAgentEventSafely(sessionInput.goalIndex, sessionInput.logSecrets, (write) => {
      writeAgentLifecycleLog(
        sessionInput.goalIndex,
        "start",
        { executor: "codex", prompt_gate: "closed" },
        sessionInput.logSecrets,
        write,
      );
      writeCompleteAgentLog(
        sessionInput.goalIndex,
        "system message",
        "review",
        "text",
        sessionInput.systemPrompt,
        sessionInput.logSecrets,
        write,
      );
    });
  }

  private actionableToolError(event: ThreadEvent): string | undefined {
    if (
      event.type !== "item.started" &&
      event.type !== "item.updated" &&
      event.type !== "item.completed"
    ) {
      return undefined;
    }
    const item = event.item;
    const itemType: string = item.type;
    if (
      itemType === "command_execution" ||
      itemType === "file_change" ||
      itemType === "web_search"
    ) {
      return `Codex attempted disabled ${itemType.replaceAll("_", " ")}.`;
    }
    if (
      itemType === "agent_message" ||
      itemType === "reasoning" ||
      itemType === "todo_list" ||
      itemType === "error"
    ) {
      return undefined;
    }
    if (itemType !== "mcp_tool_call") {
      return `Codex emitted unsupported thread item ${itemType}.`;
    }
    const mcpItem = item as Extract<typeof item, { readonly type: "mcp_tool_call" }>;
    const policy = this.toolPolicies.get(mcpItem.server);
    if (
      policy === undefined ||
      policy.deny.has(mcpItem.tool) ||
      (policy.allow !== undefined && !policy.allow.has(mcpItem.tool))
    ) {
      return `Codex attempted unconfigured MCP tool ${mcpItem.server}.${mcpItem.tool}.`;
    }
    if (mcpItem.status === "failed") {
      this.mcpFailures.add(
        `${mcpItem.server}.${mcpItem.tool}: ${mcpItem.error?.message ?? "failed"}`,
      );
    }
    return undefined;
  }

  private logEvent(event: ThreadEvent): void {
    const { goalIndex, logSecrets } = this.sessionInput;
    logAgentEventSafely(goalIndex, logSecrets, (write) => {
      if (event.type === "item.completed" && event.item.type === "agent_message") {
        writeCompleteAgentLog(
          goalIndex,
          "assistant message",
          "review",
          "text",
          event.item.text,
          logSecrets,
          write,
        );
        return;
      }
      if (
        (event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed") &&
        event.item.type === "reasoning"
      ) {
        return;
      }
      const value =
        (event.type === "item.started" ||
          event.type === "item.updated" ||
          event.type === "item.completed") &&
        event.item.type === "mcp_tool_call"
          ? {
              type: event.type,
              server: event.item.server,
              tool: event.item.tool,
              status: event.item.status,
              ...(event.item.error === undefined ? {} : { error: event.item.error.message }),
            }
          : event;
      write(agentLogLine(goalIndex, "codex event", event.type, "details", value, logSecrets));
    });
  }

  private addUsage(usage: Usage): void {
    const checked = checkedUsage(usage);
    if (checked === undefined) {
      this.usageComplete = false;
      return;
    }
    this.tokenCounts = {
      inputTokens: this.tokenCounts.inputTokens + checked.input_tokens,
      outputTokens: this.tokenCounts.outputTokens + checked.output_tokens,
      cacheReadInputTokens: this.tokenCounts.cacheReadInputTokens + checked.cached_input_tokens,
      cacheCreationInputTokens:
        this.tokenCounts.cacheCreationInputTokens + checked.cache_write_input_tokens,
    };
  }

  private async run(prompt: string): Promise<ReviewTurnResult> {
    const signal = this.sessionInput.abortController?.signal;
    throwIfAborted(signal);
    const turnController = new AbortController();
    const abort = (): void => {
      turnController.abort(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    let completed = false;
    try {
      const { events } = await this.thread.runStreamed(prompt, { signal: turnController.signal });
      for await (const event of events) {
        this.logEvent(event);
        const toolError = this.actionableToolError(event);
        if (toolError !== undefined) {
          const error = new Error(toolError);
          turnController.abort(error);
          this.usageComplete = false;
          return { success: false, error: toolError };
        }
        if (event.type === "turn.failed") {
          this.usageComplete = false;
          return { success: false, error: event.error.message };
        }
        if (event.type === "error") {
          this.usageComplete = false;
          return { success: false, error: event.message };
        }
        if (event.type === "turn.completed") {
          completed = true;
          this.completedTurns += 1;
          this.addUsage(event.usage);
        }
      }
      if (!completed) {
        this.usageComplete = false;
        return { success: false, error: "Codex ended the turn without a completion event." };
      }
      return { success: true };
    } catch (error) {
      throwIfAborted(signal);
      this.usageComplete = false;
      return { success: false, error: errorMessage(error) };
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  runReview(
    _goalCommand: string,
    reviewPrompt: string,
    activateTools: () => void,
  ): Promise<ReviewTurnResult> {
    activateTools();
    this.toolsActive = true;
    const { goalIndex, logSecrets } = this.sessionInput;
    logAgentEventSafely(goalIndex, logSecrets, (write) => {
      writeCompleteAgentLog(
        goalIndex,
        "user message",
        "review",
        "text",
        reviewPrompt,
        logSecrets,
        write,
      );
      writeAgentLifecycleLog(
        goalIndex,
        "prompt-gate-open",
        { queued_messages: 1, executor: "codex" },
        logSecrets,
        write,
      );
    });
    return this.run(reviewPrompt);
  }

  runRepair(prompt: string): Promise<ReviewTurnResult> {
    this.repairAttempts += 1;
    const { goalIndex, logSecrets } = this.sessionInput;
    logAgentEventSafely(goalIndex, logSecrets, (write) => {
      writeCompleteAgentLog(
        goalIndex,
        "user message",
        `repair-${this.repairAttempts}`,
        "text",
        prompt,
        logSecrets,
        write,
      );
    });
    return this.run(prompt);
  }

  configuredServerFailures(): Promise<readonly string[]> {
    const internalFailure = this.internalServer.failure();
    return Promise.resolve([
      ...(internalFailure === undefined ? [] : [`review_output: ${internalFailure.message}`]),
      ...this.mcpFailures,
    ]);
  }

  usage(): { readonly models: readonly ReviewModelUsage[]; readonly complete: boolean } {
    return {
      models:
        this.completedTurns === 0
          ? []
          : [{ model: this.sessionInput.config.model, ...this.tokenCounts }],
      complete: this.completedTurns > 0 && this.usageComplete,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const outcomes = await Promise.allSettled([
      this.internalServer.close(),
      rm(this.codexHome, { recursive: true, force: true }),
    ]);
    const { goalIndex, logSecrets } = this.sessionInput;
    logAgentEventSafely(goalIndex, logSecrets, (write) => {
      writeAgentLifecycleLog(
        goalIndex,
        "end",
        {
          executor: "codex",
          prompt_gate: this.toolsActive ? "open" : "closed",
          turn_results: this.completedTurns,
          repair_attempts: this.repairAttempts,
        },
        logSecrets,
        write,
      );
    });
    const failure = outcomes.find(
      (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
  }
}

export class CodexReviewExecutor implements ReviewExecutor {
  readonly name = "codex" as const;
  readonly capabilities = {
    goalCommand: false,
    maxTurns: false,
    inProcessMcp: false,
  } as const;

  constructor(
    private readonly clientFactory: CodexClientFactory = (options) => new Codex(options),
  ) {}

  effectiveFingerprint(config: ReviewConfig): unknown {
    return effectiveExecutorFingerprint(config);
  }

  async createSession(input: ReviewSessionInput): Promise<ReviewSession> {
    const signal = input.abortController?.signal;
    throwIfAborted(signal);
    const home = await createCodexHome(input.cwd, input.systemPrompt);
    let server: CodexMcpServer | undefined;
    try {
      server = await startCodexMcpServer(input.tools, input.outputServerInstructions);
      throwIfAborted(signal);
      const external = externalMcpConfiguration(input.config.mcpServers);
      const environment = safeCodexEnvironment(home.path, input.cwd, {
        ...external.environment,
        [server.tokenEnvironmentVariable]: server.token,
      });
      const client = this.clientFactory({
        ...(input.config.aiBaseUrl === undefined ? {} : { baseUrl: input.config.aiBaseUrl }),
        apiKey: input.config.aiSecret,
        env: environment,
        config: codexConfig(
          input.config,
          home.instructions,
          server,
          external,
          input.tools.map((tool) => tool.name),
        ),
      });
      return new CodexReviewSession(input, home.path, server, client);
    } catch (error) {
      const cleanup = await Promise.allSettled([
        server?.close(),
        rm(home.path, { recursive: true, force: true }),
      ]);
      const cleanupFailures: unknown[] = [];
      for (const outcome of cleanup) {
        if (outcome.status === "rejected") cleanupFailures.push(outcome.reason as unknown);
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "Codex session startup and cleanup failed.",
          { cause: error },
        );
      }
      throw error;
    }
  }
}

export const codexExecutorInternals = {
  checkedUsage,
  codexConfig,
  configKeySegment,
  createCodexHome,
  externalMcpConfiguration,
  safeCodexEnvironment,
};
