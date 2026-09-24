import {
  agentInternals,
  assert,
  makeReviewDiff,
  makeRepository,
  makeDiffFromSnapshots,
  join,
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
  type SDKMessage,
  type SDKResultMessage,
} from "./agent-test-helpers.js";
import { reviewProtocolQuery, type ReviewProtocol } from "./review-protocol-test-helpers.js";
import {
  ReviewSubmissionRecovery,
  retainValidReviewFindings,
} from "../src/runtime/review-submission.js";
import { aggregateReview, buildReviewBody } from "../src/lib/aggregate.js";
import type { ReviewAssessment, ReviewEvidenceReference } from "../src/lib/types.js";
import {
  ReviewEvidenceLedger,
  findInvalidReviewAssessment,
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
function coverage(
  path: string,
  evidenceRefs: readonly string[],
  disposition: "reviewed" | "incomplete" = "reviewed",
): ReviewAssessment["coverage"][number] {
  return { paths: [path], evidenceRefs, disposition, rationale: "Checked the captured path." };
}
interface RecoveryState {
  readonly manifest: readonly { path: string }[];
  readonly evidence: readonly ReviewEvidenceReference[];
  readonly gaps: readonly { category: string; paths: readonly string[] }[];
  readonly remainingCorrections: number;
  readonly submissionAttempts: number;
  readonly headSha: string;
}

function protocolDocument(response: {
  readonly content: readonly { readonly text?: string }[];
}): Record<string, unknown> {
  return JSON.parse(response.content[0]?.text ?? "{}") as Record<string, unknown>;
}

async function* recoveryState(
  protocol: ReviewProtocol,
  paths?: string[],
): AsyncGenerator<SDKMessage, RecoveryState> {
  let cursor: string | undefined;
  let content = "";
  for (;;) {
    const response = yield* protocol.call("read_review_state", {
      ...(paths === undefined ? {} : { paths }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(response)) <= agentInternals.MODEL_TOOL_RESULT_BYTES,
    );
    const page = protocolDocument(response);
    content += String(page.content);
    if (page.done === true) return JSON.parse(content) as RecoveryState;
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
      },
    ],
    assessment: {
      coverage: [
        {
          paths: ["review.txt"],
          disposition: "reviewed",
          rationale: "Inspected the changed caller.",
          evidenceRefs: [evidenceRef],
        },
      ],
      candidates: [
        {
          paths: ["review.txt"],
          trigger: "The operation returns an error.",
          impact: "The caller reports success.",
          evidenceRefs: [evidenceRef],
          countercheck: "Checked the caller for handling.",
          counterevidenceRefs: [],
          verdict: "supported",
          findingIndex: 0,
        },
      ],
    },
  };
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
      assessment: { coverage: [], candidates: [] },
    });
    assert.equal(rejected.isError, true);
    const response = protocolDocument(rejected);
    assert.ok(Number(response.omittedGaps) > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(rejected)) < agentInternals.MODEL_TOOL_RESULT_BYTES);
    assert.equal(
      (yield* protocol.call("read_review_state", { cursor, paths: ["src/consumer-1.ts"] })).isError,
      true,
    );
    let content = String(first.content);
    let next = cursor;
    for (;;) {
      const page = protocolDocument(yield* protocol.call("read_review_state", { cursor: next }));
      content += String(page.content);
      if (page.done === true) break;
      next = String(page.nextCursor);
    }
    const original = JSON.parse(content) as RecoveryState;
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
        { summary: "missing assessment", findings: [] },
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
    const files = [recoveryFile, { ...recoveryFile, path: "unread.txt", status: "added" }];
    const query = reviewProtocolQuery(async function* (protocol) {
      yield* protocolBriefing(protocol);
      yield* protocol.call("read_pr_diff", {});
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
              ? { ...submission, findings: [], assessment: { coverage: [], candidates: [] } }
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
      goalContext,
      files,
      emptyConversation,
      config,
      await makeReviewDiff(t),
      "/repo",
      query,
    );
    assert.equal(result.status, replacement === "unchanged" ? "incomplete" : "failed");
    assert.equal(result.submission?.findings.length ?? 0, replacement === "unchanged" ? 1 : 0);
    if (replacement === "unchanged") {
      assert.deepEqual(
        result.submission?.assessment.coverage.map((entry) => entry.disposition),
        ["reviewed", "incomplete"],
      );
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
        assessment: { coverage: [], candidates: [] },
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
  assert.equal(result.diagnostics?.rejectionCounts.coverage, 1);
  assert.equal(result.diagnostics?.rejectionCounts.empty_turn, 5);
});

