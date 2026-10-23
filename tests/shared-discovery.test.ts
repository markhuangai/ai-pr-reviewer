import { ReviewBriefingReader } from "../src/runtime/review-briefing.js";
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { access, readdir } from "node:fs/promises";
import test from "node:test";
import { z } from "zod";
import { aggregateReview, buildReviewBody, buildRunSummary } from "../src/lib/aggregate.js";
import { readReviewConfig } from "../src/lib/input.js";
import { redactDiscovery } from "../src/lib/redaction.js";
import type { ChangedFile, DiscoveryResult, GoalResult } from "../src/lib/types.js";
import { runReviewGoal, runReviewGoals } from "../src/runtime/agent.js";
import { MODEL_TOOL_RESULT_BYTES, jsonToolResult } from "../src/runtime/agent-review-tools.js";
import { ReviewEvidenceLedger } from "../src/runtime/review-assessment.js";
import {
  DISCOVERY_LIMITS,
  DiscoveryReadBudget,
  changeOverview,
  discoveryIdentity,
  runSharedDiscovery,
} from "../src/runtime/shared-discovery.js";
import { tool } from "../src/runtime/review-tool.js";
import { emptyConversation, goalContext, reviewConfig } from "./agent-test-helpers.js";
import {
  modelFixture,
  sharedReviewRun,
  sharedReviewScript,
  isolatedTemporaryRoot,
} from "./codex-test-helpers.js";
import { makeReplayRepository, makeDiffFromSnapshots } from "./git-test-helpers.js";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createDeferred, createReviewGoalsRunner } from "../src/runtime/agent-session.js";
import { modelUsageSince } from "../src/runtime/shared-discovery.js";
import { historyText } from "./codex-test-helpers.js";

const file: ChangedFile = {
  path: "review.txt",
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  addedLines: new Set([2]),
};
const briefing = { linkedIssues: [], linkedIssueReferencesTruncated: false };

test("multi-goal configuration has no shared discovery control", () => {
  const values: Record<string, string> = {
    "github-pat": "fixture",
    "ai-base-url": "https://fixture.test",
    "ai-secret": "fixture-secret",
    model: "fixture",
    "review-prompts": '[{"prompt":"alpha"},{"prompt":"beta"}]',
  };
  const config = readReviewConfig({ get: (name) => values[name] ?? "" });
  assert.equal(config.reviewPrompts.length, 2);
  assert.equal("sharedDiscovery" in config, false);
});

test("huge change overviews paginate under the read budget without claiming inspection", () => {
  const files = Array.from({ length: 10_000 }, (_, index) => ({
    ...file,
    path: `area-${index}/file-${index}.ts`,
  }));
  const reader = changeOverview({ ...goalContext, body: "x".repeat(1_000_000) }, files);
  const first = reader.readNext();
  assert.ok(Buffer.byteLength(first.content) <= 8 * 1024);
  assert.match(first.content, /"changedFiles":10000/u);
  assert.equal(first.done, false);
  const ledger = new ReviewEvidenceLedger("/repo", files);
  assert.equal(ledger.inspection.observedPaths.length, 0);
});

test("read budgets serialize concurrent calls and never invoke a read beyond either limit", async () => {
  let executed = 0;
  let exhausted = 0;
  const budget = new DiscoveryReadBudget(() => exhausted++);
  const definition = budget.wrap(
    tool("read_fixture", "Read fixture bytes.", {}, () => {
      executed++;
      return Promise.resolve(jsonToolResult({ value: "x" }));
    }),
  );
  const responses = await Promise.all(Array.from({ length: 1000 }, () => definition.handler({})));
  const delivered = responses
    .flatMap((response) => response.content)
    .reduce(
      (total, part) => total + (part.type === "text" ? Buffer.byteLength(part.text, "utf8") : 0),
      0,
    );
  assert.equal(budget.deliveredBytes, delivered);
  assert.ok(delivered <= DISCOVERY_LIMITS.deliveredBytes);
  assert.equal(executed, 16);
  assert.equal(budget.readCalls, 16);
  assert.equal(exhausted, 984);
  const bytes = new DiscoveryReadBudget(() => undefined);
  const large = bytes.wrap(
    tool("read_fixture", "Read bounded fixture bytes.", {}, () =>
      Promise.resolve(jsonToolResult({ value: "x".repeat(MODEL_TOOL_RESULT_BYTES - 200) })),
    ),
  );
  await large.handler({});
  await large.handler({});
  assert.equal((await large.handler({})).isError, true);
  assert.ok(bytes.deliveredBytes <= DISCOVERY_LIMITS.deliveredBytes);
  const invalid = new DiscoveryReadBudget(() => undefined).wrap(
    tool("read_fixture", "Reject oversized delivery.", { value: z.string() }, () =>
      Promise.resolve({
        content: [{ type: "text", text: "x".repeat(MODEL_TOOL_RESULT_BYTES + 1) }],
      }),
    ),
  );
  await assert.rejects(invalid.handler({ value: "fixture" }), /bounded page size/u);
});

