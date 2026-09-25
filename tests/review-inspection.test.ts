import {
  assert,
  makeRepository,
  makeDiffFromSnapshots,
  join,
  writeFile,
  emptyConversation,
  runReviewGoalWithEmptyGuidance as runReviewGoal,
  test,
  type SDKMessage,
} from "./agent-test-helpers.js";
import { rename } from "node:fs/promises";
import { readPullRequestFilesFromSnapshots } from "../src/lib/git-changed-files.js";
import {
  reviewProtocolQuery,
  protocolDocument,
  recoveryState,
  protocolBriefing,
  protocolResult,
  recoveryRepository,
  recoveryConfig as reviewConfig,
} from "./review-protocol-test-helpers.js";
import { ReviewSubmissionRecovery } from "../src/runtime/review-submission.js";
import { aggregateReview } from "../src/lib/aggregate.js";

test("completes production-shaped inspection after more than six submissions and a schema error", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "a-small.ts"), "export const changed = true;\n");
    await writeFile(
      join(root, "z-lock.json"),
      Array.from({ length: 12_000 }, (_, index) => `SOURCE_BODY_SENTINEL entry-${index}\n`).join(
        "",
      ),
    );
  });
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.temporaryRoot,
  );
  t.after(() => diff.cleanup());
  const logs: string[] = [];
  const output = t.mock.method(process.stdout, "write", (chunk: unknown) => {
    logs.push(String(chunk));
    return true;
  });
  const result = await runReviewGoal(
    "inspect the required changes",
    0,
    repository.context,
    files,
    emptyConversation,
    reviewConfig(),
    diff,
    repository.root,
    reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      const clean = { summary: "Required investigation finished.", findings: [], limitations: [] };
      let page = protocolDocument(yield* protocol.call("read_pr_diff", {}));
      assert.equal(page.done, false);
      let state = yield* recoveryState(protocol);
      assert.equal(state.inspection.observed, 1);
      const small = state.evidence.find(
        (reference) => reference.paths?.includes("a-small.ts") && reference.status === "complete",
      );
      assert.ok(small);
      assert.equal(
        (yield* protocol.call("submit_review", {
          ...clean,
          limitations: [{ paths: ["z-lock.json"], reason: "Outside this goal's scope." }],
        })).isError,
        true,
      );
      const before = state.uniqueSourceBytes;
      yield* protocol.call("read_pr_diff", {});
      state = yield* recoveryState(protocol);
      assert.equal(state.uniqueSourceBytes, before);
      assert.ok(state.repeatedSourceBytes > 0);
      let rounds = 0;
      while (page.done !== true) {
        page = protocolDocument(yield* protocol.call("read_pr_diff", { cursor: page.nextCursor }));
        rounds += 1;
        if (rounds === 2) {
          assert.equal(
            (yield* protocol.call("submit_review", {
              ...clean,
              limitations: [{ paths: ["*.json"], reason: "Remaining inspection." }],
            })).isError,
            true,
          );
          yield {
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 1000 },
          } as SDKMessage;
        }
        if (page.done !== true)
          assert.equal((yield* protocol.call("submit_review", clean)).isError, true);
      }
      assert.ok(rounds > 6);
      state = yield* recoveryState(protocol);
      assert.equal(state.inspection.missing, 0);
      assert.equal(state.validationFailures, 1);
      assert.equal(state.remainingCorrections, 5);
      assert.equal(state.consecutiveNoProgress, 0);
      assert.equal((yield* protocol.call("submit_review", clean)).isError, undefined);
      yield protocolResult();
    }),
  );
  output.mock.restore();
  assert.equal(
    result.status,
    "completed",
    JSON.stringify({
      error: result.error,
      diagnostics: result.diagnostics,
      decisions: logs.filter((line) => line.includes("submission-decision")),
    }),
  );
  assert.ok((result.diagnostics?.inspectionContinuations ?? 0) > 6);
  assert.equal(result.diagnostics?.validationFailures, 1);
  const diagnosticLines = logs
    .join("")
    .split("\n")
    .filter((line) => line.includes("] diagnostic "));
  assert.ok(diagnosticLines.some((line) => line.includes("source-delivery")));
  assert.ok(diagnosticLines.some((line) => line.includes("recovery-decision")));
  assert.ok(diagnosticLines.every((line) => !line.includes("SOURCE_BODY_SENTINEL")));
  const terminal = diagnosticLines.find((line) => line.includes("review-result details:"));
  assert.ok(terminal);
  const detail = JSON.parse(terminal.slice(terminal.indexOf("details: ") + 9)) as Record<
    string,
    unknown
  >;
  assert.deepEqual(detail.missingPaths, result.inspection?.missingPaths);
  assert.equal(detail.reviewComplete, true);
  assert.equal(detail.inspectionContinuations, result.diagnostics?.inspectionContinuations);
  assert.equal(detail.repeatedSourceBytes, result.diagnostics?.repeatedSourceBytes);
});

