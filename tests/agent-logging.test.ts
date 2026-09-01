import {
  agentInternals,
  assert,
  test,
  type PullRequestContext,
  type SDKActiveGoalMessage,
  type SDKMessage,
  type SDKUserMessage,
} from "./agent-test-helpers.js";

test("logs assistant, agent-tool, and MCP events with bounded redacted payloads", () => {
  const secret = "mcp-header-secret";
  const longInput = `${secret}-${"x".repeat(260)}`;
  const messages: SDKMessage[] = [
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I will inspect the changed files." },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/index.ts" } },
          {
            type: "mcp_tool_use",
            id: "tool-2",
            name: "lookup",
            server_name: "security",
            input: { query: longInput },
          },
        ],
      },
    } as unknown as SDKMessage,
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "Read output",
          },
          {
            type: "tool_result",
            tool_use_id: "tool-2",
            content: [{ type: "text", text: longInput }],
            is_error: true,
          },
        ],
      },
    } as unknown as SDKMessage,
  ];
  const lines: string[] = [];
  const toolUses = new Map<string, { readonly kind: "agent" | "mcp"; readonly label: string }>();
  for (const message of messages)
    agentInternals.logAgentMessage(message, 1, [secret], toolUses, (line) => lines.push(line));

  assert.equal(lines.length, 5);
  assert.match(lines[0] ?? "", /assistant message text: "I will inspect/u);
  assert.match(lines[1] ?? "", /agent tool use Read input: \{"file_path":"src\/index\.ts"\}/u);
  assert.match(lines[2] ?? "", /MCP tool use security\.lookup input:/u);
  assert.match(lines[3] ?? "", /agent tool result Read output:/u);
  assert.match(lines[4] ?? "", /MCP tool result security\.lookup output:/u);
  assert.equal(
    lines.every((line) => !line.includes(secret)),
    true,
  );
  assert.match(lines[2] ?? "", /\[\d+ chars\]/u);
  const preview = lines[2]?.match(/input: (.+) \[\d+ chars\]$/u)?.[1];
  assert.ok(preview);
  assert.ok(preview.length <= 202);
  assert.match(lines[4] ?? "", /"is_error":true/u);
  assert.match(lines[4] ?? "", /\[333 chars\]$/u);
  assert.equal((lines[4] ?? "").includes("x".repeat(260)), false);
});

test("never writes context file page contents to the action log", () => {
  const fileContent = "PRIVATE WORKFLOW CONTEXT";
  const path = "/runner/context/ticket.json";
  const toolUses = new Map<string, { readonly kind: "agent" | "mcp"; readonly label: string }>();
  const lines: string[] = [];
  const messages: SDKMessage[] = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "mcp_tool_use",
            id: "context-1",
            name: "read_context_file",
            server_name: "review_output",
            input: { path },
          },
        ],
      },
    } as unknown as SDKMessage,
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "mcp_tool_result",
            tool_use_id: "context-1",
            is_error: true,
            content: [
              {
                type: "text",
                text: JSON.stringify({ path, page: 1, content: fileContent, done: true }),
              },
            ],
          },
        ],
      },
    } as unknown as SDKMessage,
  ];
  for (const message of messages) {
    agentInternals.logAgentMessage(message, 0, [], toolUses, (line) => lines.push(line));
  }
  assert.equal(lines.length, 2);
  assert.equal((lines[0] ?? "").includes(path), true);
  assert.match(lines[1] ?? "", /context file page omitted from logs/u);
  assert.match(lines[1] ?? "", /"is_error":true/u);
  assert.equal(lines.join("\n").includes(fileContent), false);
});

