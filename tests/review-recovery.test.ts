import {
  agentInternals,
  assert,
  makeReviewDiff,
  makeRepository,
  makeDiffFromSnapshots,
  join,
  chmod,
  writeFile,
  emptyConversation,
  goalContext,
  reviewConfig,
  runReviewGoalWithEmptyGuidance as runReviewGoal,
  test,
  mkdtemp,
  tmpdir,
  rm,
  type ChangedFile,
  type TestContext,
  type SDKMessage,
  type SDKResultMessage,
} from "./agent-test-helpers.js";
import { rename } from "node:fs/promises";
import { readPullRequestFilesFromSnapshots } from "../src/lib/git-changed-files.js";
import { reviewProtocolQuery, type ReviewProtocol } from "./review-protocol-test-helpers.js";
import {
  ReviewSubmissionRecovery,
  retainValidReviewFindings,
} from "../src/runtime/review-submission.js";
import { aggregateReview, buildReviewBody } from "../src/lib/aggregate.js";
import type { ReviewEvidenceReference } from "../src/lib/types.js";
import {
  ReviewEvidenceLedger,
  reviewFindingGaps,
  reviewInspection,
} from "../src/runtime/review-assessment.js";
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
  return { tool_name, tool_input, tool_response, tool_use_id: `evidence-${++toolSequence}` };
}
function jsonResponse(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
interface RecoveryState {
  readonly manifest: readonly { path: string }[];
  readonly evidence: readonly ReviewEvidenceReference[];
  readonly gaps: readonly { category: string; paths: readonly string[] }[];
  readonly remainingCorrections: number;
  readonly submissionAttempts: number;
  readonly headSha: string;
  readonly inspection: { observed: number; missing: number };
  readonly calls: readonly { kind: string; tool: string; arguments: Record<string, unknown> }[];
}

function protocolDocument(response: {
  readonly content: readonly { readonly text?: string }[];
}): Record<string, unknown> {
  return JSON.parse(response.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function normalizeState(pages: readonly Record<string, unknown>[]): RecoveryState {
  const records = pages.flatMap((page) => page.records as Record<string, unknown>[]);
  return {
    ...pages[0],
    manifest: records.filter((record) => record.kind === "changed_file"),
    evidence: records
      .filter((record) => record.kind === "evidence")
      .map((record) => record.reference),
    gaps: records.filter((record) => record.kind === "gap"),
    calls: records.filter((record) => record.kind === "next_call" || record.kind === "active_read"),
  } as unknown as RecoveryState;
}

async function* recoveryState(
  protocol: ReviewProtocol,
  paths?: string[],
): AsyncGenerator<SDKMessage, RecoveryState> {
  let cursor: string | undefined;
  const pages: Record<string, unknown>[] = [];
  for (;;) {
    const response = yield* protocol.call("read_review_state", {
      ...(paths === undefined ? {} : { paths }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(response)) <= agentInternals.MODEL_TOOL_RESULT_BYTES,
    );
    const page = protocolDocument(response);
    assert.ok(Array.isArray(page.records));
    assert.equal(page.content, undefined);
    pages.push(page);
    if (page.done === true) return normalizeState(pages);
    cursor = String(page.nextCursor);
  }
}

async function* protocolBriefing(protocol: ReviewProtocol): AsyncGenerator<SDKMessage> {
  let done = false;
  while (!done)
    done = protocolDocument(yield* protocol.call("read_review_briefing", {})).done === true;
}

function protocolResult(subtype = "success"): SDKResultMessage {
  return {
    type: "result",
    subtype,
    errors: subtype === "success" ? [] : [subtype],
    num_turns: 2,
    modelUsage: {},
  } as SDKResultMessage;
}

const recoveryFile: ChangedFile = {
  path: "review.txt",
  status: "modified",
  additions: 1,
  deletions: 1,
  changes: 2,
  addedLines: new Set([1]),
};

function recoverySubmission(evidenceRef: string): Record<string, unknown> {
  return {
    summary: "PRIVATE SUMMARY",
    findings: [
      {
        title: "Unchecked result",
        severity: "HIGH",
        why: "The caller drops the error.",
        fix: "Handle the error.",
        path: "review.txt",
        line: 1,
        evidenceRefs: [evidenceRef],
        countercheck: "Checked the caller for handling.",
        counterevidenceRefs: [],
      },
    ],
    limitations: [],
  };
}

async function recoveryRepository(t: TestContext) {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "review.txt"), "changed line\n");
    await writeFile(join(root, "unread.txt"), "unseen change\n");
  });
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.temporaryRoot,
  );
  t.after(() => diff.cleanup());
  return { ...repository, diff };
}