test("repeated inspection cannot bypass no-progress or cumulative recovery limits", () => {
  const stalled = new ReviewSubmissionRecovery(100);
  for (let index = 0; index < 5; index += 1) {
    stalled.observeUse(String(index), { findings: [] });
    stalled.reject(String(index), ["inspection"]);
    stalled.reject(String(index), ["inspection"]);
  }
  assert.equal(stalled.exhaustionReason, "inspection-stalled");
  assert.equal(stalled.validationFailures, 0);
  assert.equal(stalled.inspectionContinuations, 5);
  const bounded = new ReviewSubmissionRecovery(8);
  for (let index = 0; index < 8; index += 1) {
    bounded.observeProgress(index + 1);
    bounded.observeUse(String(index), { findings: [] });
    bounded.reject(String(index), ["inspection"]);
  }
  assert.equal(bounded.exhaustionReason, "recovery-limit");
  assert.equal(bounded.consecutiveNoProgress, 0);
  bounded.observeUse("denied", { findings: ["replacement"] });
  assert.equal(bounded.allows("denied"), false);
  assert.deepEqual(bounded.latestInput, { findings: [] });
});

test("recovery selects an unread unusual path instead of overlapping large global reads", async (t) => {
  const target = 'b space "quoted"\t☃.ts';
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "a-large.json"), "entry: before\n".repeat(10_000));
    await writeFile(join(root, target), "export const changed = true;\n");
    await writeFile(join(root, "z-large.json"), "entry: after\n".repeat(10_000));
  });
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.temporaryRoot,
  );
  t.after(() => diff.cleanup());
  const result = await runReviewGoal(
    "check",
    0,
    repository.context,
    files,
    emptyConversation,
    reviewConfig(),
    diff,
    repository.root,
    reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      const global = protocolDocument(yield* protocol.call("read_pr_diff", {}));
      assert.equal(global.done, false);
      for (const path of ["a-large.json", "z-large.json"]) {
        let cursor: unknown;
        for (;;) {
          const page = protocolDocument(
            yield* protocol.call("read_pr_diff", {
              paths: [path],
              ...(cursor === undefined ? {} : { cursor }),
            }),
          );
          if (page.done === true) break;
          cursor = page.nextCursor;
        }
      }
      const state = yield* recoveryState(protocol);
      assert.equal(state.inspection.missing, 1);
      const next = state.calls.filter((call) => call.kind === "next_call");
      assert.equal(next.length, 1);
      assert.deepEqual(next[0]?.arguments, { paths: [target] });
      assert.ok(
        state.calls.some(
          (call) => call.kind === "active_read" && call.arguments.cursor === global.nextCursor,
        ),
      );
      yield* protocol.call("read_pr_diff", { paths: [target] });
      assert.equal((yield* recoveryState(protocol)).inspection.missing, 0);
      assert.equal(
        (yield* protocol.call("submit_review", {
          summary: "Complete",
          findings: [],
          limitations: [],
        })).isError,
        undefined,
      );
      yield protocolResult();
    }),
  );
  assert.equal(result.status, "completed");
  assert.ok((result.diagnostics?.repeatedSourceBytes ?? 0) > 0);
});