test("briefing checkpoints inherit delivered pages and reject a different snapshot", () => {
  const parent = new ReviewBriefingReader(goalContext, [file], emptyConversation, briefing);
  parent.readNext();
  const child = new ReviewBriefingReader(goalContext, [file], emptyConversation, briefing);
  child.inherit(parent.checkpoint());
  assert.equal(child.complete, true);
  assert.deepEqual(child.readNext().records, []);
  assert.throws(() => {
    new ReviewBriefingReader(
      { ...goalContext, title: "different" },
      [file],
      emptyConversation,
      briefing,
    ).inherit(parent.checkpoint());
  }, /snapshot/u);
  assert.throws(() => {
    child.inherit({ ...parent.checkpoint(), delivered: [99999] });
  }, /snapshot/u);
  assert.notEqual(
    discoveryIdentity(goalContext, emptyConversation, briefing),
    discoveryIdentity(goalContext, { ...emptyConversation, digest: "changed" }, briefing),
  );
  const largeContext = { ...goalContext, body: "x".repeat(50_000) };
  const large = new ReviewBriefingReader(largeContext, [file], emptyConversation, briefing);
  large.readNext();
  const remaining = new ReviewBriefingReader(largeContext, [file], emptyConversation, briefing);
  remaining.inherit(large.checkpoint());
  assert.equal(remaining.complete, false);
  assert.equal(remaining.readNext().page, 2);
});

test("source checkpoints preserve partial ranges, isolate children, and reject stale identity", () => {
  const identity = { mergeBaseSha: "a".repeat(40), headSha: "b".repeat(40) };
  const parent = new ReviewEvidenceLedger("/repo", [file], identity);
  const call = (start: number, end: number) => ({
    tool_use_id: randomUUID(),
    tool_name: "mcp__review_output__read_pr_diff",
    tool_input: { remaining: true },
    tool_response: jsonToolResult({
      ...identity,
      remaining: true,
      page: 1,
      done: true,
      byteLength: end - start,
      content: "x".repeat(end - start),
      ranges: [{ paths: [file.path], start, end, totalBytes: 10 }],
    }),
  });
  parent.observeBatch([call(0, 5)]);
  const checkpoint = parent.checkpoint();
  const alpha = new ReviewEvidenceLedger("/repo", [file], identity);
  const beta = new ReviewEvidenceLedger("/repo", [file], identity);
  alpha.inherit(checkpoint);
  beta.inherit(checkpoint);
  assert.deepEqual(alpha.inspection.missingPaths, [file.path]);
  alpha.observeBatch([call(5, 10)]);
  assert.deepEqual(alpha.inspection.missingPaths, []);
  assert.deepEqual(beta.inspection.missingPaths, [file.path]);
  assert.equal(parent.issued.size, 1);
  assert.equal(alpha.issued.size, 2);
  assert.throws(() => {
    new ReviewEvidenceLedger("/repo", [file], { ...identity, headSha: "c".repeat(40) }).inherit(
      checkpoint,
    );
  }, /snapshot/u);
  assert.throws(() => {
    alpha.inherit(checkpoint);
  }, /snapshot/u);
});

