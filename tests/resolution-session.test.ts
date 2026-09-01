import {
  agentInternals,
  assert,
  CancellationError,
  test,
  type Options,
  type PullRequestContext,
  type ReviewConfig,
} from "./agent-test-helpers.js";
import {
  runResolutionVerifiers,
  resolutionInternals,
  verifyResolution,
  type ResolutionQuery,
} from "../src/runtime/resolution-session.js";
import type { ReviewLifecycleThreadRecord } from "../src/lib/github-review-lifecycle.js";
import type {
  SDKActiveGoalMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

interface ManualSignal<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function manualSignal<T>(): ManualSignal<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

function resolutionResult(index: number, subtype = "success"): SDKResultMessage {
  return {
    type: "result",
    subtype,
    errors: subtype === "success" ? [] : [`interrupted ${index}`],
    num_turns: index,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: subtype !== "success",
    session_id: "controlled-resolution-session",
    uuid: `controlled-resolution-result-${index}`,
    modelUsage: {},
  } as unknown as SDKResultMessage;
}

function resolutionSubmitTool(options: Options): {
  handler(input: Record<string, unknown>): Promise<{
    readonly content: readonly { readonly text?: string }[];
  }>;
} {
  const output = options.mcpServers?.resolution_output as unknown as {
    readonly instance: {
      readonly _registeredTools: Record<
        string,
        {
          handler(input: Record<string, unknown>): Promise<{
            readonly content: readonly { readonly text?: string }[];
          }>;
        }
      >;
    };
  };
  const submit = output.instance._registeredTools.submit_resolution;
  assert.ok(submit);
  return submit;
}

function resolutionMessageText(message: SDKUserMessage): string {
  const content = message.message.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

const context: PullRequestContext = {
  repository: "owner/repository",
  owner: "owner",
  name: "repository",
  number: 1,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  baseRef: "main",
  title: "Resolution",
  htmlUrl: "https://github.com/owner/repository/pull/1",
};
const config: ReviewConfig = {
  githubToken: "token",
  aiBaseUrl: "https://ai.example.test",
  aiSecret: "secret",
  model: "review-model",
  reviewPrompts: [{ prompt: "correctness", files: [] }],
  parallelCount: 1,
  maxTurns: 4,
  autoApprove: false,
  interactWithPullRequest: true,
  mcpServers: {},
};
const thread: ReviewLifecycleThreadRecord = {
  nodeId: "thread-node",
  isResolved: false,
  isOutdated: true,
  path: "src/change.ts",
  line: 4,
  originalLine: 4,
  reviewId: 10,
  reviewNodeId: "review-node",
  comments: [
    {
      nodeId: "comment-node",
      databaseId: 11,
      reviewId: 10,
      reviewNodeId: "review-node",
      author: { login: "review-action", type: "User" },
      body: "The old failure path is unsafe.",
      commitId: context.baseSha,
      createdAt: "2026-08-31T00:00:00Z",
      updatedAt: "2026-08-31T00:00:00Z",
    },
  ],
};

function fakeQuery(
  inputHandler: (tool: {
    handler(input: Record<string, unknown>): Promise<{ content: readonly { text?: string }[] }>;
  }) => Promise<unknown>,
): ResolutionQuery {
  return ((input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const output = input.options.mcpServers?.resolution_output as unknown as {
      readonly instance: {
        readonly _registeredTools: Record<
          string,
          {
            handler(
              input: Record<string, unknown>,
            ): Promise<{ content: readonly { text?: string }[] }>;
          }
        >;
      };
    };
    const submit = output.instance._registeredTools.submit_resolution;
    assert.ok(submit);
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
        const message = await input.prompt[Symbol.asyncIterator]().next();
        assert.equal(message.done, false);
        const content = message.value.message.content;
        const contentText = typeof content === "string" ? content : JSON.stringify(content);
        assert.ok(contentText.includes(context.headSha));
        await markReadEvidence(input.options);
        await inputHandler(submit);
        yield {
          type: "result",
          subtype: "success",
          errors: [],
          num_turns: 1,
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          session_id: "resolution-session",
          uuid: "resolution-result",
          modelUsage: {},
        } as unknown as SDKResultMessage;
      },
      mcpServerStatus: () => Promise.resolve([]),
      interrupt: () => Promise.resolve(undefined),
      close: () => undefined,
    };
  }) as unknown as ResolutionQuery;
}