test("recovers completed query references after compaction without rereading source", async (t) => {
  const repository = await makeRepository(t, (root) =>
    writeFile(join(root, "review.txt"), "changed line\n".repeat(4_000)),
  );
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.temporaryRoot,
  );
  t.after(() => diff.cleanup());
  let sourceReads = 0;
  const query = reviewProtocolQuery(async function* (protocol) {
    assert.equal(protocol.options.systemPrompt, "Custom consumer prompt");
    yield* protocolBriefing(protocol);
    let cursor: string | undefined;
    for (;;) {
      const response = yield* protocol.call("read_repository_file", {
        revision: "head",
        path: "review.txt",
        ...(cursor === undefined ? {} : { cursor }),
      });
      sourceReads += 1;
      const page = protocolDocument(response);
      if (page.done === true) break;
      cursor = String(page.nextCursor);
    }
    assert.ok(sourceReads > 1);
    yield {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 1000 },
    } as SDKMessage;
    const state = yield* recoveryState(protocol);
    assert.deepEqual(
      state.manifest.map((file) => file.path),
      ["review.txt"],
    );
    assert.equal(state.headSha, repository.headSha);
    const earlier = state.evidence.find(
      (reference) => reference.kind === "repository_file" && reference.status === "partial",
    );
    assert.ok(earlier?.completedBy);
    const before = sourceReads;
    const replay = protocolDocument(yield* protocol.call("read_review_briefing", { page: 1 }));
    assert.ok((replay.records as unknown[]).length > 0);
    const filtered = yield* recoveryState(protocol, ["review.txt"]);
    assert.ok(filtered.evidence.some((reference) => reference.id === earlier.id));
    const result = yield* protocol.call("submit_review", recoverySubmission(earlier.id));
    assert.equal(result.isError, undefined);
    assert.equal(sourceReads, before);
    yield protocolResult();
  });
  const result = await runReviewGoal(
    "PRIVATE GOAL",
    0,
    repository.context,
    [recoveryFile],
    emptyConversation,
    reviewConfig({ systemPrompt: "Custom consumer prompt", interactWithPullRequest: true }),
    diff,
    repository.root,
    query,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.diagnostics?.submissionAttempts, 1);
  assert.deepEqual(result.diagnostics?.rejectionCounts, {});
  const isolated = await runReviewGoal(
    "another goal",
    1,
    repository.context,
    [recoveryFile],
    emptyConversation,
    reviewConfig(),
    diff,
    repository.root,
    reviewProtocolQuery(async function* (protocol) {
      const state = yield* recoveryState(protocol);
      assert.deepEqual(state.evidence, []);
      assert.equal(state.remainingCorrections, 5);
      yield protocolResult("error_max_turns");
    }),
  );
  assert.equal(isolated.status, "failed");
});

