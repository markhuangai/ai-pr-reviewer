import { strict as assert } from "node:assert";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  HookInput,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ProviderRecovery,
  SdkSessionMonitor,
  waitForProviderRetry,
} from "../src/runtime/session-recovery.js";
import {
  createDeferred,
  createReviewGoalsRunner,
  type AgentQuery,
} from "../src/runtime/agent-session.js";
import { runReviewGoal } from "../src/runtime/agent.js";
import { runSharedDiscovery } from "../src/runtime/shared-discovery.js";
import { aggregateReview, buildReviewBody } from "../src/lib/aggregate.js";
import { readPullRequestFilesFromSnapshots } from "../src/lib/git-changed-files.js";
import { emptyConversation } from "./agent-test-helpers.js";
import { makeReplayRepository } from "./git-test-helpers.js";
import {
  protocolBriefing,
  protocolResult,
  recoveryConfig,
  recoveryRepository,
  reviewProtocolQuery,
  recoveryState,
  recoverySubmission,
  protocolDocument,
} from "./review-protocol-test-helpers.js";

function providerError(status?: number | null): SDKResultMessage {
  return {
    ...protocolResult(),
    subtype: "success",
    is_error: true,
    result: "Provider unavailable",
    ...(status === undefined ? {} : { api_error_status: status }),
  };
}

test("classifies SDK provider errors from metadata and bounds retry delays", () => {
  for (const status of [
    429,
    500,
    502,
    503,
    504,
    524,
    529,
    null,
    400,
    401,
    403,
    404,
    501,
    505,
    undefined,
  ]) {
    const provider = new ProviderRecovery();
    const result = providerError(status);
    provider.observe(result);
    const failure = provider.failure(result);
    assert.ok(failure);
    const retryable = status === null || [429, 500, 502, 503, 504, 524, 529].includes(status ?? 0);
    assert.equal(failure.retryable, retryable, String(status));
    if (!retryable) {
      assert.equal(provider.retryDelay(failure), undefined);
      continue;
    }
    const first = provider.retryDelay(failure);
    const second = provider.retryDelay(failure);
    assert.ok(first !== undefined && first >= 120_000 && first <= 135_000);
    assert.ok(second !== undefined && second >= 240_000 && second <= 255_000);
    assert.equal(provider.retryDelay(failure), undefined);
  }
  for (const error of [
    "authentication_failed",
    "billing_error",
    "invalid_request",
    "model_not_found",
    "server_error",
    "overloaded",
    "rate_limit",
    "unknown",
  ] as const) {
    const provider = new ProviderRecovery();
    provider.observe({ type: "assistant", error } as SDKMessage);
    const result = providerError();
    provider.observe(result);
    assert.equal(
      provider.failure(result)?.retryable,
      ["server_error", "overloaded", "rate_limit"].includes(error),
    );
    const next = providerError();
    provider.observe(next);
    assert.equal(provider.failure(next)?.retryable, false, "metadata must not leak across turns");
  }
});

test("does not classify SDK limits or interruptions as provider errors", () => {
  const provider = new ProviderRecovery();
  for (const subtype of ["success", "error_max_turns", "error_during_execution"]) {
    const result = protocolResult(subtype);
    provider.observe(result);
    assert.equal(provider.failure(result), undefined);
  }
  provider.observe({
    type: "system",
    subtype: "api_retry",
    error_status: null,
    error: "unknown",
  } as SDKMessage);
  const result = protocolResult("error_during_execution");
  provider.observe(result);
  assert.equal(provider.failure(result)?.retryable, true);
});

test("final Codex metadata supersedes an earlier transient retry", () => {
  for (const [info, retryable] of [
    ["unauthorized", false],
    ["usageLimitExceeded", false],
    ["sessionBudgetExceeded", false],
    ["badRequest", false],
    ["contextWindowExceeded", false],
    ["other", false],
    [null, false],
    ["rateLimitExceeded", true],
    ["serverOverloaded", true],
    ["flexUnavailable", true],
    ["internalServerError", true],
    [{ httpConnectionFailed: { httpStatusCode: 401 } }, false],
    [{ responseStreamConnectionFailed: { httpStatusCode: 402 } }, false],
    [{ responseTooManyFailedAttempts: { httpStatusCode: 500 } }, true],
    [{ responseStreamDisconnected: { httpStatusCode: null } }, true],
    [{ httpConnectionFailed: { httpStatusCode: "500" } }, false],
    [{ httpConnectionFailed: {} }, false],
    [{ unsupported: { httpStatusCode: 500 } }, false],
  ] as const) {
    const provider = new ProviderRecovery();
    provider.observe({
      type: "system",
      subtype: "api_retry",
      error: "server_error",
      error_status: 500,
    } as SDKMessage);
    const result = {
      ...protocolResult("error_during_execution"),
      codex_error: { codexErrorInfo: info },
    };
    provider.observe(result);
    const failure = provider.failure(result);
    assert.ok(failure);
    assert.equal(failure.retryable, retryable, JSON.stringify(info));
    assert.equal(provider.retryDelay(failure) !== undefined, retryable);
  }
});