interface ScriptedTurn {
  readonly hasSubmission?: boolean;
  readonly submission?: unknown;
  readonly duplicateSubmission?: unknown;
  readonly readBeforeSubmit?: boolean;
  readonly subtype?: string;
  readonly errors?: readonly string[];
  readonly failure?: Error;
}

function scriptedQuery(
  turns: readonly ScriptedTurn[],
  onSubmission?: (result: { readonly content: readonly { readonly text?: string }[] }) => void,
  onQuery?: () => void,
  onPrompt?: (message: SDKUserMessage) => void,
): ResolutionQuery {
  return ((input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    onQuery?.();
    const output = input.options.mcpServers?.resolution_output as unknown as {
      readonly instance: {
        readonly _registeredTools: Record<
          string,
          {
            handler(
              input: Record<string, unknown>,
            ): Promise<{ content: readonly { text?: string }[] }>;
          }
        >;
      };
    };
    const submit = output.instance._registeredTools.submit_resolution;
    assert.ok(submit);
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
        const iterator = input.prompt[Symbol.asyncIterator]();
        for (const turn of turns) {
          const message = await iterator.next();
          assert.equal(message.done, false);
          onPrompt?.(message.value);
          if (turn.failure !== undefined) throw turn.failure;
          if (turn.hasSubmission === true) {
            if (turn.readBeforeSubmit !== false) await markReadEvidence(input.options);
            const result = await submit.handler(turn.submission as Record<string, unknown>);
            onSubmission?.(result);
            if (turn.duplicateSubmission !== undefined) {
              const duplicate = await submit.handler(
                turn.duplicateSubmission as Record<string, unknown>,
              );
              onSubmission?.(duplicate);
            }
          }
          yield {
            type: "result",
            subtype: turn.subtype ?? "success",
            errors: [...(turn.errors ?? [])],
            num_turns: 1,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: turn.subtype !== undefined && turn.subtype !== "success",
            session_id: "resolution-session",
            uuid: "resolution-result",
            modelUsage: {},
          } as unknown as SDKResultMessage;
        }
      },
      mcpServerStatus: () => Promise.resolve([]),
      interrupt: () => Promise.resolve(undefined),
      close: () => undefined,
    };
  }) as unknown as ResolutionQuery;
}

async function markReadEvidence(options: Options): Promise<void> {
  const hooks = options.hooks as unknown as {
    readonly PostToolUse?: readonly {
      readonly hooks: readonly ((input: unknown) => Promise<unknown>)[];
    }[];
  };
  const callback = hooks.PostToolUse?.[0]?.hooks[0];
  if (callback === undefined) throw new Error("resolution read evidence hook is missing");
  await callback({
    hook_event_name: "PostToolUse",
    tool_name: "Read",
    tool_input: { file_path: thread.path },
    tool_response: "current file contents",
    tool_use_id: "read-tool",
    cwd: "/workspace",
  });
}

test("resolution verifier accepts an explicit high-confidence fixed verdict", async () => {
  const result = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    fakeQuery((submit) =>
      submit.handler({ verdict: "fixed", confidence: "high", rationale: "guard restored" }),
    ),
  );
  assert.deepEqual(result, {
    status: "completed",
    verdict: "fixed",
    confidence: "high",
    rationale: "guard restored",
  });
});

test("resolution verifier preserves non-high confidence verdicts for the lifecycle guard", async () => {
  const result = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    fakeQuery((submit) =>
      submit.handler({ verdict: "fixed", confidence: "medium", rationale: "probably fixed" }),
    ),
  );
  assert.equal(result.status, "completed");
  assert.equal(result.verdict, "fixed");
  assert.equal(result.confidence, "medium");
});