test("state pages preserve a snapshot and expose rejection overflow without issuing evidence", async (t) => {
  const files = Array.from({ length: 600 }, (_, index) => ({
    ...recoveryFile,
    path: `src/consumer-${index}.ts`,
  }));
  const query = reviewProtocolQuery(async function* (protocol) {
    yield* protocolBriefing(protocol);
    const first = protocolDocument(yield* protocol.call("read_review_state", {}));
    assert.equal(first.done, false);
    const cursor = String(first.nextCursor);
    const rejected = yield* protocol.call("submit_review", {
      summary: "",
      findings: [],
      limitations: [],
    });
    assert.equal(rejected.isError, true);
    const response = protocolDocument(rejected);
    assert.ok(Number(response.omittedGaps) > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(rejected)) < agentInternals.MODEL_TOOL_RESULT_BYTES);
    assert.equal(
      (yield* protocol.call("read_review_state", { cursor, paths: ["src/consumer-1.ts"] })).isError,
      true,
    );
    const pages = [first];
    let next = cursor;
    for (;;) {
      const page = protocolDocument(yield* protocol.call("read_review_state", { cursor: next }));
      pages.push(page);
      if (page.done === true) break;
      next = String(page.nextCursor);
    }
    const original = normalizeState(pages);
    const current = yield* recoveryState(protocol);
    assert.equal(original.submissionAttempts, 0);
    assert.equal(original.gaps.length, 0);
    assert.equal(current.submissionAttempts, 1);
    assert.equal(current.gaps.length, 600);
    assert.deepEqual(current.evidence, original.evidence);
    const filtered = yield* recoveryState(protocol, ["src/consumer-1.ts"]);
    assert.equal(filtered.manifest.length, 1);
    assert.equal(filtered.gaps.length, 1);
    yield protocolResult("error_max_turns");
  });
  const result = await runReviewGoal(
    "check consumers",
    0,
    goalContext,
    files,
    emptyConversation,
    reviewConfig(),
    await makeReviewDiff(t),
    "/repo",
    query,
  );
  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics?.submissionAttempts, 1);
});

test("counts SDK schema rejections by identity and ends after five corrections without a terminal turn", async (t) => {
  let attempts = 0;
  const query = reviewProtocolQuery(async function* (protocol) {
    yield* protocolBriefing(protocol);
    for (let index = 0; index < 6; index += 1) {
      const rejected = yield* protocol.call(
        "submit_review",
        { summary: "missing limitations", findings: [] },
        false,
      );
      assert.equal(rejected.isError, true);
      assert.match(JSON.stringify(rejected), /validation|Invalid|invalid/iu);
      attempts += 1;
      if (index < 5) {
        const state = yield* recoveryState(protocol);
        assert.equal(state.submissionAttempts, index + 1);
        assert.equal(state.remainingCorrections, 5 - index);
      }
    }
    await protocol.closed;
  });
  const result = await runReviewGoal(
    "check",
    0,
    goalContext,
    [recoveryFile],
    emptyConversation,
    reviewConfig(),
    await makeReviewDiff(t),
    "/repo",
    query,
  );
  assert.equal(attempts, 6);
  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics?.submissionAttempts, 6);
  assert.equal(result.diagnostics?.repairAttempts, 5);
  assert.equal(result.diagnostics?.rejectionCounts.schema, 6);
  assert.equal(result.tokenUsage?.complete, false);
});

