import {
  agentInternals,
  assert,
  emptyConversation,
  goalContext,
  makeReviewDiff,
  reviewConfig,
  runReviewGoal,
  test,
  type AgentQuery,
  type Options,
  type SDKResultMessage,
  type SDKUserMessage,
} from "./agent-test-helpers.js";

interface ReviewOutputTool {
  handler(input: Record<string, unknown>): Promise<{
    readonly content: readonly { readonly text?: string }[];
    readonly isError?: boolean;
  }>;
}

function reviewOutputTools(options: Options): Readonly<Record<string, ReviewOutputTool>> {
  const server = options.mcpServers?.review_output as unknown as {
    readonly instance: {
      readonly _registeredTools: Readonly<Record<string, ReviewOutputTool>>;
    };
  };
  return server.instance._registeredTools;
}

async function completeReviewBriefing(options: Options): Promise<void> {
  const briefing = reviewOutputTools(options).read_review_briefing;
  assert.ok(briefing);
  let done = false;
  while (!done) {
    const result = await briefing.handler({});
    const page = JSON.parse(result.content[0]?.text ?? "{}") as { readonly done?: unknown };
    done = page.done === true;
  }
}

function resultMessage(index: number, subtype = "success"): SDKResultMessage {
  return {
    type: "result",
    subtype,
    errors: subtype === "success" ? [] : [`interrupted ${index}`],
    num_turns: index,
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: subtype !== "success",
    session_id: "controlled-session",
    uuid: `controlled-result-${index}`,
    modelUsage: {
      "review-model": {
        inputTokens: index * 10,
        outputTokens: index * 2,
        cacheReadInputTokens: index * 4,
        cacheCreationInputTokens: index,
        canonicalModel: "canonical-review-model",
      },
    },
  } as unknown as SDKResultMessage;
}

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
    resolve: (value) => {
      resolvePromise?.(value);
    },
  };
}

function userMessageText(message: SDKUserMessage): string {
  const content = message.message.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

test("repairs an interactive finding whose anchor is not an added line", async (t) => {
  const toolResults: string[] = [];
  const prompts: string[] = [];
  const query = ((input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: Options;
  }) => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
      const messages = input.prompt[Symbol.asyncIterator]();
      assert.equal((await messages.next()).done, false);
      assert.equal((await messages.next()).done, false);
      await completeReviewBriefing(input.options);
      const submit = reviewOutputTools(input.options).submit_review;
      assert.ok(submit);
      const invalid = await submit.handler({
        summary: "One issue",
        findings: [
          {
            title: "Wrong anchor",
            severity: "HIGH",
            why: "The failure is reachable.",
            fix: "Repair the failure path.",
            path: "src/change.ts",
            line: 2,
          },
        ],
      });
      toolResults.push(invalid.content[0]?.text ?? "");
      assert.equal(invalid.isError, true);
      yield resultMessage(1);
      const repair = await messages.next();
      assert.equal(repair.done, false);
      prompts.push(userMessageText(repair.value));
      const accepted = await submit.handler({
        summary: "One issue",
        findings: [
          {
            title: "Correct anchor",
            severity: "HIGH",
            why: "The failure is reachable.",
            fix: "Repair the failure path.",
            path: "src/change.ts",
            line: 1,
          },
        ],
      });
      toolResults.push(accepted.content[0]?.text ?? "");
      yield resultMessage(2);
      assert.equal((await messages.next()).done, true);
    },
    mcpServerStatus: () => Promise.resolve([]),
    interrupt: () => Promise.resolve(undefined),
    close: () => undefined,
  })) as unknown as AgentQuery;

  const result = await runReviewGoal(
    "Check interactive anchors.",
    0,
    goalContext,
    [
      {
        path: "src/change.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        addedLines: new Set([1]),
      },
    ],
    emptyConversation,
    reviewConfig({ interactWithPullRequest: true }),
    await makeReviewDiff(t),
    "/workspace/repository",
    query,
  );

  assert.equal(result.status, "completed");
  assert.equal(result.submission?.findings[0]?.title, "Correct anchor");
  assert.match(toolResults[0] ?? "", /participating added line/u);
  assert.equal(toolResults[1], "Review submission accepted.");
  assert.match(prompts[0] ?? "", /requires path and line on a participating added line/u);
});

