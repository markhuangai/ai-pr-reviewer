import { strict as assert } from "node:assert";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CodexOptions, ThreadEvent } from "@openai/codex-sdk";
import { z } from "zod";

import type { ReviewConfig } from "../src/lib/types.js";
import { codexMcpServerInternals, startCodexMcpServer } from "../src/runtime/codex-mcp-server.js";
import type { ReviewSessionInput, ReviewToolDefinition } from "../src/runtime/executor.js";
import {
  CodexReviewExecutor,
  codexExecutorInternals,
  type CodexClientLike,
  type CodexThreadLike,
} from "../src/runtime/executors/codex.js";

const tool: ReviewToolDefinition = {
  name: "echo",
  description: "Echo one value.",
  inputSchema: { value: z.string() },
  handler: ({ value }) => Promise.resolve({ content: [{ type: "text", text: String(value) }] }),
  alwaysLoad: true,
};

function config(overrides: Partial<ReviewConfig> = {}): ReviewConfig {
  return {
    githubToken: "github-secret",
    executor: "codex",
    aiSecret: "ai-secret",
    model: "gpt-review",
    effort: "max",
    reviewPrompts: [{ prompt: "correctness", files: [] }],
    parallelCount: 1,
    autoApprove: false,
    interactWithPullRequest: false,
    mcpServers: {},
    ...overrides,
  };
}

function turnEvents(usage: {
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly cacheWrite: number;
}): readonly ThreadEvent[] {
  return [
    { type: "turn.started" },
    {
      type: "item.completed",
      item: { id: "message", type: "agent_message", text: "done" },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: usage.input,
        output_tokens: usage.output,
        cached_input_tokens: usage.cached,
        cache_write_input_tokens: usage.cacheWrite,
        reasoning_output_tokens: 1,
      },
    },
  ];
}

function completedResponseStream(): string {
  const events = [
    { type: "response.created", response: { id: "response-1" } },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: "message-1",
        content: [{ type: "output_text", text: "done" }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "response-1",
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 1,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 2,
        },
      },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function fakeClient(
  turns: readonly (readonly ThreadEvent[])[],
  inspect: (options: Parameters<CodexClientLike["startThread"]>[0]) => void,
): CodexClientLike {
  let index = 0;
  const thread: CodexThreadLike = {
    runStreamed: (_input, options) => {
      const events = turns[index] ?? [];
      index += 1;
      return Promise.resolve({
        events: (async function* () {
          await Promise.resolve();
          for (const event of events) {
            if (options?.signal?.aborted) throw options.signal.reason;
            yield event;
          }
        })(),
      });
    },
  };
  return {
    startThread: (options) => {
      inspect(options);
      return thread;
    },
  };
}

async function sessionInput(root: string, reviewConfig: ReviewConfig): Promise<ReviewSessionInput> {
  const repository = join(root, "repository");
  await mkdir(repository, { recursive: true });
  return {
    config: reviewConfig,
    cwd: repository,
    goalIndex: 0,
    logSecrets: [reviewConfig.aiSecret],
    systemPrompt: "Host-owned review instructions.",
    outputServerName: "review_output",
    outputServerInstructions: "Call echo.",
    tools: [tool],
  };
}

test("serves authenticated review tools over real Streamable HTTP MCP", async (t) => {
  const server = await startCodexMcpServer([tool], "Call echo.");
  t.after(() => server.close());

  const unauthorized = await fetch(server.url);
  assert.equal(unauthorized.status, 401);
  const wrongToken = await fetch(server.url, {
    headers: { Authorization: `Bearer ${"x".repeat(server.token.length)}` },
  });
  assert.equal(wrongToken.status, 401);
  const forbiddenPath = await fetch(server.url.replace(/\/mcp$/u, "/other"), {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  assert.equal(forbiddenPath.status, 403);
  assert.equal(codexMcpServerInternals.authorized(undefined, server.token), false);
  assert.equal(codexMcpServerInternals.authorized(`Bearer ${server.token}`, server.token), true);

  for (const value of ["review", "repair"]) {
    const client = new Client({ name: `${value}-client`, version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: { headers: { Authorization: `Bearer ${server.token}` } },
    });
    await client.connect(transport as unknown as Transport);
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((candidate) => candidate.name),
      ["echo"],
    );
    const result = await client.callTool({ name: "echo", arguments: { value } });
    assert.deepEqual(result.content, [{ type: "text", text: value }]);
    await client.close();
  }
  assert.equal(server.failure(), undefined);
  await server.close();
  await server.close();
  await assert.rejects(
    startCodexMcpServer([tool, tool], "Duplicate tool."),
    /already registered/iu,
  );
});

test(
  "lets the real Codex SDK fall back from WebSockets to HTTP",
  { timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-codex-fallback-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const runnerTemp = join(root, "runner-temp");
    await mkdir(runnerTemp);
    const previousRunnerTemp = process.env.RUNNER_TEMP;
    process.env.RUNNER_TEMP = runnerTemp;
    t.after(() => {
      if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = previousRunnerTemp;
    });

    let websocketAttempts = 0;
    const requests: unknown[] = [];
    const serverErrors: Error[] = [];
    const server = createServer((request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404);
        response.end();
        return;
      }
      void (async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of request) {
          if (!(chunk instanceof Uint8Array)) {
            throw new TypeError("Codex request body contained a non-binary chunk.");
          }
          chunks.push(chunk);
        }
        requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
        });
        response.end(completedResponseStream());
      })().catch((error: unknown) => {
        serverErrors.push(error instanceof Error ? error : new Error(String(error)));
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    server.on("upgrade", (_request, socket) => {
      websocketAttempts += 1;
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        }),
    );
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");

    const reviewConfig = config({
      aiBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "auto",
    });
    const input = await sessionInput(root, reviewConfig);
    const executor = new CodexReviewExecutor();
    const session = await executor.createSession({ ...input, cwd: process.cwd() });
    t.after(() => session.close());

    assert.deepEqual(await session.runReview("ignored", "Reply with done.", () => undefined), {
      success: true,
    });
    assert.ok(websocketAttempts > 1);
    assert.equal(requests.length, 1);
    assert.equal((requests[0] as { readonly model?: unknown }).model, "auto");
    assert.deepEqual(serverErrors, []);
    assert.deepEqual(session.usage(), {
      complete: true,
      models: [
        {
          model: "auto",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      ],
    });
    await session.close();
  },
);

