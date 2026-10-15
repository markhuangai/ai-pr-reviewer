import { strict as assert } from "node:assert";
import test from "node:test";
import { aggregateReview } from "../src/lib/aggregate.js";
import { modelFixture, sharedReviewRun, sharedReviewScript } from "./codex-test-helpers.js";

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
  "real Claude independent starts retain full coverage when sharing is disabled",
  { timeout: 180_000 },
  async (t) => {
    const script = sharedReviewScript({ shared: false });
    const fixture = await modelFixture(t, script.next);
    const { run } = await sharedReviewRun(t, fixture.url, "claude", script, false);
    assert.equal(run.discovery, undefined);
    assert.equal(script.reads.filter((read) => read.tool === "read_pr_diff").length, 3);
  },
);