test("logs complete redacted user and assistant messages in reconstructable chunks", () => {
  const secret = "conversation-secret";
  const text = `before-${secret}-${"🙂".repeat(5_000)}-after`;
  const lines: string[] = [];
  const message = {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  } as unknown as SDKMessage;

  agentInternals.logAgentMessage(message, 0, [secret], new Map(), (line) => lines.push(line));

  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /part 1\/2/u);
  assert.match(lines[1] ?? "", /part 2\/2/u);
  const chunks = lines.map((line) => line.slice(line.indexOf(": ") + 2));
  for (const chunk of chunks) {
    assert.doesNotMatch(chunk, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    assert.doesNotMatch(chunk, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  }
  const reconstructed = chunks.join("");
  assert.equal(reconstructed, JSON.stringify(text.replace(secret, "[REDACTED]")));
  assert.equal(reconstructed.includes(secret), false);
  assert.equal(reconstructed.includes("�"), false);

  const userLines: string[] = [];
  agentInternals.logQueuedUserMessage(
    agentInternals.makeUserMessage(text),
    "review",
    0,
    [secret],
    (line) => userLines.push(line),
  );
  assert.equal(userLines.length, 2);
  assert.equal(userLines.map((line) => line.slice(line.indexOf(": ") + 2)).join(""), reconstructed);
});

test("redacts complete structured error results before chunking", () => {
  const secret = "validation-secret";
  const validation = `findings.0.path: ${"x".repeat(9_000)} ${secret}`;
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "mcp_tool_result",
          tool_use_id: "submit-1",
          content: [{ type: "text", text: validation }],
          is_error: true,
        },
      ],
    },
  } as unknown as SDKMessage;
  const lines: string[] = [];
  const tools = new Map([
    ["submit-1", { kind: "mcp" as const, label: "review_output.submit_review" }],
  ]);

  agentInternals.logAgentMessage(message, 0, [secret], tools, (line) => lines.push(line));

  assert.ok(lines.length > 1);
  const reconstructed = lines.map((line) => line.slice(line.indexOf(": ") + 2)).join("");
  assert.match(reconstructed, /findings\.0\.path/u);
  assert.match(reconstructed, new RegExp("x{9000}", "u"));
  assert.match(reconstructed, /\[REDACTED\]/u);
  assert.equal(reconstructed.includes(secret), false);
});

test("treats camelCase internal validation flags as complete errors", () => {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "mcp_tool_result",
          tool_use_id: "submit-1",
          content: `findings.0.body: ${"v".repeat(9_000)}`,
          isError: true,
        },
      ],
    },
  } as unknown as SDKMessage;
  const lines: string[] = [];
  const tools = new Map([
    ["submit-1", { kind: "mcp" as const, label: "mcp__review_output__submit_review" }],
  ]);

  agentInternals.logAgentMessage(message, 0, [], tools, (line) => lines.push(line));

  assert.ok(lines.length > 1);
  const reconstructed = lines.map((line) => line.slice(line.indexOf(": ") + 2)).join("");
  assert.match(reconstructed, /"is_error":true/u);
  assert.match(reconstructed, new RegExp("v{9000}", "u"));
});

test("queues both initial prompts before activating the review gate", () => {
  const events: string[] = [];
  const queued: SDKMessage[] = [];
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 7,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    baseRef: "main",
    title: "Review sequencing",
    htmlUrl: "https://github.com/owner/repository/pull/7",
  };

  agentInternals.startReviewPrompt(
    {
      push: (message) => {
        queued.push(message);
        events.push(`push-${queued.length}`);
      },
    },
    "Check sequencing.",
    context,
    [],
    context.baseSha,
    1,
    [],
    0,
    [],
    () => events.push("activate"),
    () => undefined,
  );

  assert.deepEqual(events, ["push-1", "push-2", "activate"]);
  assert.match((queued[0] as { message: { content: string } }).message.content, /^\/goal /u);
  assert.match(
    (queued[1] as { message: { content: string } }).message.content,
    /isolated pull-request reviewer/u,
  );
  assert.match(
    (queued[1] as { message: { content: string } }).message.content,
    /1 prior discussion entry/u,
  );
});