for (const termination of ["exhausted", "provider", "mcp"] as const) {
  test(`preserves safe current findings and failed status when appropriate: ${termination}`, async (t) => {
    const config = reviewConfig({
      interactWithPullRequest: true,
      ...(termination === "mcp"
        ? { mcpServers: { knowledge: { type: "http" as const, url: "https://example.test/mcp" } } }
        : {}),
    });
    const query = reviewProtocolQuery(
      async function* (protocol) {
        yield* protocolBriefing(protocol);
        yield* protocol.call("read_pr_diff", {});
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
      goalContext,
      [recoveryFile, { ...recoveryFile, path: "unread.txt" }],
      emptyConversation,
      config,
      await makeReviewDiff(t),
      "/repo",
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
        assessment: {
          coverage: [
            {
              paths: ["review.txt"],
              disposition: "incomplete",
              rationale: "No repository evidence was read.",
              evidenceRefs: [],
            },
          ],
          candidates: [],
        },
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

test("retains valid findings independently of malformed peers and preserves valid coverage", () => {
  const evidence = new Map<string, ReviewEvidenceReference>([
    ["ev-1", { id: "ev-1", kind: "repository_diff", status: "complete", changedPaths: true }],
  ]);
  const raw = recoverySubmission("ev-1");
  const assessment = raw.assessment as { coverage: unknown[]; candidates: unknown[] };
  const findings = raw.findings as unknown[];
  const input = {
    ...raw,
    findings: [...findings, { title: "invalid peer" }],
    assessment: {
      coverage: [...assessment.coverage, { paths: ["unread.txt"], disposition: "invalid" }],
      candidates: [...assessment.candidates, { verdict: "supported", findingIndex: 1 }],
    },
  };
  const files = [recoveryFile, { ...recoveryFile, path: "unread.txt" }];
  const retained = retainValidReviewFindings(input, files, evidence, () => true);
  assert.equal(retained?.findings.length, 1);
  assert.equal(retained?.assessment.coverage[0]?.disposition, "reviewed");
  assert.equal(retained?.assessment.coverage[1]?.disposition, "incomplete");
  assert.equal(
    retainValidReviewFindings(input, files, evidence, () => false),
    undefined,
  );
  assert.equal(
    retainValidReviewFindings(
      {
        ...input,
        assessment: {
          ...input.assessment,
          candidates: [...assessment.candidates, ...assessment.candidates],
        },
      },
      files,
      evidence,
      () => true,
    ),
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
    findInvalidReviewAssessment(
      { coverage: [coverage(changedFile.path, [first.id])], candidates: [] },
      [],
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
          file: { startLine: 1, numLines: 192, totalLines: 192, content: "line\n".repeat(192) },
        },
      ),
    ]);
    assert.equal(reference?.status, "complete");
  }
  for (const file of [
    { startLine: 1, numLines: 191, totalLines: 192, content: "partial" },
    { startLine: 1, numLines: 193, totalLines: 192, content: "contradictory" },
    { numLines: 192, totalLines: 192, content: "missing start" },
    { startLine: 1, numLines: 192, totalLines: 192 },
    { startLine: 1, numLines: 192, totalLines: 192, content: "[output truncated]" },
  ]) {
    const [reference] = ledger.observeBatch([
      call("Read", { file_path: join(root, "file.ts"), limit: 2000 }, { type: "text", file }),
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
      const issues = findInvalidReviewAssessment(
        {
          coverage: [
            coverage(path, [reference.id]),
            ...files
              .flatMap((file) => [
                file.path,
                ...(file.previousPath === undefined ? [] : [file.previousPath]),
              ])
              .filter((value) => value !== path)
              .map((value) => coverage(value, [], "incomplete")),
          ],
          candidates: [],
        },
        [],
        files,
        ledger.issued,
      );
      assert.equal(
        issues.length,
        revision === (path === "old.ts" || path === "deleted.ts" ? "base" : "head") ? 0 : 1,
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
