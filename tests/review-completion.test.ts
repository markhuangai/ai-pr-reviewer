import {
  assert,
  test,
  mkdir,
  writeFile,
  join,
  runReviewGoals,
  agentInternals,
  emptyConversation,
  runReviewGoalWithEmptyGuidance as runReviewGoal,
  type SDKMessage,
} from "./agent-test-helpers.js";
import { rm } from "node:fs/promises";
import { makeReplayRepository, commitFixtureSnapshot } from "./git-test-helpers.js";
import { readPullRequestFilesFromSnapshots } from "../src/lib/git-changed-files.js";
import { ReviewEvidenceLedger } from "../src/runtime/review-assessment.js";
import { aggregateReview } from "../src/lib/aggregate.js";
import {
  reviewProtocolQuery,
  protocolDocument,
  recoveryState,
  protocolBriefing,
  protocolResult,
  recoveryRepository,
  recoverySubmission,
  recoveryConfig as reviewConfig,
} from "./review-protocol-test-helpers.js";
import type { ChangedFile } from "../src/lib/types.js";
const changedFile: ChangedFile = {
  path: "src/change.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  addedLines: new Set([1]),
};
let toolSequence = 0;
function call(tool_name: string, tool_input: unknown, tool_response: unknown) {
  return { tool_name, tool_input, tool_response, tool_use_id: `completion-${++toolSequence}` };
}
function jsonResponse(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

test("automatic diff pages require valid ranges and cannot claim inspection from done alone", () => {
  const snapshot = { mergeBaseSha: "1".repeat(40), headSha: "2".repeat(40) };
  const page = {
    ...snapshot,
    page: 1,
    remaining: true,
    done: true,
    content: "x",
    byteLength: 1,
    ranges: [{ paths: [changedFile.path], start: 0, end: 1, totalBytes: 2 }],
  };
  const corrupt = [
    { ...page, ranges: undefined },
    { ...page, ranges: [] },
    { ...page, remaining: false },
    { ...page, page: 2 },
    { ...page, nextCursor: "unexpected" },
    { ...page, headSha: "3".repeat(40) },
    { ...page, mergeBaseSha: "3".repeat(40) },
    { ...page, byteLength: 2 },
    { ...page, ranges: [{ paths: ["unrelated.ts"], start: 0, end: 1, totalBytes: 2 }] },
    { ...page, ranges: [{ paths: [changedFile.path], start: 0, end: 3, totalBytes: 2 }] },
  ];
  for (const response of corrupt) {
    const ledger = new ReviewEvidenceLedger("/repo", [changedFile], snapshot);
    const references = ledger.observeBatch([
      call("read_pr_diff", { remaining: true }, jsonResponse(response)),
    ]);
    assert.equal(references[0]?.status, "failed");
    assert.deepEqual(ledger.inspection.missingPaths, [changedFile.path]);
  }
  const ledger = new ReviewEvidenceLedger("/repo", [changedFile], snapshot);
  ledger.observeBatch([call("read_pr_diff", { remaining: true }, jsonResponse(page))]);
  assert.deepEqual(ledger.inspection.missingPaths, [changedFile.path]);
  const span = { paths: [changedFile.path], offset: 100, size: 2 };
  assert.deepEqual(ledger.remainingDiffRanges(span), [
    { paths: [changedFile.path], start: 1, end: 2, totalBytes: 2 },
  ]);
  const pending = [{ paths: [changedFile.path], start: 1, end: 2, totalBytes: 2 }];
  assert.deepEqual(ledger.remainingDiffRanges(span, pending), []);
  assert.deepEqual(ledger.inspection.missingPaths, [changedFile.path]);
  ledger.observeBatch([
    call(
      "read_pr_diff",
      { remaining: true },
      jsonResponse({
        ...page,
        ranges: pending,
      }),
    ),
  ]);
  assert.deepEqual(ledger.inspection.missingPaths, []);
  assert.deepEqual(ledger.remainingDiffRanges(span), []);
  assert.throws(
    () => ledger.remainingDiffRanges({ ...span, size: 3 }, [], [changedFile.path]),
    /changed size/u,
  );
});

test("remaining diff ranges preserve gaps and require the appropriate whole-file revision", () => {
  const snapshot = { mergeBaseSha: "1".repeat(40), headSha: "2".repeat(40) };
  const ledger = new ReviewEvidenceLedger("/repo", [changedFile], snapshot);
  const range = (start: number, end: number) => ({
    paths: [changedFile.path],
    start,
    end,
    totalBytes: 6,
  });
  for (const [start, end] of [
    [4, 6],
    [0, 2],
  ]) {
    ledger.observeBatch([
      call(
        "read_pr_diff",
        { remaining: true },
        jsonResponse({
          ...snapshot,
          page: 1,
          remaining: true,
          done: false,
          content: "ab",
          byteLength: 2,
          ranges: [range(start as number, end as number)],
        }),
      ),
    ]);
  }
  const span = { paths: [changedFile.path], offset: 0, size: 6 };
  assert.deepEqual(ledger.remainingDiffRanges(span), [range(2, 4)]);
  assert.throws(
    () => ledger.remainingDiffRanges(span, [{ ...range(2, 4), totalBytes: 7 }]),
    /changed size/u,
  );
  const file = {
    ...snapshot,
    page: 1,
    done: true,
    kind: "text",
    content: "abc",
    byteOffset: 0,
    byteLength: 3,
    sizeBytes: 3,
  };
  ledger.observeBatch([
    call("read_repository_file", { path: changedFile.path, revision: "base" }, jsonResponse(file)),
  ]);
  assert.deepEqual(ledger.remainingDiffRanges(span), [range(2, 4)]);
  ledger.observeBatch([
    call("read_repository_file", { path: changedFile.path, revision: "head" }, jsonResponse(file)),
  ]);
  assert.deepEqual(ledger.inspection.missingPaths, []);
  assert.deepEqual(ledger.remainingDiffRanges(span), []);
});

test("six isolated goals finish a 101-file deletion-heavy sweep within the configured budget", async (t) => {
  const retiredTest = "internal/dream/workflow_evidence_test.go";
  const removed = Array.from({ length: 98 }, (_, index) => `retired-${index}.ts`);
  const repository = await makeReplayRepository(t, async (root) => {
    await mkdir(join(root, "internal/dream"), { recursive: true });
    for (const [index, path] of removed.entries())
      await writeFile(join(root, path), `deleted case ${index} source line\n`.repeat(270));
    await writeFile(join(root, retiredTest), "retired regression source\n".repeat(2_100));
  });
  for (const path of [...removed, retiredTest]) await rm(join(repository.root, path));
  await writeFile(join(repository.root, "active.ts"), "export const active = true;\n");
  const headSha = await commitFixtureSnapshot(
    repository.root,
    repository.temporaryRoot,
    repository.baseSha,
  );
  const context = { ...repository.context, headSha };
  const files = await readPullRequestFilesFromSnapshots(
    context,
    repository.root,
    repository.baseSha,
  );
  assert.equal(files.length, 101);
  const config = reviewConfig({
    reviewPrompts: Array.from({ length: 6 }, (_, index) => ({
      prompt: `goal ${index}`,
      files: [],
    })),
    parallelCount: 6,
    maxTurns: 100,
    autoApprove: true,
  });
  const logs = t.mock.method(process.stdout, "write", () => true);
  let nextGoal = 0;
  const results = await runReviewGoals(
    context,
    files,
    emptyConversation,
    config,
    Array.from({ length: 6 }, () => []),
    repository.root,
    reviewProtocolQuery(async function* (protocol) {
      const index = nextGoal++;
      assert.equal(protocol.options.maxTurns, 100);
      let calls = 0;
      let briefing: Record<string, unknown>;
      do {
        briefing = protocolDocument(yield* protocol.call("read_review_briefing", {}));
        calls += 1;
      } while (briefing.done !== true);
      if (index === 0) {
        const otherPaths = files
          .filter((file) => file.path !== retiredTest)
          .map((file) => file.path);
        for (let start = 0; start < otherPaths.length; start += 50) {
          const paths = otherPaths.slice(start, start + 50);
          let cursor: unknown;
          for (;;) {
            const page = protocolDocument(
              yield* protocol.call("read_pr_diff", {
                paths,
                ...(cursor === undefined ? {} : { cursor }),
              }),
            );
            calls += 1;
            if (page.done === true) break;
            cursor = page.nextCursor;
          }
        }
        yield* protocol.call("read_pr_diff", { paths: [retiredTest] });
        calls += 1;
      } else {
        yield* protocol.call("read_pr_diff", {});
        yield* protocol.call("read_pr_diff", {});
        calls += 2;
      }
      const clean = { summary: "Required sweep finished.", findings: [], limitations: [] };
      const rejected = yield* protocol.call("submit_review", clean);
      calls += 1;
      assert.equal(rejected.isError, true);
      assert.deepEqual(protocolDocument(rejected).nextCall, {
        tool: "read_pr_diff",
        arguments: { remaining: true },
      });
      let done = false;
      let automaticCalls = 0;
      while (!done) {
        const response = yield* protocol.call("read_pr_diff", { remaining: true });
        calls += 1;
        automaticCalls += 1;
        assert.ok(
          Buffer.byteLength(JSON.stringify(response)) <= agentInternals.MODEL_TOOL_RESULT_BYTES,
        );
        assert.equal(response.isError, undefined);
        done = protocolDocument(response).done === true;
        if (automaticCalls === 2)
          yield {
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 1000 },
          } as SDKMessage;
        assert.ok(calls < 100);
      }
      assert.equal((yield* protocol.call("submit_review", clean)).isError, undefined);
      calls += 1;
      assert.ok(calls <= 100);
      yield { ...protocolResult(), num_turns: calls };
    }),
  );
  logs.mock.restore();
  assert.equal(results.length, 6);
  assert.ok(results.every((result) => result.status === "completed"));
  assert.ok(results.every((result) => result.inspection?.missingPaths.length === 0));
  assert.equal(results[0]?.diagnostics?.repeatedSourceBytes, 0);
  assert.ok(results.slice(1).every((result) => (result.diagnostics?.repeatedSourceBytes ?? 0) > 0));
  const review = aggregateReview(context, config, files, results);
  assert.equal(review.partial, false);
  assert.equal(review.event, "APPROVE");
});

