import {
  agentInternals,
  assert,
  CancellationError,
  emptyConversation,
  goalContext,
  makeReviewDiff,
  observedReviewOutputTools,
  reviewConfig,
  readCompleteReviewDiff,
  runReviewGoalWithEmptyGuidance as runReviewGoal,
  test,
  type AgentQuery,
  type Options,
  type SDKMessage,
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
  return observedReviewOutputTools(options);
}

async function completeReviewContext(options: Options): Promise<string> {
  const briefing = reviewOutputTools(options).read_review_briefing;
  assert.ok(briefing);
  let done = false;
  while (!done) {
    const result = await briefing.handler({});
    const page = JSON.parse(result.content[0]?.text ?? "{}") as { readonly done?: unknown };
    done = page.done === true;
  }
  return readCompleteReviewDiff(options);
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
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
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
      const evidenceRef = await completeReviewContext(input.options);
      const submit = reviewOutputTools(input.options).submit_review;
      assert.ok(submit);
      const invalid = await submit.handler({
        limitations: [],
        summary: "One issue",
        findings: [
          {
            evidenceRefs: [evidenceRef],
            countercheck: "Checked the relevant caller for a guard.",
            counterevidenceRefs: [],
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
      t.mock.timers.tick(agentInternals.SDK_SUBMISSION_GRACE_MS);
      yield resultMessage(1);
      const repair = await messages.next();
      assert.equal(repair.done, false);
      prompts.push(userMessageText(repair.value));
      const accepted = await submit.handler({
        limitations: [],
        summary: "One issue",
        findings: [
          {
            evidenceRefs: [evidenceRef],
            countercheck: "Checked the relevant caller for a guard.",
            counterevidenceRefs: [],
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
  assert.match(
    prompts[0] ?? "",
    /Every finding needs a changed path and participating added line/u,
  );
});

test("finalizes a silent accepted submission after its completion grace", async (t) => {
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
  let mcpStatusChecks = 0;
  const query = ((input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: Options;
  }) => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
      const messages = input.prompt[Symbol.asyncIterator]();
      assert.equal((await messages.next()).done, false);
      assert.equal((await messages.next()).done, false);
      await completeReviewContext(input.options);
      const submit = reviewOutputTools(input.options).submit_review;
      assert.ok(submit);
      const accepted = await submit.handler({
        limitations: [],
        summary: "No issues",
        findings: [],
      });
      assert.equal(accepted.content[0]?.text, "Review submission accepted.");
      ready.resolve(undefined);
      await closed.promise;
      yield* [] as SDKResultMessage[];
    },
    mcpServerStatus: () => {
      mcpStatusChecks += 1;
      return Promise.resolve([]);
    },
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
  t.mock.timers.tick(agentInternals.SDK_SUBMISSION_GRACE_MS);
  const result = await running;

  assert.equal(result.status, "completed");
  assert.deepEqual(result.submission, {
    summary: "No issues",
    findings: [],
    limitations: [],
  });
  assert.deepEqual(result.tokenUsage, { models: [], complete: false });
  assert.equal(interrupts, 1);
  assert.equal(closes, 1);
  assert.equal(mcpStatusChecks, 1);
  const logs = output.join("");
  assert.match(logs, /session submission-accepted.*"grace_ms":30000/u);
  assert.match(logs, /session submission-deadline.*"grace_ms":30000/u);
  assert.match(logs, /session submission-finalized.*"mcp_status_checked":true/u);
  assert.match(logs, /session submission-finalized.*"token_accounting_complete":false/u);
  assert.match(logs, /session cleanup.*"outcome":"success"/u);
});

test("accepted stalled submissions win an interruption result while MCP status is pending", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
  const ready = manualSignal<undefined>();
  const mcpStarted = manualSignal<undefined>();
  const resultYielded = manualSignal<undefined>();
  const closed = manualSignal<undefined>();
  let interrupts = 0;
  let closes = 0;
  let mcpStatusChecks = 0;
  const query = ((input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: Options;
  }) => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
      const messages = input.prompt[Symbol.asyncIterator]();
      assert.equal((await messages.next()).done, false);
      assert.equal((await messages.next()).done, false);
      await completeReviewContext(input.options);
      const submit = reviewOutputTools(input.options).submit_review;
      assert.ok(submit);
      const accepted = await submit.handler({
        limitations: [],
        summary: "No issues",
        findings: [],
      });
      assert.equal(accepted.content[0]?.text, "Review submission accepted.");
      ready.resolve(undefined);
      await mcpStarted.promise;
      resultYielded.resolve(undefined);
      yield resultMessage(1, "error_during_execution");
      await closed.promise;
    },
    mcpServerStatus: () => {
      mcpStatusChecks += 1;
      mcpStarted.resolve(undefined);
      return new Promise<readonly never[]>(() => undefined);
    },
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
    "Check accepted stall precedence.",
    0,
    goalContext,
    [],
    emptyConversation,
    reviewConfig({ mcpServers: { security: { type: "http", url: "https://mcp.example.test" } } }),
    await makeReviewDiff(t),
    "/workspace/repository",
    query,
  );
  await ready.promise;
  t.mock.timers.tick(agentInternals.SDK_SUBMISSION_GRACE_MS);
  await mcpStarted.promise;
  await resultYielded.promise;
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  const result = await running;

  assert.equal(result.status, "failed");
  assert.deepEqual(result.submission, {
    summary: "No issues",
    findings: [],
    limitations: [],
  });
  assert.match(result.error ?? "", /MCP status check timed out after 30000 ms/u);
  assert.equal(mcpStatusChecks, 1);
  assert.equal(interrupts, 1);
  assert.equal(closes, 1);
});

test("lets an accepted submission win an interrupted turn boundary", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
  const ready = manualSignal<undefined>();
  const boundary = manualSignal<undefined>();
  let interrupts = 0;
  let closes = 0;
  let extraPrompt = false;
  let mcpStatusChecks = 0;
  const query = ((input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: Options;
  }) => ({
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
      const messages = input.prompt[Symbol.asyncIterator]();
      assert.equal((await messages.next()).done, false);
      assert.equal((await messages.next()).done, false);
      await completeReviewContext(input.options);
      ready.resolve(undefined);
      await boundary.promise;
      const submit = reviewOutputTools(input.options).submit_review;
      assert.ok(submit);
      const accepted = await submit.handler({
        limitations: [],
        summary: "Accepted during interrupt",
        findings: [],
      });
      assert.equal(accepted.content[0]?.text, "Review submission accepted.");
      yield resultMessage(1, "error_during_execution");
      const next = await messages.next();
      extraPrompt = !next.done;
    },
    mcpServerStatus: () => {
      mcpStatusChecks += 1;
      return Promise.resolve([]);
    },
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
  assert.equal(mcpStatusChecks, 1);
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
      await completeReviewContext(input.options);
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
      const accepted = await submit.handler({
        limitations: [],
        summary: "Recovered",
        findings: [],
      });
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

test("bounds accepted goal finalization without hiding failures", async (t) => {
  for (const mode of [
    "activity",
    "natural",
    "provider-failure",
    "mcp-failure",
    "mcp-auth",
    "missing",
    "pending",
    "disabled",
    "unknown",
    "natural-missing",
    "natural-pending",
    "natural-disabled",
    "natural-unknown",
    "mcp-timeout",
    "natural-mcp-timeout",
    "reader-timeout",
    "reader-failure",
    "natural-reader-failure",
    "close-failure",
    "interrupt-failure",
    "interrupt-pending",
    "cancellation",
  ] as const) {
    await t.test(mode, async (st) => {
      st.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
      const logs: string[] = [];
      st.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
        logs.push(chunk.toString());
        return true;
      });
      const ready = manualSignal<undefined>();
      const activity = manualSignal<undefined>();
      const observed = manualSignal<undefined>();
      const terminal = manualSignal<undefined>();
      const statusStarted = manualSignal<undefined>();
      const closing = manualSignal<undefined>();
      const closed = manualSignal<undefined>();
      const controller = new AbortController();
      let interrupts = 0;
      let closes = 0;
      let checks = 0;
      const natural = mode.startsWith("natural") || mode === "provider-failure";
      const readerFails = mode.endsWith("reader-failure") || mode === "cancellation";
      const unavailable = mode.replace("natural-", "");
      const pendingStatus = ["mcp-timeout", "natural-mcp-timeout", "cancellation"].includes(mode);
      const query = ((input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
          const messages = input.prompt[Symbol.asyncIterator]();
          await messages.next();
          await messages.next();
          await completeReviewContext(input.options);
          const submit = reviewOutputTools(input.options).submit_review;
          assert.ok(submit);
          await submit.handler({
            limitations: [],
            summary: "Accepted evidence",
            findings: [],
          });
          ready.resolve(undefined);
          if (mode === "activity") {
            await activity.promise;
            yield {
              type: "assistant",
              message: { content: [{ type: "text", text: "Still reading" }] },
            } as SDKMessage;
            const duplicate = await submit.handler({
              limitations: [],
              summary: "Replacement",
              findings: [],
            });
            assert.match(duplicate.content[0]?.text ?? "", /already been accepted/u);
            observed.resolve(undefined);
          }
          if (natural) {
            yield resultMessage(
              1,
              mode === "provider-failure" ? "error_during_execution" : "success",
            );
            terminal.resolve(undefined);
          }
          await closed.promise;
          assert.equal((await messages.next()).done, true);
          if (readerFails) throw new Error("reader failed during shutdown");
        },
        mcpServerStatus: () => {
          checks += 1;
          statusStarted.resolve(undefined);
          if (pendingStatus) return new Promise<readonly never[]>(() => undefined);
          if (unavailable === "missing") return Promise.resolve([]);
          if (["pending", "disabled", "unknown"].includes(unavailable)) {
            return Promise.resolve([{ name: "security", status: unavailable }]);
          }
          return Promise.resolve(
            mode === "mcp-failure" || mode === "mcp-auth"
              ? [
                  {
                    name: "security",
                    status: mode === "mcp-auth" ? "needs-auth" : "failed",
                    error: "context unavailable",
                  },
                ]
              : [{ name: "security", status: "connected" }],
          );
        },
        interrupt: () => {
          interrupts += 1;
          if (mode === "interrupt-pending") return new Promise<never>(() => undefined);
          if (mode === "interrupt-failure")
            return Promise.reject(new Error("interrupt unavailable"));
          return Promise.resolve({ still_queued: [] });
        },
        close: () => {
          closes += 1;
          closing.resolve(undefined);
          if (mode === "close-failure") throw new Error("close failed");
          if (mode !== "reader-timeout") closed.resolve(undefined);
        },
      })) as unknown as AgentQuery;
      const running = runReviewGoal(
        "Check completion bounds.",
        0,
        goalContext,
        [],
        emptyConversation,
        reviewConfig({
          mcpServers: { security: { type: "http", url: "https://mcp.example.test" } },
        }),
        await makeReviewDiff(st),
        "/workspace/repository",
        query,
        [],
        controller,
      );
      await ready.promise;
      if (natural) await terminal.promise;
      else if (mode === "activity") {
        st.mock.timers.tick(agentInternals.SDK_SUBMISSION_GRACE_MS - 1);
        activity.resolve(undefined);
        await observed.promise;
        assert.equal(closes, 0);
        st.mock.timers.tick(1);
      } else st.mock.timers.tick(agentInternals.SDK_SUBMISSION_GRACE_MS);
      if (pendingStatus) {
        await statusStarted.promise;
        if (mode === "cancellation") {
          const cancellation = new CancellationError("SIGTERM");
          const rejected = assert.rejects(running, (error: unknown) => error === cancellation);
          controller.abort(cancellation);
          st.mock.timers.tick(30_000);
          await rejected;
          assert.equal(closes, 1);
          assert.equal(checks, 1);
          return;
        }
        st.mock.timers.tick(30_000);
      }
      if (mode === "reader-timeout") {
        await closing.promise;
        st.mock.timers.tick(agentInternals.SDK_SESSION_CLOSE_MS);
      }
      const result = await running;
      closed.resolve(undefined);
      const expectedError = readerFails
        ? /reader failed during shutdown/u
        : mode === "provider-failure"
          ? /interrupted 1/u
          : ["missing", "pending", "disabled", "unknown"].includes(unavailable)
            ? /Configured MCP server failure: security: (status unavailable|pending|disabled|unknown)/u
            : mode === "mcp-failure" || mode === "mcp-auth"
              ? /context unavailable/u
              : pendingStatus
                ? /MCP status check timed out after 30000 ms/u
                : mode === "reader-timeout"
                  ? /reader did not stop within 5000 ms/u
                  : mode === "close-failure"
                    ? /close failed/u
                    : undefined;
      assert.equal(result.status, expectedError === undefined ? "completed" : "failed");
      if (expectedError !== undefined) assert.match(result.error ?? "", expectedError);
      assert.equal(result.submission?.summary, "Accepted evidence");
      assert.equal(result.tokenUsage?.complete, natural && !readerFails);
      assert.equal(closes, 1);
      assert.equal(checks, mode === "provider-failure" ? 0 : 1);
      assert.equal(interrupts, natural ? 0 : 1);
      assert.equal(controller.signal.aborted, false);
      const eventCount = logs.length;
      st.mock.timers.tick(agentInternals.SDK_SESSION_STALL_MS);
      assert.equal(logs.length, eventCount);
    });
  }
});

test("closing one accepted goal preserves an unfinished sibling on the shared controller", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
  const controller = new AbortController();
  const ready = [manualSignal<undefined>(), manualSignal<undefined>()];
  const closed = [manualSignal<undefined>(), manualSignal<undefined>()];
  const siblingMaySubmit = manualSignal<undefined>();
  const closes = [0, 0];
  const running = await Promise.all(
    [0, 1].map(async (index) => {
      const query = ((input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => ({
        async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
          const messages = input.prompt[Symbol.asyncIterator]();
          await messages.next();
          await messages.next();
          await completeReviewContext(input.options);
          if (index === 1) {
            ready[index]?.resolve(undefined);
            await siblingMaySubmit.promise;
          }
          await reviewOutputTools(input.options).submit_review?.handler({
            limitations: [],
            summary: `Goal ${index}`,
            findings: [],
          });
          ready[index]?.resolve(undefined);
          if (index === 1) yield resultMessage(1);
          await closed[index]?.promise;
        },
        mcpServerStatus: () => Promise.resolve([]),
        interrupt: () => Promise.resolve(undefined),
        close: () => {
          closes[index] = (closes[index] ?? 0) + 1;
          closed[index]?.resolve(undefined);
        },
      })) as unknown as AgentQuery;
      return {
        result: runReviewGoal(
          "Concurrent goal",
          index,
          goalContext,
          [],
          emptyConversation,
          reviewConfig(),
          await makeReviewDiff(t),
          "/workspace/repository",
          query,
          [],
          controller,
        ),
      };
    }),
  );
  await Promise.all(ready.map((item) => item.promise));
  t.mock.timers.tick(agentInternals.SDK_SUBMISSION_GRACE_MS);
  assert.equal((await running[0]?.result)?.status, "completed");
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(closes, [1, 0]);
  siblingMaySubmit.resolve(undefined);
  assert.equal((await running[1]?.result)?.status, "completed");
  assert.deepEqual(closes, [1, 1]);
});