test("logs goal, result, and compaction lifecycle events with counters", () => {
  const state = agentInternals.createAgentLifecycleState();
  const lines: string[] = [];
  const write = (line: string): void => {
    lines.push(line);
  };
  const base = { uuid: "event", session_id: "session-1" };
  const events = [
    {
      type: "system",
      subtype: "init",
      model: "review-model",
      claude_code_version: "2.0.0",
      ...base,
    },
    {
      type: "active_goal",
      value: {
        condition: "Complete the goal",
        iterations: 2,
        set_at: 1,
        tokens_at_start: 10,
        last_reason: `Need the diff ${"g".repeat(9_000)}`,
      },
      ...base,
    },
    {
      type: "system",
      subtype: "api_retry",
      attempt: 1,
      max_retries: 1,
      retry_delay_ms: 750,
      error_status: null,
      error: "unknown",
      ...base,
    },
    { type: "system", subtype: "status", status: "compacting", ...base },
    {
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "failed",
      compact_error: "provider error",
      ...base,
    },
    {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 100, post_tokens: 50 },
      ...base,
    },
    {
      type: "result",
      subtype: "error_max_turns",
      num_turns: 4,
      duration_ms: 80,
      duration_api_ms: 60,
      stop_reason: "max_turns",
      is_error: true,
      errors: [`provider error ${"r".repeat(9_000)}`],
      ...base,
    },
    { type: "active_goal", value: null, ...base },
  ] as unknown as Array<SDKMessage | SDKActiveGoalMessage>;

  for (const event of events) agentInternals.logAgentLifecycleMessage(event, 0, [], state, write);

  assert.equal(state.sessionId, "session-1");
  assert.equal(state.activeGoal, false);
  assert.equal(state.activeGoalReason, undefined);
  assert.equal(state.goalIterations, 2);
  assert.equal(state.turnResults, 1);
  assert.equal(state.latestTurnCount, 4);
  assert.equal(state.apiRetries, 1);
  assert.equal(state.compactionStarts, 1);
  assert.equal(state.compactionFailures, 1);
  assert.equal(state.compactionBoundaries, 1);
  assert.match(lines.join("\n"), /session init/u);
  assert.match(lines.join("\n"), /session goal-iteration/u);
  const goalIteration = lines.find((line) => /session goal-iteration/u.test(line));
  assert.match(goalIteration ?? "", /payload truncated/u);
  assert.equal((goalIteration ?? "").includes("g".repeat(9_000)), false);
  assert.match(
    lines.join("\n"),
    /session api-retry details:.*"attempt":1.*"max_retries":1.*"error_status":null/u,
  );
  assert.match(lines.join("\n"), /session compaction-start/u);
  assert.match(lines.join("\n"), /session compaction-result error/u);
  assert.match(lines.join("\n"), /session compaction-boundary/u);
  assert.match(lines.join("\n"), /session turn-result errors/u);
  const resultError = lines.find((line) => /session turn-result errors/u.test(line));
  assert.match(resultError ?? "", /payload truncated/u);
  assert.equal((resultError ?? "").includes("r".repeat(9_000)), false);
  assert.match(lines.join("\n"), /session goal-cleared/u);
});

test("describes the latest SDK activity for watchdog diagnostics", () => {
  const tools = new Map([["tool-1", { kind: "agent" as const, label: "Read" }]]);
  assert.deepEqual(
    agentInternals.sdkSessionActivity(
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tool-0", name: "Grep", input: {} },
            {
              type: "mcp_tool_use",
              id: "tool-1",
              server_name: "review_output",
              name: "read_review_briefing",
              input: {},
            },
          ],
        },
      } as unknown as SDKMessage,
      tools,
    ),
    { type: "assistant", tool: "review_output.read_review_briefing" },
  );
  assert.deepEqual(
    agentInternals.sdkSessionActivity(
      {
        type: "user",
        parent_tool_use_id: "tool-1",
        message: { role: "user", content: [] },
      } as unknown as SDKMessage,
      tools,
    ),
    { type: "user", tool: "Read" },
  );
  assert.deepEqual(
    agentInternals.sdkSessionActivity({
      type: "active_goal",
      value: { condition: "finish", iterations: 1 },
    } as unknown as SDKActiveGoalMessage),
    { type: "active_goal", subtype: "iteration" },
  );
  assert.deepEqual(
    agentInternals.sdkSessionActivity({
      type: "result",
      subtype: "success",
    } as unknown as SDKMessage),
    { type: "result", subtype: "success" },
  );

  const state = agentInternals.createAgentLifecycleState();
  agentInternals.logAgentLifecycleMessage(
    {
      type: "active_goal",
      value: { condition: "finish", iterations: 3, last_reason: "checking call sites" },
    } as unknown as SDKActiveGoalMessage,
    0,
    [],
    state,
    () => undefined,
  );
  assert.equal(state.activeGoal, true);
  assert.equal(state.activeGoalReason, "checking call sites");
});

test("serializes bounded agent log values without throwing on circular input", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const value = agentInternals.boundedAgentLogValue(circular, []);
  assert.match(value, /unserializable value/u);
  assert.match(value, /\[\d+ chars\]/u);
});

test("caps string previews after JSON escaping", () => {
  const value = agentInternals.boundedAgentLogValue("\n".repeat(200), []);
  const preview = value.match(/^(.+) \[200 chars\]$/u)?.[1];
  assert.ok(preview);
  assert.equal(preview.length, 200);
  assert.match(preview, /…$/u);
});

test("redacts JSON-escaped secrets before formatting structured values", () => {
  const secret = 'token"with\\escapes\nand-newline';
  const value = agentInternals.boundedAgentLogValue({ token: secret }, [secret]);
  assert.equal(value.includes('token\\"with\\\\escapes\\nand-newline'), false);
  assert.match(value, /\[REDACTED\]/u);
  assert.match(value, new RegExp(`\\[${JSON.stringify({ token: secret }).length} chars\\]$`, "u"));
});

