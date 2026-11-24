import { strict as assert } from "node:assert";
import test from "node:test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ChangedFile } from "../src/lib/types.js";
import { writeNamedSessionLifecycleLog } from "../src/runtime/agent-logging.js";
import { ReviewEvidenceLedger } from "../src/runtime/review-assessment.js";
import { SDK_SUBMISSION_GRACE_MS } from "../src/runtime/session-recovery.js";
import { SessionRunner, createDeferred, makeUserMessage } from "../src/runtime/session-runner.js";
import { protocolResult } from "./review-protocol-test-helpers.js";

const noMcpServers = () => Promise.resolve([]);
const noInterrupt = () => Promise.resolve(undefined);
const noLog = () => undefined;

test("buffers terminal results in stream order and bounds close to one invocation", async () => {
  const observed = createDeferred<undefined>();
  const first = { ...protocolResult(), num_turns: 1 };
  const second = { ...protocolResult(), num_turns: 2 };
  const runner = new SessionRunner({ streamEnded: "Reader ended", write: noLog });
  let closes = 0;
  runner.start(
    (prompts) => ({
      async *[Symbol.asyncIterator]() {
        const input = await prompts[Symbol.asyncIterator]().next();
        assert.ok(!input.done);
        assert.equal(input.value.message.content, "Start the review");
        yield first;
        yield second;
      },
      close: () => {
        closes++;
      },
      interrupt: noInterrupt,
      mcpServerStatus: noMcpServers,
    }),
    (message) => {
      if (message === second) observed.resolve(undefined);
      return undefined;
    },
  );
  try {
    runner.prompts.push(makeUserMessage("Start the review"));
    await observed.promise;
    const firstTurn = await runner.waitForTurn();
    const secondTurn = await runner.waitForTurn();
    assert.equal(firstTurn.kind === "result" && firstTurn.result, first);
    assert.equal(secondTurn.kind === "result" && secondTurn.result, second);
    await assert.rejects(runner.waitForTurn(), /Reader ended/u);
    await Promise.all([runner.close(), runner.close()]);
    assert.equal(closes, 1);
    assert.equal(runner.closed, true);
  } finally {
    runner.dispose();
  }
});

test("cancellation wins over an already buffered result", async () => {
  const controller = new AbortController();
  const observed = createDeferred<undefined>();
  const runner = new SessionRunner({
    signal: controller.signal,
    streamEnded: "Reader ended",
    write: noLog,
  });
  const reason = new Error("Review cancelled");
  runner.start(
    () => ({
      async *[Symbol.asyncIterator]() {
        yield* [protocolResult()];
        await observed.promise;
      },
      close: () => undefined,
      interrupt: noInterrupt,
      mcpServerStatus: noMcpServers,
    }),
    () => {
      observed.resolve(undefined);
      return undefined;
    },
  );
  try {
    await observed.promise;
    controller.abort(reason);
    await assert.rejects(runner.waitForTurn(), (error: unknown) => error === reason);
  } finally {
    await runner.close();
    runner.dispose();
  }
});

test("the default logger records one acceptance deadline and bounded finalization", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 0 });
  const readerClosed = createDeferred<undefined>();
  let interrupts = 0;
  let checks = 0;
  const runner = new SessionRunner({
    streamEnded: "Reader ended",
    write: (event, details) => {
      writeNamedSessionLifecycleLog("runner fixture", event, details, []);
    },
    watchdog: { kind: "review", snapshot: () => ({ session_id: "runner-fixture" }) },
  });
  runner.start(
    () => ({
      async *[Symbol.asyncIterator]() {
        await readerClosed.promise;
        yield* [];
      },
      close: () => {
        readerClosed.resolve(undefined);
      },
      interrupt: () => {
        interrupts++;
        return Promise.resolve(undefined);
      },
      mcpServerStatus: noMcpServers,
    }),
    noLog,
  );
  try {
    runner.acceptOutput();
    t.mock.timers.tick(SDK_SUBMISSION_GRACE_MS - 1);
    runner.acceptOutput();
    assert.equal(interrupts, 0);
    t.mock.timers.tick(1);
    assert.deepEqual(await runner.waitForTurn(), { kind: "accepted-after-grace" });
    await runner.finish(() => {
      checks++;
      return Promise.resolve();
    });
    assert.equal(interrupts, 1);
    assert.equal(checks, 1);
    assert.equal(runner.closed, true);
  } finally {
    runner.dispose();
  }
});

test("discovery still needs a terminal result after accepting a change map", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const controller = new AbortController();
  const reason = new Error("Discovery deadline");
  const runner = new SessionRunner({
    streamEnded: "Reader ended",
    write: noLog,
    deadline: { controller, milliseconds: 600_000, reason },
  });
  runner.start(
    (prompts) => ({
      async *[Symbol.asyncIterator]() {
        await prompts[Symbol.asyncIterator]().next();
        yield* [];
      },
      close: () => undefined,
      interrupt: () => assert.fail("Discovery did not request an early interrupt"),
      mcpServerStatus: noMcpServers,
    }),
    noLog,
  );
  try {
    runner.acceptOutput();
    const turn = runner.waitForTurn();
    t.mock.timers.tick(SDK_SUBMISSION_GRACE_MS);
    assert.equal(controller.signal.aborted, false);
    const rejected = assert.rejects(turn, (error: unknown) => error === reason);
    t.mock.timers.tick(600_000 - SDK_SUBMISSION_GRACE_MS);
    await rejected;
  } finally {
    await runner.close();
    runner.dispose();
  }
});

test("streamed text reads cached inspection progress after delivery and reset", async () => {
  const files: ChangedFile[] = [
    {
      path: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      addedLines: new Set([1]),
    },
  ];
  let scans = 0;
  const countedFiles = new Proxy(files, {
    get(target, property, receiver): unknown {
      if (property === "flatMap") scans++;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const ledger = new ReviewEvidenceLedger("/workspace", countedFiles, {
    mergeBaseSha: "a".repeat(40),
    headSha: "b".repeat(40),
  });
  const delta: SDKMessage = {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "token" } },
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "progress-fixture",
  };
  const runner = new SessionRunner({
    streamEnded: "Reader ended",
    write: noLog,
    watchdog: { kind: "review", progress: () => ledger.inspectionProgress, snapshot: () => ({}) },
  });
  runner.start(
    (prompts) => ({
      async *[Symbol.asyncIterator]() {
        const input = prompts[Symbol.asyncIterator]();
        while (!(await input.next()).done) {
          for (let index = 0; index < 100; index++) yield delta;
          yield protocolResult();
        }
      },
      close: () => undefined,
      interrupt: noInterrupt,
      mcpServerStatus: noMcpServers,
    }),
    noLog,
  );
  try {
    assert.equal(ledger.inspectionProgress, 0);
    for (const event of ["initial", "delivered", "reset"]) {
      if (event === "delivered") {
        ledger.confirmContextRanges("packet", [
          { paths: ["src/a.ts"], start: 0, end: 20, totalBytes: 20 },
        ]);
        runner.observeProgress();
        assert.ok(ledger.inspectionProgress > 0);
      }
      if (event === "reset") {
        ledger.resetDelivery();
        runner.rebaseProgress();
        assert.equal(ledger.inspectionProgress, 0);
      }
      const before = scans;
      runner.prompts.push(makeUserMessage(event));
      assert.equal((await runner.waitForTurn()).kind, "result");
      assert.equal(scans, before, event);
    }
  } finally {
    await runner.close();
    runner.dispose();
  }
});