test("finalizes an accepted resolution when the SDK stops yielding messages", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
  const output: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    output.push(chunk.toString());
    return true;
  });
  const ready = manualSignal<undefined>();
  const closed = manualSignal<undefined>();
  let interrupts = 0;
  let closes = 0;
  const query = ((input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage | SDKActiveGoalMessage> {
      const message = await input.prompt[Symbol.asyncIterator]().next();
      assert.equal(message.done, false);
      await markReadEvidence(input.options);
      yield {
        type: "active_goal",
        value: { condition: "verify", iterations: 2, last_reason: "checking verifier" },
      } as unknown as SDKActiveGoalMessage;
      const accepted = await resolutionSubmitTool(input.options).handler({
        verdict: "fixed",
        confidence: "high",
        rationale: "guard restored",
      });
      assert.equal(accepted.content[0]?.text, "Resolution accepted.");
      ready.resolve(undefined);
      await closed.promise;
    },
    mcpServerStatus: () => Promise.resolve([]),
    interrupt: () => {
      interrupts += 1;
      return Promise.resolve(undefined);
    },
    close: () => {
      closes += 1;
      closed.resolve(undefined);
    },
  })) as unknown as ResolutionQuery;

  const running = verifyResolution(context, thread, config, "/workspace", query);
  await ready.promise;
  t.mock.timers.tick(agentInternals.SDK_SESSION_STALL_MS);
  const result = await running;

  assert.deepEqual(result, {
    status: "completed",
    verdict: "fixed",
    confidence: "high",
    rationale: "guard restored",
  });
  assert.equal(interrupts, 1);
  assert.equal(closes, 1);
  const logs = output.join("");
  assert.match(logs, /session heartbeat.*"active_goal_reason":"checking verifier"/u);
  assert.match(logs, /session heartbeat.*"verdict_accepted":true/u);
  assert.match(logs, /session stall-detected.*"elapsed_since_sdk_message_ms":300000/u);
  assert.match(logs, /session verdict-finalized.*"terminal_sdk_result":false/u);
});

test("lets an accepted verdict win an interrupted verifier boundary", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
  const ready = manualSignal<undefined>();
  const boundary = manualSignal<undefined>();
  let interrupts = 0;
  let closes = 0;
  let extraPrompt = false;
  const query = ((input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
      const messages = input.prompt[Symbol.asyncIterator]();
      const initial = await messages.next();
      assert.equal(initial.done, false);
      await markReadEvidence(input.options);
      ready.resolve(undefined);
      await boundary.promise;
      const accepted = await resolutionSubmitTool(input.options).handler({
        verdict: "fixed",
        confidence: "high",
        rationale: "accepted during interrupt",
      });
      assert.equal(accepted.content[0]?.text, "Resolution accepted.");
      yield resolutionResult(1, "error_during_execution");
      const next = await messages.next();
      extraPrompt = !next.done;
    },
    mcpServerStatus: () => Promise.resolve([]),
    interrupt: () => {
      interrupts += 1;
      boundary.resolve(undefined);
      return Promise.resolve(undefined);
    },
    close: () => {
      closes += 1;
    },
  })) as unknown as ResolutionQuery;

  const running = verifyResolution(context, thread, config, "/workspace", query);
  await ready.promise;
  t.mock.timers.tick(agentInternals.SDK_SESSION_STALL_MS);
  const result = await running;

  assert.deepEqual(result, {
    status: "completed",
    verdict: "fixed",
    confidence: "high",
    rationale: "accepted during interrupt",
  });
  assert.equal(extraPrompt, false);
  assert.equal(interrupts, 1);
  assert.equal(closes, 1);
});