test("missing inspection retains an empty valid candidate as incomplete at the bounded stop", async (t) => {
  const repository = await recoveryRepository(t);
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  const logs: string[] = [];
  const output = t.mock.method(process.stdout, "write", (chunk: unknown) => {
    logs.push(String(chunk));
    return true;
  });
  const result = await runReviewGoal(
    "check",
    0,
    repository.context,
    files,
    emptyConversation,
    reviewConfig(),
    repository.diff,
    repository.root,
    reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      for (let index = 0; index < 5; index += 1) {
        assert.equal(
          (yield* protocol.call("submit_review", {
            summary: "Not inspected",
            findings: [],
            limitations: [{ paths: [], reason: "Required source has not been inspected." }],
          })).isError,
          true,
        );
      }
      await protocol.closed;
    }),
  );
  output.mock.restore();
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.submission?.findings, []);
  assert.equal(result.diagnostics?.termination, "inspection-stalled");
  assert.deepEqual(result.inspection?.missingPaths, ["review.txt", "unread.txt"]);
  const line = logs
    .join("")
    .split("\n")
    .find(
      (line) =>
        line.includes("diagnostic submission-decision details:") &&
        line.includes('"decision":"finalized-incomplete"'),
    );
  assert.ok(line);
  const decision = JSON.parse(line.slice(line.indexOf("details: ") + 9)) as Record<string, unknown>;
  assert.deepEqual(decision.categories, ["inspection"]);
  assert.equal(decision.remainingCorrections, 5);
  assert.equal(decision.remainingInspectionCycles, 0);
  assert.equal(decision.inspectionContinuations, result.diagnostics?.inspectionContinuations);
  assert.equal(decision.consecutiveNoProgress, result.diagnostics?.consecutiveNoProgress);
  assert.equal(decision.recoveryCycles, result.diagnostics?.recoveryCycles);
  assert.equal(decision.termination, result.diagnostics?.termination);
  assert.equal(
    aggregateReview(repository.context, reviewConfig({ autoApprove: true }), files, [result])
      .partial,
    true,
  );
});

test("overlapping partial cursors are compared by the total delivery of the complete alternative", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "a.txt"), "a".repeat(40_000) + "\n");
    await writeFile(join(root, "b.txt"), "b".repeat(60_000) + "\n");
  });
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.temporaryRoot,
  );
  t.after(() => diff.cleanup());
  const result = await runReviewGoal(
    "check",
    0,
    repository.context,
    files,
    emptyConversation,
    reviewConfig(),
    diff,
    repository.root,
    reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      const selected = protocolDocument(yield* protocol.call("read_pr_diff", { paths: ["a.txt"] }));
      let global = protocolDocument(yield* protocol.call("read_pr_diff", {}));
      global = protocolDocument(
        yield* protocol.call("read_pr_diff", { cursor: global.nextCursor }),
      );
      assert.equal(selected.done, false);
      assert.equal(global.done, false);
      const state = yield* recoveryState(protocol);
      assert.equal(state.inspection.missing, 2);
      const recommended = state.calls.filter((call) => call.kind === "next_call");
      assert.equal(recommended.length, 1);
      assert.equal(recommended[0]?.arguments.cursor, global.nextCursor);
      assert.ok(
        state.calls.some(
          (call) => call.kind === "active_read" && call.arguments.cursor === selected.nextCursor,
        ),
      );
      while (global.done !== true)
        global = protocolDocument(
          yield* protocol.call("read_pr_diff", { cursor: global.nextCursor }),
        );
      assert.equal(
        (yield* protocol.call("submit_review", {
          summary: "Complete",
          findings: [],
          limitations: [],
        })).isError,
        undefined,
      );
      yield protocolResult();
    }),
  );
  assert.equal(result.status, "completed");
});