test("provider backoff is immediately cancellable", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const reason = new Error("cancel review");
  const waiting = waitForProviderRetry(120_000, controller.signal);
  controller.abort(reason);
  await assert.rejects(waiting, (error) => error === reason);
  await assert.rejects(
    waitForProviderRetry(120_000, controller.signal),
    (error) => error === reason,
  );
  t.mock.timers.tick(120_000);
});

test("accepted output ends provider backoff without waiting for its timer", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const accepted = createDeferred<undefined>();
  const waiting = waitForProviderRetry(120_000, undefined, accepted.promise);
  accepted.resolve(undefined);
  await waiting;
  assert.equal(Date.now(), 0);
  t.mock.timers.tick(120_000);
});

test("inspection progress bounds busy sessions and interrupted turns", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  let progress = 0;
  const stalls: number[] = [];
  const failures: string[] = [];
  const monitor = new SdkSessionMonitor({
    snapshot: () => ({}),
    write: () => undefined,
    progress: () => progress,
    onStall: (stall) => {
      stalls.push(stall.recovery);
    },
    onRecoveryFailure: (reason) => {
      failures.push(reason);
    },
  });
  monitor.start();
  for (let minute = 0; minute < 9; minute++) {
    t.mock.timers.tick(60_000);
    monitor.observe({ type: "system", subtype: "status" });
  }
  progress++;
  monitor.observeProgress();
  for (let minute = 0; minute < 9; minute++) {
    t.mock.timers.tick(60_000);
    monitor.observe({ type: "system" });
  }
  assert.deepEqual(stalls, []);
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.deepEqual(stalls, [1]);
  t.mock.timers.tick(29_999);
  assert.deepEqual(failures, []);
  t.mock.timers.tick(1);
  assert.deepEqual(failures, ["interrupt-timeout"]);
  monitor.stop();
});

test("two stalled-turn recoveries are allowed and backoff pauses both watchdogs", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const failures: string[] = [];
  let stalls = 0;
  const monitor = new SdkSessionMonitor({
    snapshot: () => ({}),
    write: () => undefined,
    progress: () => 0,
    onStall: () => {
      stalls++;
    },
    onRecoveryFailure: (reason) => {
      failures.push(reason);
    },
  });
  monitor.start();
  monitor.pause();
  monitor.pause();
  t.mock.timers.tick(1_000_000);
  await Promise.resolve();
  assert.equal(stalls, 0);
  monitor.resume();
  monitor.resume();
  for (let index = 0; index < 2; index++) {
    t.mock.timers.tick(300_000);
    await Promise.resolve();
    assert.equal(stalls, index + 1);
    monitor.interruptedTurnFinished();
  }
  t.mock.timers.tick(300_000);
  assert.deepEqual(failures, ["stall-recovery-exhausted"]);
  assert.equal(stalls, 2);
});