for (const replacement of [
  "unchanged",
  "withdrawn",
  "malformed",
  "unsupported",
  "invalid-anchor",
] as const) {
  test(`max-turn finalization retains only valid current findings: ${replacement}`, async (t) => {
    const repository = await recoveryRepository(t);
    const files = [recoveryFile, { ...recoveryFile, path: "unread.txt", status: "added" }];
    const query = reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      yield* protocol.call("read_pr_diff", { paths: ["review.txt"] });
      const state = yield* recoveryState(protocol);
      const evidence = state.evidence.find((reference) => reference.kind === "repository_diff");
      assert.ok(evidence);
      const submission = recoverySubmission(evidence.id);
      assert.equal((yield* protocol.call("submit_review", submission)).isError, true);
      if (replacement !== "unchanged") {
        const next =
          replacement === "malformed"
            ? { summary: "new invalid payload" }
            : replacement === "withdrawn"
              ? { ...submission, findings: [], limitations: [] }
              : replacement === "unsupported"
                ? recoverySubmission("ev-99999")
                : {
                    ...submission,
                    findings: [
                      {
                        title: "Wrong anchor",
                        severity: "HIGH",
                        why: "Impact",
                        fix: "Fix",
                        path: "review.txt",
                        line: 8,
                        evidenceRefs: [evidence.id],
                        countercheck: "Checked the caller for handling.",
                        counterevidenceRefs: [],
                      },
                    ],
                  };
        assert.equal((yield* protocol.call("submit_review", next)).isError, true);
      }
      yield protocolResult("error_max_turns");
    });
    const config = reviewConfig({ autoApprove: true, interactWithPullRequest: true });
    const result = await runReviewGoal(
      "PRIVATE GOAL",
      0,
      repository.context,
      files,
      emptyConversation,
      config,
      repository.diff,
      repository.root,
      query,
    );
    assert.equal(result.status, replacement === "unchanged" ? "incomplete" : "failed");
    assert.equal(result.submission?.findings.length ?? 0, replacement === "unchanged" ? 1 : 0);
    if (replacement === "unchanged") {
      assert.deepEqual(result.inspection?.missingPaths, ["unread.txt"]);
      const review = aggregateReview(goalContext, config, files, [result]);
      assert.equal(review.event, "COMMENT");
      assert.equal(review.partial, true);
      assert.doesNotMatch(
        buildReviewBody(review, [result]),
        /PRIVATE GOAL|PRIVATE SUMMARY|error_max_turns|submissionAttempts|ev-/u,
      );
    }
  });
}

test("an empty terminal result does not charge a rejected submission twice", async (t) => {
  let followups = 0;
  const result = await runReviewGoal(
    "check",
    0,
    goalContext,
    [recoveryFile],
    emptyConversation,
    reviewConfig(),
    await makeReviewDiff(t),
    "/repo",
    reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      yield* protocol.call("submit_review", {
        summary: "",
        findings: [],
        limitations: [],
      });
      for (let index = 0; index < 6; index += 1) {
        yield protocolResult();
        const next = await protocol.messages.next();
        if (index < 5) {
          assert.equal(next.done, false);
          followups += 1;
        } else assert.equal(next.done, true);
      }
    }),
  );
  assert.equal(followups, 5);
  assert.equal(result.diagnostics?.submissionAttempts, 1);
  assert.equal(result.diagnostics?.repairAttempts, 5);
  assert.equal(result.diagnostics?.rejectionCounts.inspection, 1);
  assert.equal(result.diagnostics?.rejectionCounts.empty_turn, 5);
});

for (const termination of ["exhausted", "provider", "mcp"] as const) {
  test(`preserves safe current findings and failed status when appropriate: ${termination}`, async (t) => {
    const repository = await recoveryRepository(t);
    const config = reviewConfig({
      interactWithPullRequest: true,
      ...(termination === "mcp"
        ? { mcpServers: { knowledge: { type: "http" as const, url: "https://example.test/mcp" } } }
        : {}),
    });
    const query = reviewProtocolQuery(
      async function* (protocol) {
        yield* protocolBriefing(protocol);
        yield* protocol.call("read_pr_diff", { paths: ["review.txt"] });
        const state = yield* recoveryState(protocol);
        const evidence = state.evidence.find((reference) => reference.kind === "repository_diff");
        assert.ok(evidence);
        for (let index = 0; index < (termination === "exhausted" ? 6 : 1); index += 1)
          assert.equal(
            (yield* protocol.call("submit_review", recoverySubmission(evidence.id))).isError,
            true,
          );
        if (termination === "exhausted") await protocol.closed;
        else
          yield protocolResult(
            termination === "provider" ? "error_during_execution" : "error_max_turns",
          );
      },
      termination === "mcp" ? [{ name: "knowledge", status: "failed" }] : [],
    );
    const result = await runReviewGoal(
      "check",
      0,
      repository.context,
      [recoveryFile, { ...recoveryFile, path: "unread.txt" }],
      emptyConversation,
      config,
      repository.diff,
      repository.root,
      query,
    );
    assert.equal(result.status, termination === "exhausted" ? "incomplete" : "failed");
    assert.equal(result.submission?.findings.length, 1);
    assert.equal(result.diagnostics?.submissionAttempts, termination === "exhausted" ? 6 : 1);
    if (termination === "exhausted") assert.equal(result.tokenUsage?.complete, false);
    if (termination === "mcp") assert.match(result.error ?? "", /knowledge/u);
  });
}