test("recovery stops a global continuation at its last missing file and leaves the inspected tail optional", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "a.txt"), "a".repeat(40_000) + "\n");
    await writeFile(join(root, "b.txt"), "b".repeat(100_000) + "\n");
  });
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.temporaryRoot,
  );
  t.after(() => diff.cleanup());
  const result = await runReviewGoal(
    "check",
    0,
    repository.context,
    files,
    emptyConversation,
    reviewConfig(),
    diff,
    repository.root,
    reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      let global = protocolDocument(yield* protocol.call("read_pr_diff", {}));
      for (let page = 1; page < 3; page += 1)
        global = protocolDocument(
          yield* protocol.call("read_pr_diff", { cursor: global.nextCursor }),
        );
      let trailing = protocolDocument(yield* protocol.call("read_pr_diff", { paths: ["b.txt"] }));
      while (trailing.done !== true)
        trailing = protocolDocument(
          yield* protocol.call("read_pr_diff", { paths: ["b.txt"], cursor: trailing.nextCursor }),
        );
      const state = yield* recoveryState(protocol);
      assert.equal(state.inspection.missing, 1);
      const recommended = state.calls.filter((call) => call.kind === "next_call");
      assert.equal(recommended.length, 1);
      assert.equal(recommended[0]?.arguments.cursor, global.nextCursor);
      global = protocolDocument(
        yield* protocol.call("read_pr_diff", { cursor: global.nextCursor }),
      );
      assert.equal(global.done, false);
      const completed = yield* recoveryState(protocol);
      assert.equal(completed.inspection.missing, 0);
      assert.equal(completed.calls.filter((call) => call.kind === "next_call").length, 0);
      assert.ok(
        completed.calls.some(
          (call) => call.kind === "active_read" && call.arguments.cursor === global.nextCursor,
        ),
      );
      assert.equal(
        (yield* protocol.call("submit_review", {
          summary: "Complete",
          findings: [],
          limitations: [],
        })).isError,
        undefined,
      );
      yield protocolResult();
    }),
  );
  assert.equal(result.status, "completed");
});