test("new authorized context pages keep a long investigation progressing", async (t) => {
  const repository = await recoveryRepository(t);
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  const path = join(repository.temporaryRoot, "context.txt");
  const content = "context evidence\n".repeat(2_000);
  await writeFile(path, content);
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const query = reviewProtocolQuery(async function* (protocol) {
    yield* protocolBriefing(protocol);
    for (let page = 0; page < 4; page++) {
      for (let minute = 0; minute < 4; minute++) {
        t.mock.timers.tick(60_000);
        yield { type: "system", subtype: "status", status: null } as SDKMessage;
      }
      const result = protocolDocument(yield* protocol.call("read_context_file", { path }));
      assert.ok(typeof result.content === "string" && result.content.length > 0);
    }
    yield* protocol.call("read_pr_diff", { remaining: true });
    yield* protocol.call("submit_review", { summary: "Inspected", findings: [], limitations: [] });
    yield protocolResult();
  });
  const result = await runReviewGoal(
    "check",
    0,
    repository.context,
    files,
    emptyConversation,
    recoveryConfig(),
    repository.diff,
    repository.root,
    query,
    [
      {
        path,
        snapshotPath: path,
        sizeBytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ],
  );
  assert.equal(result.status, "completed");
  assert.equal(result.diagnostics?.stallRecoveries, 0);
});

for (const repeated of [false, true]) {
  test(`${repeated ? "repeated" : "new"} native caller reads ${repeated ? "trigger recovery" : "reset progress"} after the required sweep`, async (t) => {
    const repository = await recoveryRepository(t);
    const files = await readPullRequestFilesFromSnapshots(
      repository.context,
      repository.root,
      repository.baseSha,
    );
    const path = join(repository.root, "caller.ts");
    await writeFile(path, Array.from({ length: 4 }, (_, index) => `caller${index}();`).join("\n"));
    const lines = (await readFile(path, "utf8")).split("\n");
    t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
    const query = reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      yield* protocol.call("read_pr_diff", { remaining: true });
      const deliver = async (startLine: number) => {
        const observation: HookInput = {
          hook_event_name: "PostToolBatch",
          session_id: "native-progress",
          transcript_path: "",
          cwd: repository.root,
          tool_calls: [
            {
              tool_name: "Read",
              tool_use_id: `native-${Date.now()}`,
              tool_input: { file_path: path, offset: startLine, limit: 1 },
              tool_response: {
                type: "text",
                file: {
                  filePath: path,
                  content: lines[startLine - 1],
                  numLines: 1,
                  startLine,
                  totalLines: lines.length,
                },
              },
            },
          ],
        };
        for (const matcher of protocol.options.hooks?.PostToolBatch ?? [])
          for (const hook of matcher.hooks)
            await hook(observation, undefined, { signal: new AbortController().signal });
      };
      await deliver(1);
      for (let minute = 1; minute <= (repeated ? 10 : 16); minute++) {
        t.mock.timers.tick(60_000);
        yield { type: "system", subtype: "status", status: null } as SDKMessage;
        if (minute % 4 === 0 && minute < 16) await deliver(repeated ? 1 : minute / 4 + 1);
      }
      if (repeated) {
        yield protocolResult("error_during_execution");
        const continuation = await protocol.messages.next();
        assert.equal(continuation.done, false);
        assert.match(JSON.stringify(continuation.value), /interrupted/u);
      }
      yield* protocol.call("submit_review", {
        summary: "Inspected",
        findings: [],
        limitations: [],
      });
      yield protocolResult();
    });
    const result = await runReviewGoal(
      "check",
      0,
      repository.context,
      files,
      emptyConversation,
      recoveryConfig(),
      repository.diff,
      repository.root,
      query,
    );
    assert.equal(result.status, "completed");
    assert.equal(result.diagnostics?.stallRecoveries, repeated ? 1 : 0);
    assert.equal(result.diagnostics?.validationFailures, 0);
  });
}

test("a provider retry resumes the same goal without spending inspection corrections", async (t) => {
  const repository = await recoveryRepository(t);
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  const schedule = globalThis.setTimeout;
  const delays: number[] = [];
  t.mock.method(
    globalThis,
    "setTimeout",
    (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
      if (milliseconds !== undefined && milliseconds >= 120_000 && milliseconds <= 255_000) {
        delays.push(milliseconds);
        return schedule(callback, 1, ...args);
      }
      return schedule(callback, milliseconds, ...args);
    },
  );
  let resumed = 0;
  const query = reviewProtocolQuery(async function* (protocol) {
    yield* protocolBriefing(protocol);
    yield* protocol.call("read_pr_diff", { remaining: true });
    for (let index = 0; index < 2; index++) {
      yield providerError(500);
      const next = await protocol.messages.next();
      assert.equal(next.done, false);
      resumed++;
    }
    yield* protocol.call("submit_review", { summary: "Inspected", findings: [], limitations: [] });
    yield protocolResult();
  });
  const result = await runReviewGoal(
    "check",
    0,
    repository.context,
    files,
    emptyConversation,
    recoveryConfig(),
    repository.diff,
    repository.root,
    query,
  );
  assert.equal(result.status, "completed");
  assert.equal(resumed, 2);
  assert.equal(delays.length, 2);
  assert.equal(result.diagnostics?.inspectionContinuations, 0);
  assert.equal(result.diagnostics?.validationFailures, 0);
});