test("finalizes an accepted submission when the SDK stops yielding messages", async (t) => {
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
  const query = ((input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: Options;
  }) => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
      const messages = input.prompt[Symbol.asyncIterator]();
      assert.equal((await messages.next()).done, false);
      assert.equal((await messages.next()).done, false);
      await completeReviewBriefing(input.options);
      const submit = reviewOutputTools(input.options).submit_review;
      assert.ok(submit);
      const accepted = await submit.handler({ summary: "No issues", findings: [] });
      assert.equal(accepted.content[0]?.text, "Review submission accepted.");
      ready.resolve(undefined);
      await closed.promise;
      yield* [] as SDKResultMessage[];
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
  })) as unknown as AgentQuery;

  const running = runReviewGoal(
    "Check stalled submission finalization.",
    0,
    goalContext,
    [],
    emptyConversation,
    reviewConfig(),
    await makeReviewDiff(t),
    "/workspace/repository",
    query,
  );
  await ready.promise;
  t.mock.timers.tick(agentInternals.SDK_SESSION_STALL_MS);
  const result = await running;

  assert.equal(result.status, "completed");
  assert.deepEqual(result.submission, { summary: "No issues", findings: [] });
  assert.deepEqual(result.tokenUsage, { models: [], complete: false });
  assert.equal(interrupts, 1);
  assert.equal(closes, 1);
  const logs = output.join("");
  assert.match(logs, /session heartbeat.*"submission_accepted":true/u);
  assert.match(logs, /session stall-detected.*"elapsed_since_sdk_message_ms":300000/u);
  assert.match(logs, /session submission-finalized.*"token_accounting_complete":false/u);
});

test("lets an accepted submission win an interrupted turn boundary", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
  const ready = manualSignal<undefined>();
  const boundary = manualSignal<undefined>();
  let interrupts = 0;
  let closes = 0;
  let extraPrompt = false;
  const query = ((input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: Options;
  }) => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
      const messages = input.prompt[Symbol.asyncIterator]();
      assert.equal((await messages.next()).done, false);
      assert.equal((await messages.next()).done, false);
      await completeReviewBriefing(input.options);
      ready.resolve(undefined);
      await boundary.promise;
      const submit = reviewOutputTools(input.options).submit_review;
      assert.ok(submit);
      const accepted = await submit.handler({ summary: "Accepted during interrupt", findings: [] });
      assert.equal(accepted.content[0]?.text, "Review submission accepted.");
      yield resultMessage(1, "error_during_execution");
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
  })) as unknown as AgentQuery;

  const running = runReviewGoal(
    "Check interrupted submission race.",
    0,
    goalContext,
    [],
    emptyConversation,
    reviewConfig(),
    await makeReviewDiff(t),
    "/workspace/repository",
    query,
  );
  await ready.promise;
  t.mock.timers.tick(agentInternals.SDK_SESSION_STALL_MS);
  const result = await running;

  assert.equal(result.status, "completed");
  assert.equal(result.submission?.summary, "Accepted during interrupt");
  assert.equal(result.tokenUsage?.complete, true);
  assert.equal(extraPrompt, false);
  assert.equal(interrupts, 1);
  assert.equal(closes, 1);
});

test("continues unfinished turns across repeated SDK stalls", async (t) => {
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
  const query = ((input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: Options;
  }) => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
      const messages = input.prompt[Symbol.asyncIterator]();
      assert.equal((await messages.next()).done, false);
      assert.equal((await messages.next()).done, false);
      await completeReviewBriefing(input.options);
      ready[0]?.resolve(undefined);
      for (let index = 0; index < boundaries.length; index += 1) {
        const boundary = boundaries[index];
        assert.ok(boundary);
        await boundary.promise;
        yield resultMessage(index + 1, "error_during_execution");
        const continuation = await messages.next();
        assert.equal(continuation.done, false);
        continuations.push(userMessageText(continuation.value));
        if (index + 1 < boundaries.length) ready[index + 1]?.resolve(undefined);
      }
      const submit = reviewOutputTools(input.options).submit_review;
      assert.ok(submit);
      const accepted = await submit.handler({ summary: "Recovered", findings: [] });
      assert.equal(accepted.content[0]?.text, "Review submission accepted.");
      yield resultMessage(3);
      assert.equal((await messages.next()).done, true);
    },
    mcpServerStatus: () => Promise.resolve([]),
    interrupt: () => {
      const call = interrupts;
      interrupts += 1;
      if (call === 0) return Promise.reject(new Error("control channel unavailable"));
      const boundary = boundaries[call - 1];
      boundary?.resolve(undefined);
      return Promise.resolve(undefined);
    },
    close: () => {
      closes += 1;
    },
  })) as unknown as AgentQuery;

  const running = runReviewGoal(
    "Check repeated stall recovery.",
    0,
    goalContext,
    [],
    emptyConversation,
    reviewConfig(),
    await makeReviewDiff(t),
    "/workspace/repository",
    query,
  );
  await ready[0]?.promise;
  t.mock.timers.tick(agentInternals.SDK_SESSION_STALL_MS);
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
  t.mock.timers.tick(agentInternals.SDK_SESSION_STALL_MS);
  await ready[1]?.promise;
  t.mock.timers.tick(agentInternals.SDK_SESSION_STALL_MS);
  const result = await running;

  assert.equal(result.status, "completed");
  assert.equal(result.submission?.summary, "Recovered");
  assert.equal(result.tokenUsage?.complete, true);
  assert.equal(interrupts, 3);
  assert.equal(closes, 1);
  assert.equal(continuations.length, 2);
  assert.equal(
    continuations.every((message) => message.includes("Continue the same goal")),
    true,
  );
  assert.match(output.join(""), /interrupt-failed.*control channel unavailable/u);
  assert.match(output.join(""), /interrupted-turn-boundary/u);
});