test("passes max through Codex config and sums incremental turn usage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-codex-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runnerTemp = join(root, "runner-temp");
  await mkdir(runnerTemp);
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  const previousInput = process.env.INPUT_PRIVATE_VALUE;
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.RUNNER_TEMP = runnerTemp;
  process.env.INPUT_PRIVATE_VALUE = "input-secret";
  process.env.GITHUB_TOKEN = "github-secret";
  process.env.OPENAI_API_KEY = "inherited-openai-secret";
  t.after(() => {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
    if (previousInput === undefined) delete process.env.INPUT_PRIVATE_VALUE;
    else process.env.INPUT_PRIVATE_VALUE = previousInput;
    if (previousGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGitHubToken;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
  });

  const reviewConfig = config({
    aiBaseUrl: "https://api.example.test/v1",
    mcpServers: {
      "security.audit": {
        type: "http",
        url: "https://mcp.example.test/review",
        headers: { "X.Trace": "header-secret" },
        tools: [{ name: "blocked", enabled: false }],
        timeout: 1_500,
        alwaysLoad: true,
      },
    },
  });
  let codexOptions: CodexOptions | undefined;
  let threadOptions: Parameters<CodexClientLike["startThread"]>[0];
  const prompts: string[] = [];
  const executor = new CodexReviewExecutor((options) => {
    codexOptions = options;
    const client = fakeClient(
      [
        turnEvents({ input: 10, output: 3, cached: 4, cacheWrite: 2 }),
        turnEvents({ input: 7, output: 2, cached: 1, cacheWrite: 0 }),
      ],
      (options) => {
        threadOptions = options;
      },
    );
    const thread = client.startThread.bind(client);
    client.startThread = (options) => {
      const created = thread(options);
      return {
        runStreamed: (prompt, runOptions) => {
          prompts.push(prompt);
          return created.runStreamed(prompt, runOptions);
        },
      };
    };
    return client;
  });
  const session = await executor.createSession(await sessionInput(root, reviewConfig));
  assert.ok(codexOptions);
  const home = codexOptions?.env?.CODEX_HOME;
  assert.ok(home);
  assert.equal(
    await readFile(join(home, "review-instructions.md"), "utf8"),
    reviewConfig.systemPrompt ?? "Host-owned review instructions.",
  );
  assert.equal(codexOptions?.baseUrl, undefined);
  assert.equal(codexOptions?.apiKey, "ai-secret");
  assert.equal(codexOptions?.env?.INPUT_PRIVATE_VALUE, undefined);
  assert.equal(codexOptions?.env?.GITHUB_TOKEN, undefined);
  assert.equal(codexOptions?.env?.OPENAI_API_KEY, undefined);
  assert.ok(Object.values(codexOptions?.env ?? {}).includes("header-secret"));

  const rootConfig = codexOptions?.config as Record<string, unknown>;
  assert.equal(rootConfig.model_reasoning_effort, "max");
  assert.equal(rootConfig.model_provider, "ai_pr_reviewer");
  assert.deepEqual((rootConfig.model_providers as Record<string, unknown>).ai_pr_reviewer, {
    name: "AI PR Reviewer custom endpoint",
    base_url: "https://api.example.test/v1",
    env_key: "CODEX_API_KEY",
    wire_api: "responses",
    supports_websockets: true,
  });
  assert.equal((rootConfig.features as Record<string, unknown>).shell_tool, false);
  assert.equal((rootConfig.features as Record<string, unknown>).multi_agent, false);
  assert.doesNotMatch(JSON.stringify(rootConfig), /header-secret/u);
  const mcpServers = rootConfig.mcp_servers as Record<string, Record<string, unknown>>;
  assert.equal(mcpServers.review_output?.bearer_token_env_var, "AI_PR_REVIEWER_INTERNAL_MCP_TOKEN");
  assert.equal(mcpServers['"security.audit"']?.required, true);
  assert.deepEqual(mcpServers['"security.audit"']?.disabled_tools, ["blocked"]);
  assert.equal(threadOptions?.sandboxMode, "read-only");
  assert.equal(threadOptions?.approvalPolicy, "never");
  assert.equal(threadOptions?.webSearchMode, "disabled");
  assert.equal(threadOptions?.modelReasoningEffort, undefined);

  let activated = false;
  assert.deepEqual(
    await session.runReview("/goal ignored", "review prompt", () => {
      activated = true;
    }),
    { success: true },
  );
  assert.equal(activated, true);
  assert.deepEqual(await session.runRepair("repair prompt"), { success: true });
  assert.deepEqual(prompts, ["review prompt", "repair prompt"]);
  assert.deepEqual(session.usage(), {
    complete: true,
    models: [
      {
        model: "gpt-review",
        inputTokens: 17,
        outputTokens: 5,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 2,
      },
    ],
  });
  assert.deepEqual(await session.configuredServerFailures(), []);
  await session.close();
  await assert.rejects(access(home), /ENOENT/u);
});