test("a sixth accepted submission wins over recovery exhaustion", async (t) => {
  const result = await runReviewGoal(
    "check",
    0,
    goalContext,
    [recoveryFile],
    emptyConversation,
    reviewConfig(),
    await makeReviewDiff(t),
    "/repo",
    reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      for (let index = 0; index < 5; index += 1) yield* protocol.call("submit_review", {});
      const accepted = yield* protocol.call("submit_review", {
        summary: "No complete investigation",
        findings: [],
        limitations: [{ paths: ["review.txt"], reason: "No repository evidence was read." }],
      });
      assert.equal(accepted.isError, undefined);
      yield protocolResult();
    }),
  );
  assert.equal(result.status, "incomplete");
  assert.equal(result.diagnostics?.submissionAttempts, 6);
  assert.equal(result.diagnostics?.rejectionCounts.schema, 5);
  assert.equal(result.tokenUsage?.complete, true);
});

test("retains valid current findings independently of malformed peers", () => {
  const evidence = new Map<string, ReviewEvidenceReference>([
    ["ev-1", { id: "ev-1", kind: "repository_diff", status: "complete", changedPaths: true }],
  ]);
  const raw = recoverySubmission("ev-1");
  const input = { ...raw, findings: [...(raw.findings as unknown[]), { title: "invalid peer" }] };
  const files = [recoveryFile, { ...recoveryFile, path: "unread.txt" }];
  const retained = retainValidReviewFindings(input, files, evidence, () => true);
  assert.equal(retained?.findings.length, 1);
  assert.equal(retained?.limitations.length, 1);
  assert.deepEqual(retained?.limitations[0]?.paths, []);
  assert.doesNotMatch(
    JSON.stringify(retained?.findings),
    /evidenceRefs|countercheck|counterevidenceRefs|ev-/u,
  );
  assert.equal(
    retainValidReviewFindings(input, files, evidence, () => false),
    undefined,
  );
  assert.equal(
    retainValidReviewFindings(null, files, evidence, () => true),
    undefined,
  );
});

test("reserves submission identities without exhausting an in-flight last correction", () => {
  const recovery = new ReviewSubmissionRecovery();
  for (let index = 1; index <= 6; index += 1) recovery.observeUse(`use-${index}`, { index });
  for (let index = 1; index <= 5; index += 1) {
    recovery.reject(`use-${index}`, ["schema"]);
    recovery.reject(`use-${index}`, ["schema"]);
  }
  assert.equal(recovery.exhausted, true);
  assert.equal(recovery.allRejected, false);
  assert.equal(recovery.allows("use-6"), true);
  assert.equal(recovery.rejectionCounts.schema, 5);
  recovery.observeUse("use-6", "duplicate event");
  assert.deepEqual(recovery.latestInput, { index: 6 });
  recovery.observeUse("use-7", "over budget");
  assert.equal(recovery.allows("use-7"), false);
  assert.deepEqual(recovery.latestInput, { index: 6 });
});