test("bounds traversal of oversized structured agent log values", () => {
  const value: Record<string, unknown> = { content: "x".repeat(1_000_000) };
  Object.defineProperty(value, "unvisited", {
    enumerable: true,
    get: () => {
      throw new Error("the projection read beyond its bound");
    },
  });

  const result = agentInternals.boundedAgentLogValue(value, []);
  assert.match(result, /^\{"content":"x+/u);
  assert.match(result, /… \[payload truncated\]$/u);
  assert.equal(result.includes("unserializable"), false);
});

test("logs plain MCP tool-use blocks and parent-linked fallback results", () => {
  const toolUses = new Map<string, { readonly kind: "agent" | "mcp"; readonly label: string }>();
  const lines: string[] = [];
  const messages: SDKMessage[] = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "mcp-tool-1",
            name: "mcp__project_memory__search",
            input: { query: "release policy" },
          },
        ],
      },
    } as unknown as SDKMessage,
    {
      type: "user",
      parent_tool_use_id: "mcp-tool-1",
      tool_use_result: { content: "Memory result" },
      message: { role: "user", content: [] },
    } as unknown as SDKMessage,
  ];

  for (const message of messages)
    agentInternals.logAgentMessage(message, 0, [], toolUses, (line) => lines.push(line));

  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /MCP tool use mcp__project_memory__search input/u);
  assert.match(lines[1] ?? "", /MCP tool result mcp__project_memory__search output/u);
  assert.match(lines[1] ?? "", /Memory result/u);
});

test("bounds external MCP errors while preserving complete internal fallback errors", () => {
  const externalTools = new Map([
    ["external-tool", { kind: "mcp" as const, label: "mcp__security__validate" }],
  ]);
  const externalLines: string[] = [];
  const externalError = {
    type: "user",
    parent_tool_use_id: "external-tool",
    tool_use_result: {
      isError: true,
      content: "e".repeat(9_000),
    },
    message: { role: "user", content: [] },
  } as unknown as SDKMessage;

  agentInternals.logAgentMessage(externalError, 0, [], externalTools, (line) =>
    externalLines.push(line),
  );

  assert.equal(externalLines.length, 1);
  assert.match(externalLines[0] ?? "", /payload truncated/u);
  assert.equal((externalLines[0] ?? "").includes("e".repeat(9_000)), false);

  const internalTools = new Map([
    ["internal-tool", { kind: "mcp" as const, label: "review_output.submit_review" }],
  ]);
  const internalLines: string[] = [];
  const internalError = {
    type: "user",
    parent_tool_use_id: "internal-tool",
    tool_use_result: { is_error: true, content: "i".repeat(9_000) },
    message: { role: "user", content: [] },
  } as unknown as SDKMessage;
  agentInternals.logAgentMessage(internalError, 0, [], internalTools, (line) =>
    internalLines.push(line),
  );

  assert.ok(internalLines.length > 1);
  const reconstructed = internalLines.map((line) => line.slice(line.indexOf(": ") + 2)).join("");
  assert.match(reconstructed, new RegExp("i{9000}", "u"));
});

test("does not treat an external dotted server name as the internal review server", () => {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "mcp_tool_result",
          tool_use_id: "collision-tool",
          content: "c".repeat(9_000),
          is_error: true,
        },
      ],
    },
  } as unknown as SDKMessage;
  const lines: string[] = [];
  const tools = new Map([
    ["collision-tool", { kind: "mcp" as const, label: "review_output.foo.validate" }],
  ]);

  agentInternals.logAgentMessage(message, 0, [], tools, (line) => lines.push(line));

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /payload truncated/u);
  assert.equal((lines[0] ?? "").includes("c".repeat(9_000)), false);
});