test("continues resolution verification across repeated SDK stalls", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
  const output: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    output.push(chunk.toString());
    return true;
  });
  const ready = [manualSignal<undefined>(), manualSignal<undefined>()];
  const boundaries = [manualSignal<undefined>(), manualSignal<undefined>()];
  const continuations: string[] = [];
  let interrupts = 0;
  let closes = 0;
  const query = ((input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
      const messages = input.prompt[Symbol.asyncIterator]();
      const initial = await messages.next();
      assert.equal(initial.done, false);
      await markReadEvidence(input.options);
      ready[0]?.resolve(undefined);
      for (let index = 0; index < boundaries.length; index += 1) {
        const boundary = boundaries[index];
        assert.ok(boundary);
        await boundary.promise;
        yield resolutionResult(index + 1, "error_during_execution");
        const continuation = await messages.next();
        assert.equal(continuation.done, false);
        continuations.push(resolutionMessageText(continuation.value));
        if (index + 1 < boundaries.length) ready[index + 1]?.resolve(undefined);
      }
      const accepted = await resolutionSubmitTool(input.options).handler({
        verdict: "fixed",
        confidence: "high",
        rationale: "recovered verifier",
      });
      assert.equal(accepted.content[0]?.text, "Resolution accepted.");
      yield resolutionResult(3);
      assert.equal((await messages.next()).done, true);
    },
    mcpServerStatus: () => Promise.resolve([]),
    interrupt: () => {
      const call = interrupts;
      interrupts += 1;
      if (call === 0) return Promise.reject(new Error("resolution interrupt unavailable"));
      const boundary = boundaries[call - 1];
      boundary?.resolve(undefined);
      return Promise.resolve(undefined);
    },
    close: () => {
      closes += 1;
    },
  })) as unknown as ResolutionQuery;

  const running = verifyResolution(context, thread, config, "/workspace", query);
  await ready[0]?.promise;
  t.mock.timers.tick(agentInternals.SDK_SESSION_STALL_MS);
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  t.mock.timers.tick(agentInternals.SDK_SESSION_STALL_MS);
  await ready[1]?.promise;
  t.mock.timers.tick(agentInternals.SDK_SESSION_STALL_MS);
  const result = await running;

  assert.deepEqual(result, {
    status: "completed",
    verdict: "fixed",
    confidence: "high",
    rationale: "recovered verifier",
  });
  assert.equal(interrupts, 3);
  assert.equal(closes, 1);
  assert.equal(continuations.length, 2);
  assert.equal(
    continuations.every((message) => message.includes("Continue the same resolution verification")),
    true,
  );
  assert.match(output.join(""), /interrupt-failed.*resolution interrupt unavailable/u);
  assert.match(output.join(""), /interrupted-turn-boundary/u);
  assert.match(output.join(""), /session end/u);
});

test("resolution prompt bounds large untrusted thread content", () => {
  const originalComment = thread.comments[0];
  assert.ok(originalComment);
  const largeThread = {
    ...thread,
    comments: [{ ...originalComment, body: "x".repeat(100_000) }],
  };
  const prompt = resolutionInternals.resolutionPrompt(context, largeThread);
  assert.match(prompt, /thread context truncated/u);
  assert.ok(prompt.length < 40_000);
});

test("repairs invalid verifier submissions before accepting a valid result", async () => {
  const toolResults: string[] = [];
  const result = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery(
      [
        { hasSubmission: true, submission: null },
        {
          hasSubmission: true,
          submission: { verdict: "not_fixed", confidence: "high", rationale: "still present" },
        },
      ],
      (response) => toolResults.push(response.content[0]?.text ?? ""),
    ),
  );
  assert.deepEqual(result, {
    status: "completed",
    verdict: "not_fixed",
    confidence: "high",
    rationale: "still present",
  });
  assert.deepEqual(toolResults, [
    "Resolution submission rejected. Input must be an object.",
    "Resolution accepted.",
  ]);
});

test("redacts untrusted thread bodies and rejects a fixed verdict without a current-file read", async () => {
  const secret = "thread-only-secret-value";
  const originalComment = thread.comments[0];
  assert.ok(originalComment);
  const secretThread: ReviewLifecycleThreadRecord = {
    ...thread,
    comments: [{ ...originalComment, body: `Credential: ${secret}` }],
  };
  let prompt = "";
  const prompts: string[] = [];
  const toolResults: string[] = [];
  const result = await verifyResolution(
    context,
    secretThread,
    { ...config, githubToken: secret },
    "/workspace",
    scriptedQuery(
      [
        {
          hasSubmission: true,
          readBeforeSubmit: false,
          submission: { verdict: "fixed", confidence: "high", rationale: "premature" },
        },
        {
          hasSubmission: true,
          submission: { verdict: "not_fixed", confidence: "high", rationale: "still present" },
        },
      ],
      (response) => toolResults.push(response.content[0]?.text ?? ""),
      undefined,
      (message) => {
        const content = message.message.content;
        prompt = typeof content === "string" ? content : JSON.stringify(content);
        prompts.push(prompt);
      },
    ),
  );
  assert.equal(result.verdict, "not_fixed");
  assert.doesNotMatch(prompts[0] ?? "", new RegExp(secret, "u"));
  assert.match(prompts[0] ?? "", /\[REDACTED\]/u);
  assert.equal(
    toolResults[0],
    "Resolution submission rejected. A successful Read of the cited file is required before a fixed verdict.",
  );
});