test("only completed originating queries make earlier references eligible", () => {
  const ledger = new ReviewEvidenceLedger("/repo");
  const page = (cursor: string, number: number, done: boolean, headSha = "b".repeat(40)) =>
    jsonResponse({
      page: number,
      content: `page ${number}`,
      done,
      ...(done ? {} : { nextCursor: cursor }),
      mergeBaseSha: "a".repeat(40),
      headSha,
    });
  const firstCall = call("read_pr_diff", { paths: [changedFile.path] }, page("one", 1, false));
  const [first] = ledger.observeBatch([firstCall]);
  assert.ok(first);
  assert.deepEqual(ledger.observeBatch([firstCall]), []);
  const [other] = ledger.observeBatch([
    call("read_pr_diff", { paths: [changedFile.path] }, page("two", 1, false)),
  ]);
  assert.ok(other);
  ledger.observeBatch([
    call("read_pr_diff", { paths: [changedFile.path], cursor: "two" }, page("two", 2, true)),
  ]);
  const issues = () =>
    reviewFindingGaps(
      {
        title: "Defect",
        severity: "HIGH",
        body: "Impact",
        path: changedFile.path,
        line: 1,
        evidenceRefs: [first.id],
        countercheck: "Checked the caller.",
        counterevidenceRefs: [],
      },
      [changedFile],
      ledger.issued,
    );
  assert.equal(issues().length, 1);
  ledger.observeBatch([
    call("read_pr_diff", { paths: [changedFile.path], cursor: "one" }, page("one", 3, true)),
  ]);
  assert.equal(issues().length, 1);
  ledger.observeBatch([
    call("read_pr_diff", { paths: [changedFile.path], cursor: "one" }, page("one", 2, false)),
  ]);
  assert.deepEqual(issues(), []);
  assert.equal(ledger.issued.get(first.id)?.status, "partial");
  assert.ok(ledger.issued.get(first.id)?.completedBy);
  assert.match(ledger.renderReferences([...ledger.issued.values()]), /completed_query=/u);
  const [mismatched] = ledger.observeBatch([call("read_pr_diff", {}, page("three", 1, false))]);
  assert.ok(mismatched);
  ledger.observeBatch([
    call("read_pr_diff", { cursor: "three" }, page("three", 2, true, "c".repeat(40))),
  ]);
  assert.equal(ledger.issued.get(mismatched.id)?.completedBy, undefined);
  const invalid = ledger.observeBatch([
    call("read_pr_diff", {}, jsonResponse({ page: 2, content: "tail", done: true })),
  ]);
  assert.equal(invalid[0]?.status, "failed");
  assert.deepEqual(
    ledger.observeBatch([call("read_review_state", {}, jsonResponse({ done: true }))]),
    [],
  );
});

test("uses returned whole-file bounds with explicit native Read limits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-complete-read-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "file.ts"), "line\n".repeat(192));
  const ledger = new ReviewEvidenceLedger(root);
  for (const input of [{ limit: 2000 }, { offset: 1 }, { offset: 1, limit: 2000 }, {}]) {
    const [reference] = ledger.observeBatch([
      call(
        "Read",
        { file_path: join(root, "file.ts"), ...input },
        {
          type: "text",
          file: {
            filePath: join(root, "file.ts"),
            startLine: 1,
            numLines: 192,
            totalLines: 192,
            content: "line\n".repeat(192),
          },
        },
      ),
    ]);
    assert.equal(reference?.status, "complete");
  }
  for (const file of [
    {
      startLine: 1,
      numLines: 192,
      totalLines: 192,
      content: "line\n".repeat(192),
      truncatedByTokenCap: true,
    },
    {
      startLine: 1,
      numLines: 192,
      totalLines: 192,
      content: "line\n".repeat(192),
      filePath: join(root, "wrong.ts"),
    },
    { startLine: 2, numLines: 191, totalLines: 192, content: "line\n".repeat(191) },
    { startLine: 1, numLines: 193, totalLines: 192, content: "contradictory" },
    { numLines: 192, totalLines: 192, content: "missing start" },
    { startLine: 1, numLines: 192, totalLines: 192 },
    { startLine: 1, numLines: 192, totalLines: 192, content: "[output truncated]" },
  ]) {
    const [reference] = ledger.observeBatch([
      call(
        "Read",
        { file_path: join(root, "file.ts"), limit: 2000 },
        { type: "text", file: { filePath: join(root, "file.ts"), ...file } },
      ),
    ]);
    assert.equal(reference?.status, "partial");
  }
});