test("limitations are reconsidered once without erasing findings or genuine blockers", async (t) => {
  const repository = await recoveryRepository(t);
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  for (const scenario of ["scope", "confirmed", "exhausted"] as const) {
    const reason =
      scenario === "scope"
        ? "Outside this goal's scope."
        : "Required runtime evidence remains unavailable.";
    const limitation = { paths: ["review.txt"], reason };
    const result = await runReviewGoal(
      scenario,
      0,
      repository.context,
      files,
      emptyConversation,
      reviewConfig({ maxTurns: scenario === "exhausted" ? 2 : 100 }),
      repository.diff,
      repository.root,
      reviewProtocolQuery(async function* (protocol) {
        yield* protocolBriefing(protocol);
        yield* protocol.call("read_pr_diff", { remaining: true });
        const state = yield* recoveryState(protocol);
        const reference = state.evidence.find(
          (ref) => ref.status === "complete" && ref.paths?.includes("review.txt"),
        );
        assert.ok(reference);
        const limited = { ...recoverySubmission(reference.id), limitations: [limitation] };
        const response = yield* protocol.call("submit_review", limited);
        assert.equal(response.isError, true);
        assert.deepEqual(protocolDocument(response).categories, ["limitation"]);
        const pending = yield* recoveryState(protocol);
        assert.equal(pending.validationFailures, 1);
        assert.equal(pending.gaps[0]?.category, "limitation");
        if (scenario === "exhausted") {
          yield { ...protocolResult("error_max_turns"), num_turns: 3 };
          return;
        }
        const replacement =
          scenario === "scope"
            ? { ...limited, summary: "The excluded path is outside this goal.", limitations: [] }
            : limited;
        assert.equal((yield* protocol.call("submit_review", replacement)).isError, undefined);
        yield protocolResult();
      }),
    );
    assert.equal(result.status, scenario === "scope" ? "completed" : "incomplete");
    assert.equal(result.submission?.findings.length, 1);
    assert.equal(result.diagnostics?.rejectionCounts.limitation, 1);
    assert.equal(result.diagnostics?.validationFailures, 1);
    if (scenario === "scope") assert.deepEqual(result.submission?.limitations, []);
    else assert.deepEqual(result.submission?.limitations, [limitation]);
    assert.deepEqual(result.inspection?.missingPaths, []);
    if (scenario === "exhausted")
      assert.equal(result.diagnostics?.termination, "max-turns-exhausted");
    assert.equal(
      aggregateReview(repository.context, reviewConfig({ autoApprove: true }), files, [result])
        .partial,
      scenario !== "scope",
    );
  }
});