test("keeps the built-in Codex provider when no custom endpoint is configured", () => {
  assert.deepEqual(codexExecutorInternals.codexProviderConfig(undefined), {});
});

test("fails closed on command, file, web, and unconfigured MCP events", async (t) => {
  const eventCases: readonly [string, ThreadEvent, ReviewConfig?][] = [
    [
      "command execution",
      {
        type: "item.started",
        item: {
          id: "command",
          type: "command_execution",
          command: "env",
          aggregated_output: "",
          status: "in_progress",
        },
      },
    ],
    [
      "file change",
      {
        type: "item.completed",
        item: { id: "file", type: "file_change", changes: [], status: "completed" },
      },
    ],
    [
      "web search",
      {
        type: "item.completed",
        item: { id: "web", type: "web_search", query: "secret" },
      },
    ],
    [
      "unconfigured MCP tool unknown.read",
      {
        type: "item.started",
        item: {
          id: "mcp",
          type: "mcp_tool_call",
          server: "unknown",
          tool: "read",
          arguments: {},
          status: "in_progress",
        },
      },
    ],
    [
      "unconfigured MCP tool security.blocked",
      {
        type: "item.started",
        item: {
          id: "mcp-disabled",
          type: "mcp_tool_call",
          server: "security",
          tool: "blocked",
          arguments: {},
          status: "in_progress",
        },
      },
      config({
        mcpServers: {
          security: {
            type: "http",
            url: "https://mcp.example.test",
            tools: [{ name: "blocked", enabled: false }],
          },
        },
      }),
    ],
    [
      "unsupported thread item future_action",
      {
        type: "item.started",
        item: { id: "future", type: "future_action" },
      } as unknown as ThreadEvent,
    ],
  ];
  for (const [expected, event, reviewConfig = config()] of eventCases) {
    await t.test(expected, async () => {
      const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-codex-guard-test-"));
      const runnerTemp = join(root, "runner-temp");
      await mkdir(runnerTemp);
      const previousRunnerTemp = process.env.RUNNER_TEMP;
      process.env.RUNNER_TEMP = runnerTemp;
      try {
        const executor = new CodexReviewExecutor(() => fakeClient([[event]], () => undefined));
        const session = await executor.createSession(await sessionInput(root, reviewConfig));
        const result = await session.runReview("ignored", "review", () => undefined);
        assert.equal(result.success, false);
        assert.match(result.error ?? "", new RegExp(expected, "iu"));
        assert.equal(session.usage().complete, false);
        await session.close();
      } finally {
        if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
        else process.env.RUNNER_TEMP = previousRunnerTemp;
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("reports Codex terminal failures and MCP transport failures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-codex-terminal-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runnerTemp = join(root, "runner-temp");
  await mkdir(runnerTemp);
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = runnerTemp;
  t.after(() => {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
  });

  for (const [events, expected] of [
    [
      [
        { type: "error", message: "Reconnecting... 2/5" },
        { type: "turn.failed", error: { message: "provider failed" } },
      ],
      /provider failed/u,
    ],
    [[{ type: "error", message: "stream failed" }], /stream failed/u],
    [[], /without a completion event/u],
  ] as const) {
    const executor = new CodexReviewExecutor(() => fakeClient([events], () => undefined));
    const session = await executor.createSession(await sessionInput(root, config()));
    const result = await session.runReview("ignored", "review", () => undefined);
    assert.equal(result.success, false);
    assert.match(result.error ?? "", expected);
    await session.close();
  }

  const failedMcp: readonly ThreadEvent[] = [
    {
      type: "item.completed",
      item: {
        id: "mcp-failure",
        type: "mcp_tool_call",
        server: "review_output",
        tool: "echo",
        arguments: {},
        status: "failed",
        error: { message: "transport failed" },
      },
    },
    ...turnEvents({ input: 1, output: 1, cached: 0, cacheWrite: 0 }),
  ];
  const mcpExecutor = new CodexReviewExecutor(() => fakeClient([failedMcp], () => undefined));
  const mcpSession = await mcpExecutor.createSession(await sessionInput(root, config()));
  assert.equal((await mcpSession.runReview("ignored", "review", () => undefined)).success, true);
  assert.deepEqual(await mcpSession.configuredServerFailures(), [
    "review_output.echo: transport failed",
  ]);
  await mcpSession.close();
});

test("accepts non-actionable Codex items and marks invalid usage incomplete", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-codex-items-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runnerTemp = join(root, "runner-temp");
  await mkdir(runnerTemp);
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = runnerTemp;
  t.after(() => {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
  });
  const events: readonly ThreadEvent[] = [
    { type: "item.started", item: { id: "reason", type: "reasoning", text: "hidden" } },
    {
      type: "item.updated",
      item: { id: "todo", type: "todo_list", items: [{ text: "review", completed: true }] },
    },
    { type: "item.completed", item: { id: "notice", type: "error", message: "non-fatal" } },
    {
      type: "item.completed",
      item: {
        id: "mcp",
        type: "mcp_tool_call",
        server: "review_output",
        tool: "echo",
        arguments: { value: "ok" },
        status: "completed",
        result: { content: [], structured_content: {} },
      },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: -1,
        output_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 0,
      },
    },
  ];
  const executor = new CodexReviewExecutor(() => fakeClient([events], () => undefined));
  const session = await executor.createSession(await sessionInput(root, config()));
  assert.equal((await session.runReview("ignored", "review", () => undefined)).success, true);
  assert.equal(session.usage().complete, false);
  assert.deepEqual(await session.configuredServerFailures(), []);
  await session.close();
  await session.close();
});

test("rejects a Codex home inside the reviewed checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-codex-home-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = await sessionInput(root, config());
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = join(input.cwd, "temporary");
  try {
    await assert.rejects(
      new CodexReviewExecutor(() => fakeClient([], () => undefined)).createSession(input),
      /home directory must be outside/u,
    );
  } finally {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
  }
});

test("validates Codex usage and config key serialization boundaries", () => {
  assert.equal(codexExecutorInternals.configKeySegment("safe-name"), "safe-name");
  assert.equal(codexExecutorInternals.configKeySegment("security.audit"), '"security.audit"');
  assert.equal(
    codexExecutorInternals.checkedUsage({
      input_tokens: -1,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: 0,
    }),
    undefined,
  );
});