test("requires the appropriate revision for modified, added, deleted, and renamed paths", () => {
  const files: ChangedFile[] = [
    changedFile,
    { ...changedFile, path: "added.ts", status: "added" },
    { ...changedFile, path: "deleted.ts", status: "removed" },
    { ...changedFile, path: "new.ts", previousPath: "old.ts", status: "renamed" },
  ];
  const ledger = new ReviewEvidenceLedger("/repo");
  for (const path of [changedFile.path, "added.ts", "deleted.ts", "new.ts", "old.ts"]) {
    for (const revision of ["base", "head"] as const) {
      const [reference] = ledger.observeBatch([
        call(
          "read_repository_file",
          { path, revision },
          jsonResponse({ kind: "text", page: 1, content: "source", done: true, path, revision }),
        ),
      ]);
      assert.ok(reference);
      const inspection = reviewInspection(files, new Map([[reference.id, reference]]));
      assert.equal(
        inspection.observedPaths.includes(path),
        revision === (path === "old.ts" || path === "deleted.ts" ? "base" : "head"),
      );
    }
  }
  assert.ok(
    ledger.referencesForPaths(["old.ts"]).every((reference) => reference.path === "old.ts"),
  );
});

test("briefing page replay requires all pages before the initial gate opens", () => {
  const reader = new agentInternals.ReviewBriefingReader(
    { ...goalContext, body: "Long PR context. ".repeat(4_000) },
    [],
    emptyConversation,
    { linkedIssues: [], linkedIssueReferencesTruncated: false },
  );
  const first = reader.readNext(1);
  assert.ok((first.totalPages ?? 0) > 2);
  const last = reader.readNext(first.totalPages);
  assert.equal(last.done, false);
  assert.equal(reader.complete, false);
  assert.deepEqual(reader.readNext(1).records, first.records);
  while (!reader.complete) reader.readNext();
  assert.deepEqual(reader.readNext(1).records, first.records);
  assert.equal(reader.readNext().records.length, 0);
  assert.throws(() => reader.readNext(0), /between/u);
  assert.throws(() => reader.readNext((first.totalPages ?? 0) + 1), /between/u);
});

for (const denied of ["withdrawal", "replacement"] as const) {
  test(`a denied buffered ${denied} cannot replace the last allowed candidate`, async (t) => {
    const repository = await recoveryRepository(t);
    const query = reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      yield* protocol.call("read_pr_diff", { paths: ["review.txt"] });
      const state = yield* recoveryState(protocol);
      const evidence = state.evidence.find((reference) => reference.kind === "repository_diff");
      assert.ok(evidence);
      for (let index = 0; index < 6; index += 1)
        assert.equal(
          (yield* protocol.call("submit_review", recoverySubmission(evidence.id))).isError,
          true,
        );
      const replacement = recoverySubmission(evidence.id);
      const replacementFinding = (replacement.findings as { title: string }[])[0];
      assert.ok(replacementFinding);
      replacementFinding.title = "Denied replacement";
      const input =
        denied === "withdrawal"
          ? { summary: "withdrawn", findings: [], limitations: [] }
          : replacement;
      const id = "denied-buffered-use";
      yield {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id, name: "mcp__review_output__submit_review", input }],
        },
      } as SDKMessage;
      const hook = protocol.options.hooks?.PreToolUse?.find((matcher) =>
        matcher.matcher?.includes("submit_review"),
      )?.hooks[0];
      assert.ok(hook);
      const decision = await hook(
        {
          hook_event_name: "PreToolUse",
          session_id: "protocol",
          transcript_path: "",
          cwd: "/repo",
          tool_name: "mcp__review_output__submit_review",
          tool_use_id: id,
          tool_input: input,
        },
        id,
        { signal: new AbortController().signal },
      );
      assert.ok(
        "hookSpecificOutput" in decision &&
          decision.hookSpecificOutput?.hookEventName === "PreToolUse",
      );
      assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
      yield {
        type: "user",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: id,
              is_error: true,
              content: "Denied by the submission recovery allowance.",
            },
          ],
        },
      };
      await protocol.closed;
    });
    const result = await runReviewGoal(
      "check",
      0,
      repository.context,
      [recoveryFile, { ...recoveryFile, path: "unread.txt" }],
      emptyConversation,
      reviewConfig({ interactWithPullRequest: true }),
      repository.diff,
      repository.root,
      query,
    );
    assert.equal(result.status, "incomplete");
    assert.equal(result.submission?.findings.length, 1);
    assert.equal(result.submission?.findings[0]?.title, "Unchecked result");
    assert.equal(result.diagnostics?.repairAttempts, 5);
  });
}