test("rejects duplicate submissions and reports non-success or missing verdicts", async () => {
  const duplicateResults: string[] = [];
  const accepted = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery(
      [
        {
          hasSubmission: true,
          submission: { verdict: "fixed", confidence: "high", rationale: "fixed" },
          duplicateSubmission: { verdict: "not_fixed", confidence: "high", rationale: "late" },
        },
      ],
      (response) => {
        duplicateResults.push(response.content[0]?.text ?? "");
      },
    ),
  );
  assert.equal(accepted.status, "completed");

  const invalidResults: string[] = [];
  const invalid = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery(
      [
        {
          hasSubmission: true,
          submission: { verdict: "fixed", confidence: "high", rationale: "fixed", extra: true },
        },
        {
          hasSubmission: true,
          submission: { verdict: "uncertain", confidence: "low", rationale: "not enough evidence" },
        },
      ],
      (response) => invalidResults.push(response.content[0]?.text ?? ""),
    ),
  );
  assert.equal(invalid.status, "completed");
  assert.equal(invalid.verdict, "uncertain");
  assert.deepEqual(invalidResults, [
    "Resolution submission rejected. The verdict was invalid.",
    "Resolution accepted.",
  ]);
  assert.deepEqual(duplicateResults, [
    "Resolution accepted.",
    "Resolution submission rejected. A verdict was already accepted.",
  ]);

  const noVerdict = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery([{}, {}, {}]),
  );
  assert.deepEqual(noVerdict, {
    status: "failed",
    error: "The verifier did not submit a resolution verdict.",
  });

  const providerFailure = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery([{ subtype: "error", errors: ["provider failed"] }]),
  );
  assert.deepEqual(providerFailure, { status: "failed", error: "provider failed" });
  const unnamedFailure = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery([{ subtype: "error" }]),
  );
  assert.deepEqual(unnamedFailure, { status: "failed", error: "Claude returned error." });
});

test("contains provider and reader failures while preserving cancellation", async () => {
  const providerError = new Error("query failed");
  const providerFailure = await verifyResolution(context, thread, config, "/workspace", () => {
    throw providerError;
  });
  assert.deepEqual(providerFailure, { status: "failed", error: "query failed" });

  const readerFailure = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery([{ failure: new Error("reader failed") }]),
  );
  assert.deepEqual(readerFailure, { status: "failed", error: "reader failed" });

  const exhausted = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery([]),
  );
  assert.deepEqual(exhausted, {
    status: "failed",
    error: "The verifier session ended before returning a result.",
  });

  const controller = new AbortController();
  const cancellation = new CancellationError("SIGTERM");
  controller.abort(cancellation);
  await assert.rejects(
    verifyResolution(context, thread, config, "/workspace", scriptedQuery([]), controller),
    (error: unknown) => error === cancellation,
  );
});

test("configures a read-only verifier and processes verifiers in bounded batches", async () => {
  const controller = new AbortController();
  const options = resolutionInternals.optionsForResolution(
    { ...config, effort: "high" },
    "/workspace",
    controller,
    {} as never,
  );
  assert.equal(options.cwd, "/workspace");
  assert.equal(options.effort, "high");
  assert.equal(options.abortController, controller);
  assert.deepEqual(options.tools, ["Read", "Glob", "Grep"]);
  assert.deepEqual(options.allowedTools, [
    "Read",
    "Glob",
    "Grep",
    "mcp__resolution_output__submit_resolution",
  ]);
  const noLine = { ...thread };
  delete noLine.line;
  assert.match(resolutionInternals.resolutionPrompt(context, noLine), /src\/change\.ts/u);
  assert.match(resolutionInternals.resolutionRepairPrompt(2), /repair attempt 2/u);

  const threads = Array.from({ length: 6 }, (_, index) => ({
    ...thread,
    nodeId: `thread-${index}`,
  }));
  let queryCount = 0;
  const results = await runResolutionVerifiers(
    context,
    threads,
    config,
    "/workspace",
    scriptedQuery(
      [
        {
          hasSubmission: true,
          submission: { verdict: "fixed", confidence: "high", rationale: "gone" },
        },
      ],
      undefined,
      () => {
        queryCount += 1;
      },
    ),
  );
  assert.equal(results.length, 6);
  assert.equal(queryCount, 6);
  assert.deepEqual(
    await runResolutionVerifiers(context, [], config, "/workspace", scriptedQuery([])),
    [],
  );
});