test("contains agent logging failures without failing the review turn", () => {
  const secret = "mcp-header-secret";
  const warnings: string[] = [];
  const message = {
    type: "assistant",
    message: { content: [{ type: "text", text: "Reviewing the change" }] },
  } as unknown as SDKMessage;

  assert.doesNotThrow(() => {
    agentInternals.logAgentMessageSafely(
      message,
      0,
      [secret],
      new Map(),
      () => {
        throw new Error(`${secret}-${"x".repeat(260)}`);
      },
      (line) => warnings.push(line),
    );
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.includes(secret), false);
  assert.match(warnings[0] ?? "", /agent event log warning/u);
  assert.match(warnings[0] ?? "", /\[\d+ chars\]$/u);
});

test("covers agent log serialization and chunk boundaries", () => {
  assert.equal(agentInternals.completeAgentLogValue(undefined, []), "undefined");
  assert.equal(agentInternals.completeAgentLogValue(1n, []), "[unserializable value]");
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.equal(agentInternals.completeAgentLogValue(circular, []), "[unserializable value]");
  assert.equal(
    agentInternals.completeAgentLogValue(["secret", { value: 1 }], ["secret"]),
    '["[REDACTED]",{"value":1}]',
  );
  assert.deepEqual(agentInternals.chunkAgentLogValue(""), [""]);
  assert.deepEqual(agentInternals.chunkAgentLogValue("abcd", 2), ["ab", "cd"]);
  assert.throws(() => agentInternals.chunkAgentLogValue("value", 1), /at least 2/u);
  assert.throws(() => agentInternals.chunkAgentLogValue("value", 2.5), /integer/u);
  assert.equal(
    agentInternals.redactAgentLog("a data token-value", ["", "a", "token-value"]),
    "[REDACTED] data [REDACTED]",
  );

  const crossing = `${"x".repeat(1_020)}crossing-secret`;
  const bounded = agentInternals.boundedAgentLogValue(crossing, ["x", "crossing-secret"]);
  assert.equal(bounded.includes("crossing-secret"), false);
  assert.match(bounded, /\[1035 chars\]$/u);
  assert.match(agentInternals.boundedAgentLogValue([1n], []), /unserializable/u);
  let deep: unknown = "leaf";
  for (let index = 0; index < 12; index += 1) deep = { deep };
  assert.match(agentInternals.boundedAgentLogValue(deep, []), /payload truncated/u);
});

test("contains nested failures in the generic agent event logger", () => {
  const warnings: string[] = [];
  assert.doesNotThrow(() => {
    agentInternals.logAgentEventSafely(
      0,
      ["private-secret"],
      () => {
        throw new Error("private-secret failed");
      },
      () => undefined,
      (line) => {
        warnings.push(line);
      },
    );
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.includes("private-secret"), false);
  assert.doesNotThrow(() => {
    agentInternals.logAgentEventSafely(
      0,
      [],
      () => {
        throw new Error("first logger failed");
      },
      () => undefined,
      () => {
        throw new Error("warning failed");
      },
    );
  });
});

test("ignores malformed SDK log blocks while preserving valid fallback results", () => {
  const lines: string[] = [];
  const tools = new Map<string, { readonly kind: "agent" | "mcp"; readonly label: string }>();
  const messages = [
    { type: "assistant", message: null },
    {
      type: "assistant",
      message: {
        content: [
          null,
          { type: 1 },
          { type: "tool_use", name: "Read" },
          { type: "mcp_tool_use", id: "mcp", name: "lookup", input: {} },
        ],
      },
    },
    { type: "system", subtype: "unknown" },
    {
      type: "user",
      message: {
        content: [
          null,
          { type: "other" },
          { type: "mcp_tool_result", tool_use_id: "mcp", content: "ok", isError: false },
        ],
      },
    },
    {
      type: "user",
      parent_tool_use_id: null,
      tool_use_result: { content: "fallback" },
      message: { role: "user", content: "text" },
    },
  ] as unknown as SDKMessage[];
  for (const message of messages)
    agentInternals.logAgentMessage(message, 0, [], tools, (line) => lines.push(line));
  assert.equal(tools.get("mcp")?.kind, "mcp");
  assert.match(lines.join("\n"), /MCP tool use lookup/u);
  assert.match(lines.join("\n"), /fallback/u);

  const queued: string[] = [];
  agentInternals.logQueuedUserMessage(
    {
      type: "user",
      message: { role: "user", content: [{ type: "image", source: {} }] },
    } as unknown as SDKUserMessage,
    "empty",
    0,
    [],
    (line) => queued.push(line),
  );
  assert.deepEqual(queued, []);
});

test("records successful compaction and minimal lifecycle messages", () => {
  const state = agentInternals.createAgentLifecycleState();
  const lines: string[] = [];
  const events = [
    { type: "system", subtype: "init", session_id: "session" },
    { type: "system", subtype: "status", status: "compacting", session_id: "session" },
    {
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "success",
      session_id: "session",
    },
    {
      type: "result",
      subtype: "success",
      num_turns: 0,
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: false,
      errors: [],
      session_id: "session",
    },
    { type: "assistant", message: { content: [] }, session_id: "session" },
  ] as unknown as Array<SDKMessage | SDKActiveGoalMessage>;
  for (const event of events)
    agentInternals.logAgentLifecycleMessage(event, 0, [], state, (line) => lines.push(line));
  assert.equal(state.compactionSuccesses, 1);
  assert.equal(state.turnResults, 1);
  assert.match(lines.join("\n"), /compaction-result details:.*"result":"success"/u);
});