test("fork accounting removes only historical totals and rejects unverified counters", () => {
  const parent = {
    model: "model",
    inputTokens: 100,
    outputTokens: 10,
    cacheReadInputTokens: 20,
    cacheCreationInputTokens: 5,
  };
  const child = {
    ...parent,
    inputTokens: 400,
    outputTokens: 40,
    cacheReadInputTokens: 70,
    cacheCreationInputTokens: 15,
  };
  assert.deepEqual(modelUsageSince([child], [parent]), [
    {
      ...child,
      inputTokens: 300,
      outputTokens: 30,
      cacheReadInputTokens: 50,
      cacheCreationInputTokens: 10,
    },
  ]);
  assert.equal(modelUsageSince(undefined, [parent]), undefined);
  assert.equal(modelUsageSince([child], undefined), undefined);
  assert.equal(modelUsageSince([], [parent]), undefined);
  assert.equal(modelUsageSince([{ ...child, inputTokens: 0 }], [parent]), undefined);
  assert.deepEqual(modelUsageSince([{ ...child, model: "new" }, parent], [parent]), [
    { ...child, model: "new" },
    {
      ...parent,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  ]);
});

test("preparation is counted once, preserves incomplete accounting, and redacts diagnostics", () => {
  const discovery: DiscoveryResult = {
    status: "completed",
    tokenUsage: {
      complete: true,
      models: [
        {
          model: "secret",
          inputTokens: 100,
          outputTokens: 10,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 0,
        },
      ],
    },
    diagnostics: {
      readCalls: 3,
      deliveredBytes: 1000,
      elapsedMs: 10,
      compactions: 0,
      termination: "complete",
    },
  };
  const goal = {
    prompt: "goal",
    status: "completed" as const,
    inspection: { observedPaths: [], missingPaths: [] },
    submission: { summary: "done", findings: [], limitations: [] },
    tokenUsage: {
      ...discovery.tokenUsage,
      models: discovery.tokenUsage.models.map((usage) => ({ ...usage, inputTokens: 200 })),
    },
  };
  const total = aggregateReview(goalContext, reviewConfig(), [], [goal, goal], {
    discovery,
  }).tokenUsage;
  assert.equal(total.totals.inputTokens, 500);
  assert.equal(total.totals.cacheReadInputTokens, 60);
  assert.equal(total.complete, true);
  assert.equal(
    aggregateReview(goalContext, reviewConfig(), [], [goal], {
      discovery: { ...discovery, tokenUsage: { ...discovery.tokenUsage, complete: false } },
    }).tokenUsage.complete,
    false,
  );
  assert.equal(redactDiscovery(undefined, ["secret"]), undefined);
  assert.doesNotMatch(
    JSON.stringify(
      redactDiscovery(
        {
          ...discovery,
          error: "secret",
          diagnostics: { ...discovery.diagnostics, termination: "secret" },
          tokenUsage: {
            ...discovery.tokenUsage,
            models: discovery.tokenUsage.models.map((usage) => ({
              ...usage,
              canonicalModel: "secret",
            })),
          },
        },
        ["secret"],
      ),
    ),
    /secret/u,
  );
});

test(
  "real Codex forks reuse selected source while siblings and queued children remain isolated",
  { timeout: 120_000 },
  async (t) => {
    const script = sharedReviewScript();
    const fixture = await modelFixture(t, script.next);
    const { run, config, context } = await sharedReviewRun(t, fixture.url, "codex", script);
    assert.equal(run.discovery?.status, "completed");
    assert.equal(script.reads.filter((read) => read.tool === "read_pr_diff").length, 1);
    const usage = aggregateReview(context, config, [], run.goals, {
      discovery: run.discovery,
    }).tokenUsage;
    assert.equal(usage.complete, true);
    assert.equal(usage.totals.inputTokens, fixture.requests.length * 100);
    assert.equal(usage.totals.outputTokens, fixture.requests.length * 10);
  },
);

test(
  "real Codex single-goal reviews retain full coverage without discovery",
  { timeout: 120_000 },
  async (t) => {
    const script = sharedReviewScript({ goalCount: 1 });
    const fixture = await modelFixture(t, script.next);
    const { run } = await sharedReviewRun(t, fixture.url, "codex", script);
    assert.equal(run.discovery, undefined);
    assert.equal(script.reads.filter((read) => read.tool === "read_pr_diff").length, 1);
  },
);

test(
  "real Codex discovery can compact without losing inherited inspection",
  { timeout: 120_000 },
  async (t) => {
    const script = sharedReviewScript({ compact: true });
    const fixture = await modelFixture(t, script.next);
    const { run } = await sharedReviewRun(t, fixture.url, "codex", script);
    assert.ok((run.discovery?.diagnostics.compactions ?? 0) > 0);
  },
);

test(
  "real Codex children complete inherited partial ranges without rereading the prefix",
  { timeout: 120_000 },
  async (t) => {
    const script = sharedReviewScript({ partial: true });
    const fixture = await modelFixture(t, script.next);
    const { run } = await sharedReviewRun(t, fixture.url, "codex", script);
    assert.equal(run.discovery?.status, "completed");
    for (const goal of run.goals) assert.equal(goal.diagnostics?.repeatedSourceBytes, 0);
  },
);

test(
  "real Codex exhausts the orientation budget and completes a map with explicit unknowns",
  { timeout: 120_000 },
  async (t) => {
    const script = sharedReviewScript({ exhaust: true });
    const fixture = await modelFixture(t, script.next);
    const temporary = await isolatedTemporaryRoot(t);
    const repository = await makeReplayRepository(t);
    const diff = await makeDiffFromSnapshots(
      repository.root,
      repository.baseSha,
      repository.headSha,
      repository.temporaryRoot,
    );
    t.after(() => diff.cleanup());
    const result = await runSharedDiscovery({
      context: repository.context,
      files: [file],
      conversation: emptyConversation,
      config: reviewConfig({
        executor: "codex",
        aiBaseUrl: fixture.url,
        model: "gpt-6.1-sol",
        maxTurns: 20,
      }),
      diff,
      cwd: repository.root,
      queryAgent: query,
      abortController: undefined,
      briefing,
    });
    t.after(() => result.cleanup());
    assert.equal(result.result.status, "completed", result.result.error ?? "Discovery failed");
    assert.ok(result.result.diagnostics.readCalls <= 16);
    assert.ok(result.result.diagnostics.deliveredBytes <= 64 * 1024);
    assert.equal(result.result.diagnostics.termination, "budget-completed");
    assert.match(result.seed?.changeMap ?? "", /Unknown/u);
    const child = new ReviewEvidenceLedger(repository.root, [file], {
      mergeBaseSha: diff.mergeBaseSha,
      headSha: repository.headSha,
    });
    assert.ok(result.seed);
    child.inherit(result.seed.evidence);
    assert.deepEqual(child.inspection.missingPaths, [file.path]);
    await result.cleanup();
    assert.deepEqual(await readdir(temporary), []);
  },
);

for (const executor of ["claude", "codex"] as const) {
  test(
    "real " + executor + " cancels active forks without starting the queued goal",
    { timeout: 120_000 },
    async (t) => {
      const script = sharedReviewScript();
      const controller = new AbortController();
      const started = new Set<string>();
      const fixture = await modelFixture(t, (request) => {
        const label = ["ALPHA", "BETA", "GAMMA"].find((name) =>
          historyText(request.body).includes("GOAL_" + name),
        );
        if (label === undefined) return script.next(request);
        started.add(label);
        if (started.size === 2)
          setTimeout(() => {
            controller.abort(new Error("cancel active forks"));
          }, 50);
        return { wait: true };
      });
      await assert.rejects(
        sharedReviewRun(t, fixture.url, executor, script, {}, { controller }),
        /cancel/u,
      );
      assert.deepEqual([...started].sort(), ["ALPHA", "BETA"]);
    },
  );

  test(
    "real " +
      executor +
      " keeps a healthy fork alive when another fork fails and a queued child starts",
    { timeout: 120_000 },
    async (t) => {
      const script = sharedReviewScript();
      const alphaStarted = createDeferred<undefined>();
      const releaseAlpha = createDeferred<undefined>();
      let alphaHeld = false;
      let queuedStarted = false;
      const fixture = await modelFixture(t, async (request) => {
        if (!alphaHeld && !queuedStarted && historyText(request.body).includes("GOAL_ALPHA")) {
          alphaHeld = true;
          alphaStarted.resolve(undefined);
          await releaseAlpha.promise;
          alphaHeld = false;
        }
        return script.next(request);
      });
      t.after(() => {
        releaseAlpha.resolve(undefined);
      });
      const runner = createReviewGoalsRunner(
        async (...args) => {
          const index = args[1];
          const seed = args[12];
          assert.ok(seed);
          if (index === 1) {
            await alphaStarted.promise;
            args[12] = { ...seed, sessionId: randomUUID() };
          }
          if (index === 2) {
            assert.equal(alphaHeld, true);
            await access(seed.sessionHome);
            queuedStarted = true;
            releaseAlpha.resolve(undefined);
          }
          return runReviewGoal(...args);
        },
        query,
        runSharedDiscovery,
      );
      await sharedReviewRun(
        t,
        fixture.url,
        executor,
        script,
        {},
        { runner, expectedStatuses: ["completed", "failed", "completed"] },
      );
      assert.equal(queuedStarted, true);
    },
  );

  for (const maxTurns of [2, 3]) {
    test(
      "real " +
        executor +
        " discovery reserves map completion within " +
        String(maxTurns) +
        " turns",
      { timeout: 120_000 },
      async (t) => {
        await isolatedTemporaryRoot(t);
        const repository = await makeReplayRepository(t);
        const script = sharedReviewScript();
        const fixture = await modelFixture(t, script.next);
        const diff = await makeDiffFromSnapshots(
          repository.root,
          repository.baseSha,
          repository.headSha,
          repository.temporaryRoot,
        );
        t.after(() => diff.cleanup());
        const result = await runSharedDiscovery({
          context: repository.context,
          files: [file],
          conversation: emptyConversation,
          config: reviewConfig({
            executor,
            aiBaseUrl: executor === "claude" ? fixture.url.replace(/\/v1$/u, "") : fixture.url,
            model: executor === "claude" ? "claude-sonnet-4-5" : "gpt-6.1-sol",
            maxTurns,
          }),
          diff,
          cwd: repository.root,
          queryAgent: query,
          abortController: undefined,
          briefing,
        });
        t.after(() => result.cleanup());
        assert.equal(result.result.status, "completed", result.result.error ?? "Discovery failed");
        if (executor === "claude") assert.ok(fixture.requests.length <= maxTurns);
        assert.ok(result.result.diagnostics.readCalls <= 2);
        assert.ok(result.seed);
        const release = result.seed.retainSession();
        await assert.rejects(result.cleanup(), /shutdowns remain unproven/u);
        await access(result.seed.sessionHome);
        release();
        await result.cleanup();
      },
    );
  }

  test(
    "real " + executor + " cannot freeze an unaccepted map and honors the discovery deadline",
    { timeout: 120_000 },
    async (t) => {
      for (const deadline of [false, true]) {
        await t.test(deadline ? "deadline" : "missing map", async (subtest) => {
          const temporary = await isolatedTemporaryRoot(subtest);
          const repository = await makeReplayRepository(subtest);
          if (deadline) {
            const schedule = globalThis.setTimeout;
            subtest.mock.method(
              globalThis,
              "setTimeout",
              (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) =>
                schedule(
                  callback,
                  milliseconds === DISCOVERY_LIMITS.milliseconds ? 1500 : milliseconds,
                  ...args,
                ),
            );
          }
          const fixture = await modelFixture(subtest, () =>
            deadline ? { wait: true } : { text: "No accepted map was produced." },
          );
          const diff = await makeDiffFromSnapshots(
            repository.root,
            repository.baseSha,
            repository.headSha,
            repository.temporaryRoot,
          );
          subtest.after(() => diff.cleanup());
          const result = await runSharedDiscovery({
            context: repository.context,
            files: [file],
            conversation: emptyConversation,
            config: reviewConfig({
              executor,
              aiBaseUrl: executor === "claude" ? fixture.url.replace(/\/v1$/u, "") : fixture.url,
              model: executor === "claude" ? "claude-sonnet-4-5" : "gpt-6.1-sol",
              maxTurns: 20,
            }),
            diff,
            cwd: repository.root,
            queryAgent: query,
            abortController: undefined,
            briefing,
          });
          assert.equal(result.result.status, "failed");
          assert.equal(result.seed, undefined);
          assert.equal(result.result.diagnostics.termination, deadline ? "deadline" : "failed");
          assert.match(
            result.result.error ?? "",
            deadline ? /ten-minute/u : /without an accepted change map|turn limit/u,
          );
          assert.deepEqual(await readdir(temporary), []);
        });
      }
    },
  );
  test(
    "real " + executor + " provider failure stops discovery without starting review goals",
    { timeout: 120_000 },
    async (t) => {
      const temporary = await isolatedTemporaryRoot(t);
      const repository = await makeReplayRepository(t);
      const fixture = await modelFixture(t, () => ({ error: 400 }));
      const config = reviewConfig({
        executor,
        aiBaseUrl: executor === "claude" ? fixture.url.replace(/\/v1$/u, "") : fixture.url,
        model: executor === "claude" ? "claude-sonnet-4-5" : "gpt-6.1-sol",
        maxTurns: 20,
        reviewPrompts: [
          { prompt: "GOAL_ALPHA", files: [] },
          { prompt: "GOAL_BETA", files: [] },
        ],
      });
      const result = await runReviewGoals(
        repository.context,
        [file],
        emptyConversation,
        config,
        [[], []],
        repository.root,
        undefined,
        undefined,
        briefing,
      );
      assert.equal(result.discovery?.status, "failed");
      assert.ok(result.goals.every((goal) => goal.status === "failed"));
      assert.ok(fixture.requests.every(({ body }) => !JSON.stringify(body).includes("GOAL_ALPHA")));
      assert.deepEqual(await readdir(temporary), []);
    },
  );

  test(
    "real " + executor + " cancellation closes discovery and removes private storage",
    { timeout: 120_000 },
    async (t) => {
      const temporary = await isolatedTemporaryRoot(t);
      const repository = await makeReplayRepository(t);
      const controller = new AbortController();
      const fixture = await modelFixture(t, () => {
        setTimeout(() => {
          controller.abort(new Error("fixture cancellation"));
        }, 50);
        return { wait: true };
      });
      const diff = await makeDiffFromSnapshots(
        repository.root,
        repository.baseSha,
        repository.headSha,
        repository.temporaryRoot,
      );
      t.after(() => diff.cleanup());
      await assert.rejects(
        runSharedDiscovery({
          context: repository.context,
          files: [file],
          conversation: emptyConversation,
          config: reviewConfig({
            executor,
            aiBaseUrl: executor === "claude" ? fixture.url.replace(/\/v1$/u, "") : fixture.url,
            model: executor === "claude" ? "claude-sonnet-4-5" : "gpt-6.1-sol",
          }),
          diff,
          cwd: repository.root,
          queryAgent: query,
          abortController: controller,
          briefing,
        }),
        /cancellation/u,
      );
      assert.deepEqual(await readdir(temporary), []);
    },
  );

  test(
    "real " + executor + " rejects a missing fork without deleting the retained parent",
    { timeout: 120_000 },
    async (t) => {
      await isolatedTemporaryRoot(t);
      const repository = await makeReplayRepository(t);
      const script = sharedReviewScript();
      const fixture = await modelFixture(t, script.next);
      const config = reviewConfig({
        executor,
        aiBaseUrl: executor === "claude" ? fixture.url.replace(/\/v1$/u, "") : fixture.url,
        model: executor === "claude" ? "claude-sonnet-4-5" : "gpt-6.1-sol",
        maxTurns: 20,
      });
      const diff = await makeDiffFromSnapshots(
        repository.root,
        repository.baseSha,
        repository.headSha,
        repository.temporaryRoot,
      );
      t.after(() => diff.cleanup());
      const discovery = await runSharedDiscovery({
        context: repository.context,
        files: [file],
        conversation: emptyConversation,
        config,
        diff,
        cwd: repository.root,
        queryAgent: query,
        abortController: undefined,
        briefing,
      });
      t.after(() => discovery.cleanup());
      assert.ok(discovery.seed, discovery.result.error ?? "Discovery failed");
      const before = fixture.requests.length;
      const result = await runReviewGoal(
        "GOAL_ALPHA",
        0,
        repository.context,
        [file],
        emptyConversation,
        config,
        diff,
        repository.root,
        undefined,
        [],
        undefined,
        briefing,
        { ...discovery.seed, sessionId: randomUUID() },
      );
      assert.equal(result.status, "failed");
      assert.equal(fixture.requests.length, before);
      assert.deepEqual(result.inspection?.lineCoverage, [
        { path: file.path, addedLines: [], deletedLines: [] },
      ]);
      await access(discovery.seed.sessionHome);
    },
  );
}

test("coverage unions changed lines across seven profiles and stays independent of approval", () => {
  const manifest = [
    {
      ...file,
      path: "file1.go",
      additions: 12,
      deletions: 8,
      changes: 20,
      addedLines: new Set(Array.from({ length: 12 }, (_, index) => index + 1)),
    },
    {
      ...file,
      path: "file2.go",
      additions: 40,
      deletions: 0,
      changes: 40,
      addedLines: new Set(Array.from({ length: 40 }, (_, index) => index + 1)),
    },
  ];
  const profiles = Array.from({ length: 7 }, (_, index) => ({
    prompt: `PRIVATE PROFILE ${index}`,
    files: [],
  }));
  const goals: GoalResult[] = profiles.map(({ prompt }, index) => ({
    prompt,
    status: "completed",
    submission: { summary: "clean", findings: [], limitations: [] },
    inspection: {
      observedPaths: manifest.map((file) => file.path),
      missingPaths: [],
      lineCoverage: [
        {
          path: "file1.go",
          addedLines: index < 5 ? [[1, 11]] : [],
          deletedLines: index < 5 ? [[1, 8]] : [],
        },
        { path: "file2.go", addedLines: [[1, 41]], deletedLines: [] },
      ],
    },
  }));
  const settings = reviewConfig({ reviewPrompts: profiles, autoApprove: true });
  const review = aggregateReview(goalContext, settings, manifest, goals);
  assert.deepEqual(review.coverage.files, [
    { path: "file1.go", linesRead: 17, totalChanges: 20, reviewersRead: 5 },
    { path: "file2.go", linesRead: 40, totalChanges: 40, reviewersRead: 7 },
  ]);
  assert.equal(review.coverage.linesRead, 57);
  assert.equal(review.event, "APPROVE");
  for (const output of [
    buildReviewBody(review, goals),
    buildRunSummary(goalContext, review, goals),
  ]) {
    assert.match(
      output,
      /<details>\n<summary>🔍 Review coverage · 95% of total changes<\/summary>/u,
    );
    assert.match(output, /file1\.go<\/code> \| 17 \| 20 \| 85% \| 5 \| 7/u);
    assert.match(output, /file2\.go<\/code> \| 40 \| 40 \| 100% \| 7 \| 7/u);
    assert.match(output, /\*\*Total\*\* \| \*\*57\*\* \| \*\*60\*\* \| \*\*95%\*\*/u);
    assert.ok(output.indexOf("🔍 Review coverage") < output.indexOf("📊 Token usage"));
    assert.doesNotMatch(output, /<details open|###.*Review coverage|PRIVATE PROFILE/u);
    assert.match(output, /Total changes excludes unchanged context/u);
    assert.match(output, /Reviewers read counts profiles receiving at least one changed line/u);
    assert.match(
      output,
      /includes failed and unfinished profiles; discovery is not an additional profile/u,
    );
  }
  const failed = goals.map((goal) => ({ ...goal, status: "failed" as const }));
  const last = failed[6];
  assert.ok(last);
  failed[6] = {
    ...last,
    inspection: {
      observedPaths: manifest.map((file) => file.path),
      missingPaths: [],
      lineCoverage: [{ path: "file1.go", addedLines: [[11, 13]], deletedLines: [[8, 9]] }],
    },
  };
  const fullButFailed = aggregateReview(goalContext, settings, manifest, failed);
  assert.equal(fullButFailed.coverage.linesRead, 60);
  assert.equal(fullButFailed.event, "COMMENT");
  assert.match(buildReviewBody(fullButFailed, failed), /Review coverage · 100% of total changes/u);
  assert.match(buildRunSummary(goalContext, fullButFailed, failed), /^## ⚠️ AI review failed/u);
});