test("three overlapping continuations use their cheapest required prefixes without a greedy whole-tail choice", async (t) => {
  const names = ["0-x.txt", "1-y.txt", "2-p.txt", "3-q.txt", "4-r.txt"] as const;
  const sizes = [1_000, 1_000, 100, 32, 32];
  const repository = await makeRepository(t, async (root) => {
    for (const [index, name] of names.entries()) {
      const size = sizes[index];
      assert.ok(size !== undefined);
      await writeFile(join(root, name), ("x".repeat(1023) + "\n").repeat(size));
    }
  });
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.temporaryRoot,
  );
  t.after(() => diff.cleanup());
  const result = await runReviewGoal(
    "check",
    0,
    repository.context,
    files,
    emptyConversation,
    reviewConfig(),
    diff,
    repository.root,
    reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      const cursors: unknown[] = [];
      const selections = [
        [names[0], names[3]],
        [names[1], names[4]],
        [names[2], names[3], names[4]],
      ];
      for (const [index, paths] of selections.entries()) {
        let page = protocolDocument(yield* protocol.call("read_pr_diff", { paths }));
        for (let count = 1; count < (index === 2 ? 3 : 2); count += 1)
          page = protocolDocument(
            yield* protocol.call("read_pr_diff", { paths, cursor: page.nextCursor }),
          );
        cursors.push(page.nextCursor);
      }
      const state = yield* recoveryState(protocol);
      assert.equal(state.inspection.missing, 5);
      const recommended = state.calls.filter((call) => call.kind === "next_call");
      assert.equal(recommended.length, 3);
      assert.deepEqual(
        recommended.map((call) => call.arguments.cursor),
        cursors,
      );
      const operations = recommended as ((typeof recommended)[number] & {
        paths: string[];
        remainingBytes: number;
        planBytes: number;
      })[];
      assert.deepEqual(
        operations.map((call) => call.paths),
        [[names[0], names[3]], [names[1], names[4]], [names[2]]],
      );
      const minimum = diff.size - 7 * 12 * 1024;
      assert.equal(operations[0]?.planBytes, minimum);
      assert.equal(
        operations.reduce((sum, call) => sum + call.remainingBytes, 0),
        minimum,
      );
      for (const operation of operations) {
        for (;;) {
          yield* protocol.call(operation.tool, operation.arguments);
          const progress = yield* recoveryState(protocol);
          if (
            operation.paths.every((path) =>
              progress.evidence.some(
                (reference) => reference.status === "complete" && reference.paths?.includes(path),
              ),
            )
          )
            break;
        }
      }
      const completed = yield* recoveryState(protocol);
      assert.equal(completed.inspection.missing, 0);
      assert.ok(
        completed.calls.some(
          (call) => call.kind === "active_read" && call.arguments.cursor === cursors[2],
        ),
      );
      assert.equal(
        (yield* protocol.call("submit_review", {
          summary: "Complete",
          findings: [],
          limitations: [],
        })).isError,
        undefined,
      );
      yield protocolResult();
    }),
  );
  assert.equal(result.status, "completed");
});

test("filtered recovery resumes a modified rename through either canonical alias", async (t) => {
  const original = "unchanged source line\n".repeat(10_000);
  const repository = await makeRepository(
    t,
    async (root) => {
      await rename(join(root, "old.ts"), join(root, "new.ts"));
      await writeFile(join(root, "new.ts"), original + "added source line\n".repeat(4_000));
    },
    async (root) => {
      await writeFile(join(root, "old.ts"), original);
    },
  );
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  assert.equal(files.length, 1);
  assert.equal(files[0]?.previousPath, "old.ts");
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.temporaryRoot,
  );
  t.after(() => diff.cleanup());
  const result = await runReviewGoal(
    "check",
    0,
    repository.context,
    files,
    emptyConversation,
    reviewConfig(),
    diff,
    repository.root,
    reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      const current = protocolDocument(yield* protocol.call("read_pr_diff", { paths: ["new.ts"] }));
      assert.equal(current.done, false);
      const byOld = (yield* recoveryState(protocol, ["old.ts"])).calls.filter(
        (call) => call.kind === "next_call",
      );
      assert.equal(byOld.length, 1);
      assert.deepEqual(byOld[0]?.arguments, { paths: ["new.ts"], cursor: current.nextCursor });
      let previous = protocolDocument(yield* protocol.call("read_pr_diff", { paths: ["old.ts"] }));
      previous = protocolDocument(
        yield* protocol.call("read_pr_diff", { paths: ["old.ts"], cursor: previous.nextCursor }),
      );
      const byNew = (yield* recoveryState(protocol, ["new.ts"])).calls.filter(
        (call) => call.kind === "next_call",
      );
      assert.equal(byNew.length, 1);
      assert.deepEqual(byNew[0]?.arguments, { paths: ["old.ts"], cursor: previous.nextCursor });
      while (previous.done !== true)
        previous = protocolDocument(
          yield* protocol.call("read_pr_diff", { paths: ["old.ts"], cursor: previous.nextCursor }),
        );
      assert.equal((yield* recoveryState(protocol)).inspection.missing, 0);
      assert.equal(
        (yield* protocol.call("submit_review", {
          summary: "Complete",
          findings: [],
          limitations: [],
        })).isError,
        undefined,
      );
      yield protocolResult();
    }),
  );
  assert.equal(result.status, "completed");
});
