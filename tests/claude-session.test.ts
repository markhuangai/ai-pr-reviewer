import { strict as assert } from "node:assert";
import test from "node:test";
import { aggregateReview } from "../src/lib/aggregate.js";
import {
  modelFixture,
  sharedReviewRun,
  sharedReviewScript,
  historyText,
  isolatedTemporaryRoot,
} from "./codex-test-helpers.js";
import { runSharedDiscovery } from "../src/runtime/shared-discovery.js";
import { makeReplayRepository, makeDiffFromSnapshots } from "./git-test-helpers.js";
import { emptyConversation, reviewConfig } from "./agent-test-helpers.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

test(
  "real Claude forks inherit discovery while private evidence and queued reviewers stay isolated",
  { timeout: 180_000 },
  async (t) => {
    const script = sharedReviewScript();
    const fixture = await modelFixture(t, script.next);
    const { run, config, context } = await sharedReviewRun(t, fixture.url, "claude", script);
    assert.equal(run.discovery?.status, "completed");
    assert.equal(script.reads.filter((read) => read.tool === "read_pr_diff").length, 1);
    const totals = aggregateReview(context, config, [], run.goals, {
      discovery: run.discovery,
    }).tokenUsage;
    assert.equal(totals.complete, true);
    assert.equal(totals.totals.inputTokens, fixture.requests.length * 100);
    assert.equal(totals.totals.outputTokens, fixture.requests.length * 10);
  },
);

test(
  "real Claude single-goal reviews retain full coverage without discovery",
  { timeout: 180_000 },
  async (t) => {
    const script = sharedReviewScript({ goalCount: 1 });
    const fixture = await modelFixture(t, script.next);
    const { run } = await sharedReviewRun(t, fixture.url, "claude", script);
    assert.equal(run.discovery, undefined);
    assert.equal(script.reads.filter((read) => read.tool === "read_pr_diff").length, 1);
  },
);

test(
  "real Claude resumes discovery after exhausted SDK provider retries",
  { timeout: 180_000 },
  async (t) => {
    const script = sharedReviewScript();
    let failures = 0;
    const fixture = await modelFixture(t, (request) =>
      failures++ < 2 ? { error: 500 } : script.next(request),
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
    const { run } = await sharedReviewRun(t, fixture.url, "claude", script);
    assert.equal(run.discovery?.status, "completed");
    assert.ok(run.goals.every((goal) => goal.status === "completed"));
    assert.equal(delays.length, 1);
  },
);

test(
  "real Claude finishes discovery after its normal turn limit without further reads",
  { timeout: 120_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const repository = await makeReplayRepository(t);
    let finishing = false;
    const fixture = await modelFixture(t, ({ body }) => {
      if (historyText(body).includes("Finish the change map from evidence already delivered.")) {
        finishing = true;
        return {
          tool: "finish_discovery",
          args: {
            changeMap:
              "The overview identifies the changed paths; source investigation remains for each goal.",
          },
        };
      }
      return { tool: "read_change_overview", args: {} };
    });
    const diff = await makeDiffFromSnapshots(
      repository.root,
      repository.baseSha,
      repository.headSha,
      repository.temporaryRoot,
    );
    t.after(() => diff.cleanup());
    const result = await runSharedDiscovery({
      context: repository.context,
      files: [],
      conversation: emptyConversation,
      config: reviewConfig({
        executor: "claude",
        model: "claude-sonnet-4-5",
        aiBaseUrl: fixture.url.replace(/\/v1$/u, ""),
        maxTurns: 2,
      }),
      diff,
      cwd: repository.root,
      queryAgent: query,
      abortController: undefined,
      briefing: { linkedIssues: [], linkedIssueReferencesTruncated: false },
    });
    t.after(() => result.cleanup());
    assert.ok(finishing);
    assert.equal(result.result.status, "completed", result.result.error ?? "Discovery failed");
    assert.equal(result.result.diagnostics.readCalls, 1);
    assert.ok(result.seed);
  },
);