test("completes a large Git manifest through selected diffs and a small no-finding submission", async (t) => {
  const repository = await makeRepository(
    t,
    async (root) => {
      for (let index = 0; index < 251; index += 1)
        await writeFile(join(root, `consumer-${index}.ts`), `export const value = ${index};\n`);
      await writeFile(join(root, "empty.ts"), "");
      await writeFile(join(root, "binary.dat"), Buffer.from([0, 2, 3]));
      await chmod(join(root, "metadata.sh"), 0o755);
      await rename(join(root, "old.ts"), join(root, "renamed.ts"));
      await rm(join(root, "deleted.ts"));
    },
    async (root) => {
      await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
      await writeFile(join(root, "metadata.sh"), "echo ready\n", { mode: 0o644 });
      await writeFile(join(root, "old.ts"), "export const renamed = true;\n");
      await writeFile(join(root, "deleted.ts"), "export const removed = true;\n");
      await writeFile(join(root, "optional.ts"), "unchanged context\n".repeat(4_000));
    },
  );
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  assert.equal(files.length, 256);
  assert.equal(files.find((file) => file.path === "renamed.ts")?.previousPath, "old.ts");
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.temporaryRoot,
  );
  t.after(() => diff.cleanup());
  const result = await runReviewGoal(
    "check consumers",
    0,
    repository.context,
    files,
    emptyConversation,
    reviewConfig({ autoApprove: true }),
    diff,
    repository.root,
    reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      const small = { summary: "No actionable defects.", findings: [], limitations: [] };
      assert.ok(JSON.stringify(small).length < 100);
      assert.equal((yield* protocol.call("submit_review", small)).isError, true);
      const binary = protocolDocument(
        yield* protocol.call("read_repository_file", { path: "binary.dat", revision: "head" }),
      );
      assert.equal(binary.kind, "binary");
      const initial = yield* recoveryState(protocol);
      assert.equal(initial.inspection.observed, 0);
      for (const next of initial.calls.filter((call) => call.tool === "read_pr_diff")) {
        let args = next.arguments;
        for (;;) {
          const page = protocolDocument(yield* protocol.call(next.tool, args));
          if (page.done === true) break;
          args = { ...next.arguments, cursor: page.nextCursor };
        }
      }
      const observed = yield* recoveryState(protocol);
      assert.equal(observed.inspection.missing, 0);
      const optional = protocolDocument(
        yield* protocol.call("read_repository_file", { path: "optional.ts", revision: "head" }),
      );
      assert.equal(optional.done, false);
      assert.equal((yield* protocol.call("submit_review", small)).isError, undefined);
      yield protocolResult();
    }),
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(result.inspection?.missingPaths, []);
  assert.equal(result.diagnostics?.submissionAttempts, 2);
  assert.equal(
    aggregateReview(repository.context, reviewConfig({ autoApprove: true }), files, [result]).event,
    "APPROVE",
  );
});