test("unrecoverable provider errors stop the real goal without a repair turn", async (t) => {
  const repository = await recoveryRepository(t);
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  const ended = createDeferred<undefined>();
  const query = reviewProtocolQuery(async function* (protocol) {
    yield providerError(401);
    await protocol.closed;
    assert.equal((await protocol.messages.next()).done, true);
    ended.resolve(undefined);
  });
  const result = await runReviewGoal(
    "check",
    0,
    repository.context,
    files,
    emptyConversation,
    recoveryConfig(),
    repository.diff,
    repository.root,
    query,
  );
  await ended.promise;
  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics?.termination, "provider-error");
  assert.equal(result.diagnostics?.inspectionContinuations, 0);
});

test("exhausted provider recovery retains findings and the last valid cumulative usage", async (t) => {
  const repository = await recoveryRepository(t);
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  const schedule = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    "setTimeout",
    (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) =>
      schedule(
        callback,
        milliseconds !== undefined && milliseconds >= 120_000 && milliseconds <= 255_000
          ? 1
          : milliseconds,
        ...args,
      ),
  );
  const query = reviewProtocolQuery(async function* (protocol) {
    yield* protocolBriefing(protocol);
    yield* protocol.call("read_pr_diff", { paths: ["review.txt"] });
    const state = yield* recoveryState(protocol, ["review.txt"]);
    const evidence = state.evidence.find(
      (entry) => entry.status === "complete" && entry.paths?.includes("review.txt"),
    );
    assert.ok(evidence);
    assert.equal(
      (yield* protocol.call("submit_review", recoverySubmission(evidence.id))).isError,
      true,
    );
    yield {
      ...protocolResult(),
      modelUsage: {
        "review-model": {
          inputTokens: 100,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0,
          contextWindow: 200_000,
          maxOutputTokens: 32_000,
        },
      },
    };
    await protocol.messages.next();
    for (let index = 0; index < 3; index++) {
      yield providerError(524);
      if (index < 2) assert.equal((await protocol.messages.next()).done, false);
    }
    await protocol.closed;
  });
  const config = recoveryConfig({ autoApprove: true, interactWithPullRequest: true });
  const result = await runReviewGoal(
    "check",
    0,
    repository.context,
    files,
    emptyConversation,
    config,
    repository.diff,
    repository.root,
    query,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics?.termination, "provider-retries-exhausted");
  assert.equal(result.diagnostics?.providerRetries, 2);
  assert.equal(result.diagnostics?.inspectionContinuations, 1);
  assert.equal(result.diagnostics?.validationFailures, 0);
  assert.equal(result.submission?.findings.length, 1);
  assert.equal(result.tokenUsage?.models[0]?.inputTokens, 100);
  assert.equal(result.tokenUsage?.complete, false);
  const review = aggregateReview(repository.context, config, files, [result]);
  assert.equal(review.partial, true);
  assert.equal(review.event, "COMMENT");
  const body = buildReviewBody(review, [result]);
  assert.match(body, /two automatic retries/u);
  assert.match(body, /Provider HTTP 524/u);
});

test("cancelling the run during provider backoff closes its session without another request", async (t) => {
  const repository = await recoveryRepository(t);
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  const controller = new AbortController();
  const started = createDeferred<undefined>();
  const schedule = globalThis.setTimeout;
  t.mock.method(
    globalThis,
    "setTimeout",
    (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
      if (milliseconds !== undefined && milliseconds >= 120_000 && milliseconds <= 135_000)
        started.resolve(undefined);
      return schedule(callback, milliseconds, ...args);
    },
  );
  const query = reviewProtocolQuery(async function* (protocol) {
    yield providerError(429);
    await protocol.closed;
    assert.equal((await protocol.messages.next()).done, true);
  });
  const running = runReviewGoal(
    "check",
    0,
    repository.context,
    files,
    emptyConversation,
    recoveryConfig(),
    repository.diff,
    repository.root,
    query,
    [],
    controller,
  );
  const stopped = assert.rejects(running, /cancel during backoff/u);
  await started.promise;
  controller.abort(new Error("cancel during backoff"));
  await stopped;
});

for (const discovery of [false, true]) {
  test(`${discovery ? "discovery" : "review"} acceptance during backoff never queues another turn`, async (t) => {
    const repository = await recoveryRepository(t);
    const files = await readPullRequestFilesFromSnapshots(
      repository.context,
      repository.root,
      repository.baseSha,
    );
    const started = createDeferred<undefined>();
    const schedule = globalThis.setTimeout;
    t.mock.method(
      globalThis,
      "setTimeout",
      (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
        if (milliseconds !== undefined && milliseconds >= 120_000 && milliseconds <= 135_000)
          started.resolve(undefined);
        return schedule(callback, milliseconds, ...args);
      },
    );
    const baseQuery = reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      yield* protocol.call("read_pr_diff", { remaining: true });
      yield* protocol.call("submit_review", {
        summary: "Inspected",
        findings: [],
        limitations: [],
      });
      yield protocolResult();
    });
    let prompts: AsyncIterator<SDKUserMessage> | undefined;
    const query: AgentQuery = (input) => {
      assert.notEqual(typeof input.prompt, "string");
      prompts = (input.prompt as AsyncIterable<SDKUserMessage>)[Symbol.asyncIterator]();
      const session = baseQuery(input);
      const messages = session[Symbol.asyncIterator]();
      let failed = false;
      return Object.assign(session, {
        async *[Symbol.asyncIterator]() {
          for await (const message of messages) {
            if (
              !failed &&
              message.type === "assistant" &&
              message.message.content.some(
                (part) =>
                  part.type === "tool_use" &&
                  part.name ===
                    `mcp__review_output__${discovery ? "finish_discovery" : "submit_review"}`,
              )
            ) {
              failed = true;
              yield providerError(500);
              await started.promise;
            }
            yield message;
          }
        },
      });
    };
    const config = recoveryConfig({ autoApprove: true });
    if (discovery) {
      const result = await runSharedDiscovery({
        context: repository.context,
        files,
        conversation: emptyConversation,
        config,
        diff: repository.diff,
        cwd: repository.root,
        queryAgent: query,
        abortController: undefined,
        briefing: { linkedIssues: [], linkedIssueReferencesTruncated: false },
      });
      assert.equal(result.result.status, "failed");
      assert.equal(result.result.diagnostics.termination, "provider-error");
      assert.equal(result.seed, undefined);
    } else {
      const result = await runReviewGoal(
        "check",
        0,
        repository.context,
        files,
        emptyConversation,
        config,
        repository.diff,
        repository.root,
        query,
      );
      assert.equal(result.status, "failed");
      assert.equal(result.diagnostics?.termination, "provider-error");
      assert.ok(result.submission);
      assert.equal(aggregateReview(repository.context, config, files, [result]).event, "COMMENT");
    }
    assert.ok(prompts);
    assert.equal((await prompts.next()).done, true);
  });
}

test("five completed goals survive an unfinished sibling whose interrupt never completes", async (t) => {
  const repository = await makeReplayRepository(t);
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: 0 });
  const ready = createDeferred<undefined>();
  const fiveDone = createDeferred<undefined>();
  const calls = [0, 0, 0, 0, 0, 0];
  let completed = 0;
  const healthy = reviewProtocolQuery(async function* (protocol) {
    yield* protocolBriefing(protocol);
    yield* protocol.call("read_pr_diff", { remaining: true });
    yield* protocol.call("submit_review", { summary: "Inspected", findings: [], limitations: [] });
    yield protocolResult();
  });
  const stalled = reviewProtocolQuery(async function* (protocol) {
    yield* protocolBriefing(protocol);
    ready.resolve(undefined);
    await protocol.closed;
  });
  const runner = createReviewGoalsRunner(
    async (...args) => {
      const index = args[1];
      calls[index] = (calls[index] ?? 0) + 1;
      args[8] = index === 5 ? stalled : healthy;
      const result = await runReviewGoal(...args);
      if (result.status === "completed" && ++completed === 5) fiveDone.resolve(undefined);
      return result;
    },
    healthy,
    runSharedDiscovery,
  );
  const config = recoveryConfig({
    autoApprove: true,
    parallelCount: 6,
    reviewPrompts: calls.map((_, index) => ({ prompt: `goal ${index}`, files: [] })),
  });
  const running = runner(
    repository.context,
    files,
    emptyConversation,
    config,
    calls.map(() => []),
    repository.root,
  );
  await Promise.all([ready.promise, fiveDone.promise]);
  t.mock.timers.tick(300_000);
  for (let index = 0; index < 4; index++) await Promise.resolve();
  t.mock.timers.tick(30_000);
  const run = await running;
  assert.deepEqual(calls, [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(
    run.goals.map((goal) => goal.status),
    ["completed", "completed", "completed", "completed", "completed", "failed"],
  );
  assert.equal(run.goals[5]?.diagnostics?.termination, "interrupt-timeout");
  assert.ok(run.discovery);
  const review = aggregateReview(repository.context, config, files, run.goals, {
    discovery: run.discovery,
  });
  assert.equal(review.partial, true);
  assert.equal(review.event, "COMMENT");
  assert.match(buildReviewBody(review, run.goals), /5 of 6 checks completed/u);
});
