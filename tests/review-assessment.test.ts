import { ReviewQueryReaderStore } from "../src/runtime/review-context-tools.js";
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ChangedFile,
  ReviewFindingEvidence,
  ReviewEvidenceReference,
  ReviewFinding,
} from "../src/lib/types.js";
import {
  ReviewEvidenceLedger,
  reviewFindingGaps,
  reviewInspection,
  reviewAssessmentInternals,
  reviewEvidenceResultSchema,
} from "../src/runtime/review-assessment.js";

import { submissionSchema, reviewSubmissionGaps } from "../src/runtime/review-submission.js";
import { ReviewSubmissionRecovery } from "../src/runtime/review-submission.js";
import { createReviewStateTool } from "../src/runtime/review-context-tools.js";
import { MODEL_TOOL_RESULT_BYTES } from "../src/runtime/agent-review-tools.js";

const changedFile: ChangedFile = {
  path: "src/change.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  addedLines: new Set([1]),
};

const finding: ReviewFinding = {
  title: "Unchecked result",
  severity: "HIGH",
  body: "The caller drops a result on a reachable path.",
  path: "src/change.ts",
  line: 1,
};

const proof: ReviewFindingEvidence = {
  evidenceRefs: ["ev-1"],
  countercheck: "Checked the caller and found no error handling.",
  counterevidenceRefs: [],
};

let nextToolUse = 0;

function call(
  tool_name: string,
  tool_input: unknown,
  response: unknown,
): {
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly tool_use_id: string;
  readonly tool_response: unknown;
} {
  return {
    tool_name,
    tool_input,
    tool_use_id: `${tool_name}-${++nextToolUse}`,
    tool_response: response,
  };
}

function jsonResponse(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function repositoryEvidence(
  overrides: Partial<ReviewEvidenceReference> = {},
): ReviewEvidenceReference {
  return {
    id: "ev-1",
    kind: "repository_diff",
    status: "complete",
    changedPaths: true,
    mergeBaseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    ...overrides,
  };
}

test("accepts the small closed submission contract with inline finding proof", () => {
  const submission = {
    summary: "Checked the change.",
    findings: [],
    limitations: [],
  };
  assert.equal(submissionSchema.safeParse(submission).success, true);
  assert.equal(submissionSchema.safeParse({ ...submission, assessment: {} }).success, false);
  const raw = {
    ...proof,
    title: finding.title,
    severity: finding.severity,
    why: finding.body,
    fix: "Handle the error.",
  };
  assert.equal(submissionSchema.safeParse({ ...submission, findings: [raw] }).success, true);
  for (const change of [{ evidenceRefs: [] }, { countercheck: " " }, { findingIndex: 0 }])
    assert.equal(
      submissionSchema.safeParse({ ...submission, findings: [{ ...raw, ...change }] }).success,
      false,
    );
  assert.equal(reviewEvidenceResultSchema.safeParse(repositoryEvidence()).success, true);
  assert.equal(
    reviewEvidenceResultSchema.safeParse({ ...repositoryEvidence(), status: "unknown" }).success,
    false,
  );
});

test("issues host evidence for complete and partial fixed-revision reads", () => {
  const ledger = new ReviewEvidenceLedger("/repo");
  const first = ledger.observeBatch([
    call(
      "mcp__review_output__read_pr_diff",
      { paths: ["src/change.ts"] },
      jsonResponse({
        paths: ["src/change.ts"],
        mergeBaseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        page: 1,
        content: "diff page",
        done: false,
        nextCursor: "diff-cursor",
      }),
    ),
    call(
      "mcp__review_output__read_repository_file",
      { revision: "base", path: "unchanged.ts" },
      jsonResponse({
        revision: "base",
        path: "unchanged.ts",
        kind: "text",
        page: 1,
        content: "file page",
        done: false,
        nextCursor: "file-cursor",
      }),
    ),
  ]);
  assert.deepEqual(
    first.map((reference) => reference.status),
    ["partial", "partial"],
  );
  assert.deepEqual(
    first.map((reference) => reference.id),
    ["ev-1", "ev-2"],
  );

  const next = ledger.observeBatch([
    call(
      "mcp__review_output__read_pr_diff",
      { paths: ["src/change.ts"], cursor: "diff-cursor" },
      jsonResponse({
        paths: ["src/change.ts"],
        mergeBaseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        page: 2,
        content: "diff tail",
        done: true,
      }),
    ),
    call(
      "mcp__review_output__read_repository_file",
      { revision: "base", path: "unchanged.ts", cursor: "file-cursor" },
      jsonResponse({
        revision: "base",
        path: "unchanged.ts",
        kind: "text",
        page: 2,
        content: "file tail",
        done: true,
      }),
    ),
  ]);
  assert.deepEqual(
    next.map((reference) => reference.status),
    ["complete", "complete"],
  );
  assert.deepEqual(next[0], {
    id: "ev-3",
    kind: "repository_diff",
    status: "complete",
    changedPaths: false,
    paths: ["src/change.ts"],
    mergeBaseSha: "a".repeat(40),
    headSha: "b".repeat(40),
  });
  assert.deepEqual(next[1], {
    id: "ev-4",
    kind: "repository_file",
    status: "complete",
    path: "unchanged.ts",
    revision: "base",
    contentKind: "text",
  });
  assert.equal(ledger.issued.size, 4);
});

test("retains cursor evidence after a recoverable selector error", () => {
  const ledger = new ReviewEvidenceLedger("/repo");
  const first = ledger.observeBatch([
    call(
      "mcp__review_output__read_pr_diff",
      { paths: ["src/change.ts"] },
      jsonResponse({
        paths: ["src/change.ts"],
        mergeBaseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        page: 1,
        content: "diff page",
        done: false,
        nextCursor: "recoverable-cursor",
      }),
    ),
  ]);
  assert.deepEqual(
    first.map((reference) => reference.status),
    ["partial"],
  );

  const rejected = ledger.observeBatch([
    call(
      "mcp__review_output__read_pr_diff",
      { paths: ["src/other.ts"], cursor: "recoverable-cursor" },
      jsonResponse({ error: "The cursor does not match the supplied read selection." }),
    ),
  ]);
  assert.deepEqual(
    rejected.map((reference) => reference.status),
    ["failed"],
  );

  const recovered = ledger.observeBatch([
    call(
      "mcp__review_output__read_pr_diff",
      { paths: ["src/change.ts"], cursor: "recoverable-cursor" },
      jsonResponse({
        paths: ["src/change.ts"],
        mergeBaseSha: "a".repeat(40),
        headSha: "b".repeat(40),
        page: 2,
        content: "diff tail",
        done: true,
      }),
    ),
  ]);
  assert.deepEqual(
    recovered.map((reference) => reference.status),
    ["complete"],
  );
  assert.deepEqual(recovered[0]?.paths, ["src/change.ts"]);

  const expiredLedger = new ReviewEvidenceLedger("/repo");
  expiredLedger.observeBatch([
    call(
      "mcp__review_output__read_pr_diff",
      { paths: ["src/change.ts"] },
      jsonResponse({
        paths: ["src/change.ts"],
        page: 1,
        content: "diff page",
        done: false,
        nextCursor: "expired-cursor",
      }),
    ),
  ]);
  expiredLedger.observeBatch([
    call(
      "mcp__review_output__read_pr_diff",
      { cursor: "expired-cursor" },
      {
        isError: true,
        content: [
          {
            type: "text",
            text: "The cursor is unknown, expired, or already complete. Restart this read.",
          },
        ],
      },
    ),
  ]);
  assert.deepEqual(
    expiredLedger.observeBatch([
      call(
        "mcp__review_output__read_pr_diff",
        { cursor: "expired-cursor" },
        jsonResponse({ done: true }),
      ),
    ]),
    [],
  );
});

test("records native repository reads, searches, context, briefing, discussion, and MCP output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-read-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "src/change.ts");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(sourcePath, "source\n");
  const ledger = new ReviewEvidenceLedger(root);
  const observed = ledger.observeBatch([
    call(
      "Read",
      { file_path: sourcePath },
      {
        type: "text",
        file: {
          filePath: sourcePath,
          content: "source",
          numLines: 1,
          startLine: 1,
          totalLines: 1,
        },
      },
    ),
    call(
      "Grep",
      { path: "src/change.ts", pattern: "return" },
      jsonResponse({
        mode: "content",
        numFiles: 1,
        filenames: ["src/change.ts"],
        content: "1:return value",
        numLines: 1,
        numMatches: 1,
        totalFiles: 1,
        totalLines: 1,
        appliedLimit: 250,
        appliedOffset: 0,
      }),
    ),
    call("Glob", { path: "src", pattern: "**/*.ts" }, jsonResponse({ paths: [] })),
    call(
      "mcp__review_output__read_context_file",
      { path: "/runner/ticket.json" },
      jsonResponse({ done: true }),
    ),
    call("mcp__review_output__read_review_briefing", {}, jsonResponse({ done: true })),
    call("mcp__review_output__read_pr_conversation", {}, jsonResponse({ done: true })),
    call("mcp__review_output__read_pr_threads", { id: 42 }, jsonResponse({ done: true })),
    call("mcp__security__inspect", { path: "src/change.ts" }, jsonResponse({ result: "context" })),
    call("mcp__review_output__submit_review", {}, jsonResponse({ done: true })),
  ]);
  assert.deepEqual(
    observed.map((reference) => reference.kind),
    [
      "repository_read",
      "repository_search",
      "repository_glob",
      "context_file",
      "briefing",
      "conversation",
      "conversation",
      "external_tool",
    ],
  );
  assert.equal(ledger.issued.has("ev-9"), false);
  assert.equal(ledger.issued.get("ev-1")?.path, "src/change.ts");
  assert.equal(ledger.issued.get("ev-1")?.status, "complete");
  assert.equal(ledger.issued.get("ev-2")?.status, "complete");
  assert.equal(ledger.issued.get("ev-6")?.kind, "conversation");
  assert.equal(ledger.issued.get("ev-7")?.path, undefined);
  assert.equal(ledger.issued.get("ev-8")?.kind, "external_tool");
  assert.deepEqual(
    reviewFindingGaps(
      { ...finding, ...proof, evidenceRefs: ["ev-2"] },
      [changedFile],
      ledger.issued,
    ),
    [],
  );
  assert.deepEqual(reviewInspection([changedFile], ledger.issued), {
    observedPaths: [changedFile.path],
    missingPaths: [],
  });
});

test("does not issue native-read evidence for symlink paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-read-evidence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const regularPath = join(root, "target.ts");
  const symlinkPath = join(root, "linked.ts");
  const directoryPath = join(root, "real-directory");
  const linkedDirectoryPath = join(root, "linked-directory");
  await writeFile(regularPath, "source\n");
  await symlink(regularPath, symlinkPath);
  await mkdir(directoryPath);
  await writeFile(join(directoryPath, "nested.ts"), "nested source\n");
  await symlink(directoryPath, linkedDirectoryPath, "dir");

  const response = (filePath: string) => ({
    type: "text",
    file: { filePath, content: "source", numLines: 1, startLine: 1, totalLines: 1 },
  });
  const ledger = new ReviewEvidenceLedger(root);
  const [regularRead] = ledger.observeBatch([
    call("Read", { file_path: regularPath }, response(regularPath)),
  ]);
  assert.equal(regularRead?.status, "complete");
  assert.deepEqual(
    ledger.observeBatch([call("Read", { file_path: symlinkPath }, response(symlinkPath))]),
    [],
  );
  const nestedPath = join(linkedDirectoryPath, "nested.ts");
  assert.deepEqual(
    ledger.observeBatch([call("Read", { file_path: nestedPath }, response(nestedPath))]),
    [],
  );
  assert.equal(ledger.issued.size, 1);
});

test("does not accept an empty native search as changed-path coverage", () => {
  const ledger = new ReviewEvidenceLedger("/repo");
  const [search] = ledger.observeBatch([
    call(
      "Grep",
      { path: "src/change.ts", pattern: "absent-symbol" },
      jsonResponse({
        mode: "files_with_matches",
        numFiles: 0,
        filenames: [],
        content: "",
        numLines: 0,
        numMatches: 0,
        totalFiles: 0,
        totalLines: 0,
        appliedLimit: 250,
        appliedOffset: 0,
      }),
    ),
  ]);
  assert.ok(search);
  assert.equal(search.kind, "repository_search");
  assert.equal(search.status, "complete");

  assert.deepEqual(reviewInspection([changedFile], ledger.issued).missingPaths, [changedFile.path]);
});

test("limits native read evidence to the returned range without certifying the whole file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-bounded-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "src/change.ts");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(sourcePath, "source\n");
  const ledger = new ReviewEvidenceLedger(root);
  const observed = ledger.observeBatch([
    call(
      "Read",
      { file_path: sourcePath, offset: 10, limit: 20 },
      {
        type: "text",
        file: {
          filePath: sourcePath,
          content: "source\n".repeat(20),
          numLines: 20,
          startLine: 10,
          totalLines: 80,
        },
      },
    ),
    call(
      "Grep",
      { path: "src/change.ts", pattern: "return", offset: 3, head_limit: 5 },
      jsonResponse({
        mode: "content",
        numFiles: 1,
        filenames: ["src/change.ts"],
        content: "limited matches",
        numLines: 5,
        totalLines: 30,
        appliedLimit: 5,
        appliedOffset: 3,
      }),
    ),
  ]);
  assert.deepEqual(
    observed.map((reference) => reference.status),
    ["complete", "partial"],
  );
  assert.deepEqual(observed[0]?.bounds, {
    offset: 10,
    limit: 20,
    startLine: 10,
    numLines: 20,
    totalLines: 80,
  });
  assert.deepEqual(observed[1]?.bounds, { offset: 3, headLimit: 5, truncated: true });
  assert.deepEqual(reviewInspection([changedFile], ledger.issued).missingPaths, [changedFile.path]);
  for (const [line, endLine, valid] of [
    [10, 29, true],
    [9, 10, false],
    [29, 30, false],
  ] as const)
    assert.equal(
      reviewFindingGaps({ ...finding, ...proof, line, endLine }, [changedFile], ledger.issued)
        .length,
      valid ? 0 : 1,
    );
});

test("does not issue evidence for paths outside the checkout or inside Git metadata", () => {
  const ledger = new ReviewEvidenceLedger("/repo");
  assert.deepEqual(
    ledger.observeBatch([
      call("Read", { file_path: "/outside/secret.txt" }, { content: [] }),
      call("Read", { file_path: "/repo/.git/config" }, { content: [] }),
      call("Read", { file_path: "/repo/src\u0000change.ts" }, { content: [] }),
    ]),
    [],
  );
  assert.equal(reviewAssessmentInternals.repositoryRelativePath("/repo", "/repo"), ".");
  assert.equal(
    reviewAssessmentInternals.repositoryRelativePath("/repo", "src/change.ts"),
    "src/change.ts",
  );
  assert.equal(reviewAssessmentInternals.repositoryRelativePath("/repo", "../secret"), undefined);
  assert.equal(reviewAssessmentInternals.repositoryRelativePath("/repo", ".git/config"), undefined);
  assert.equal(
    reviewAssessmentInternals.repositoryRelativePath("/repo", "src\u0000change.ts"),
    undefined,
  );
});

test("marks tool failures and cursor errors failed and bounds the returned evidence list", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-failed-read-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = join(root, "src/change.ts");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(sourcePath, "source\n");
  const ledger = new ReviewEvidenceLedger(root);
  const failed = ledger.observeBatch([
    call(
      "Grep",
      { path: "src/change.ts" },
      { isError: true, content: [{ type: "text", text: "denied" }] },
    ),
    call("Read", { file_path: sourcePath }, undefined),
    call("Glob", { path: "src" }, { error: "search failed" }),
    call("mcp__review_output__read_pr_diff", { cursor: "forged" }, jsonResponse({ done: true })),
  ]);
  assert.deepEqual(
    failed.map((reference) => reference.status),
    ["failed", "failed", "failed"],
  );
  assert.equal(ledger.issued.size, 3);
  assert.equal(reviewAssessmentInternals.explicitToolFailure({ error: null }), true);
  assert.equal(reviewAssessmentInternals.explicitToolFailure({ content: [] }), false);
  assert.deepEqual(reviewAssessmentInternals.toolResponseDocument("not json"), undefined);
  assert.match(ledger.renderReferences(failed, 1), /additional references are omitted/u);
});

test("records partial pagination from a top-level MCP content array", () => {
  const ledger = new ReviewEvidenceLedger("/repo");
  const [reference] = ledger.observeBatch([
    call("mcp__review_output__read_pr_diff", { paths: ["src/change.ts"] }, [
      {
        type: "text",
        text: JSON.stringify({
          page: 1,
          content: "diff page",
          done: false,
          nextCursor: "next-page",
        }),
      },
    ]),
  ]);
  assert.equal(reference?.status, "partial");
  assert.equal(
    reviewAssessmentInternals.toolResponseDocument([
      {
        type: "text",
        text: JSON.stringify({
          page: 1,
          content: "diff page",
          done: false,
          nextCursor: "next-page",
        }),
      },
    ])?.done,
    false,
  );
});

test("rejects unstructured full-diff responses as evidence", () => {
  const responses = [
    [{ type: "text", text: "Wait for the full review prompt before reading." }],
    jsonResponse({ done: true }),
  ];
  for (const response of responses) {
    const ledger = new ReviewEvidenceLedger("/repo");
    const [reference] = ledger.observeBatch([
      call("mcp__review_output__read_pr_diff", {}, response),
    ]);
    assert.equal(reference?.status, "failed");
    assert.ok(reference);
    assert.deepEqual(reviewInspection([changedFile], ledger.issued).missingPaths, [
      changedFile.path,
    ]);
  }
});

test("requires complete repository proof applicable to each finding", () => {
  for (const reference of [
    repositoryEvidence(),
    repositoryEvidence({ status: "partial" }),
    repositoryEvidence({ kind: "briefing" }),
    repositoryEvidence({ changedPaths: false, paths: ["unrelated.ts"] }),
  ]) {
    const evidence = new Map([[reference.id, reference]]);
    const valid =
      reference.kind === "repository_diff" &&
      reference.status === "complete" &&
      reference.changedPaths === true;
    assert.equal(
      reviewFindingGaps({ ...finding, ...proof }, [changedFile], evidence).length,
      valid ? 0 : 1,
    );
    assert.equal(reviewInspection([changedFile], evidence).missingPaths.length, valid ? 0 : 1);
  }
  assert.equal(reviewFindingGaps({ ...finding, ...proof }, [changedFile], new Map()).length, 1);
});

test("validates repository counterevidence directly on the finding", () => {
  const references = new Map<string, ReviewEvidenceReference>([
    ["ev-1", repositoryEvidence()],
    ["ev-2", { id: "ev-2", kind: "conversation", status: "complete" }],
    ["ev-3", repositoryEvidence({ id: "ev-3", changedPaths: false, paths: ["guard.ts"] })],
  ]);
  for (const [id, valid] of [
    ["ev-2", false],
    ["ev-3", true],
    ["ev-99", false],
  ] as const)
    assert.equal(
      reviewFindingGaps(
        { ...finding, ...proof, counterevidenceRefs: [id] },
        [changedFile],
        references,
      ).length,
      valid ? 0 : 1,
    );
});

test("requires inspection despite declared limitations and validates summary locations", () => {
  const ledger = new ReviewEvidenceLedger("/repo");
  const small = { summary: "done", findings: [], limitations: [] };
  const gaps = (input: unknown) =>
    reviewSubmissionGaps(input, [changedFile], ledger, false, true, () => []);
  assert.equal(gaps(small)[0]?.category, "inspection");
  assert.equal(
    gaps({
      ...small,
      limitations: [
        { paths: [], reason: "The provider stopped before required investigation finished." },
      ],
    }).some((gap) => gap.category === "inspection"),
    true,
  );
  assert.equal(
    gaps({ ...small, limitations: [{ paths: ["unrelated.ts"], reason: "unavailable" }] })[0]
      ?.category,
    "schema",
  );
  const [reference] = ledger.observeBatch([
    call("read_pr_diff", {}, jsonResponse({ page: 1, content: "diff", done: true })),
  ]);
  assert.ok(reference);
  const supported = {
    ...proof,
    evidenceRefs: [reference.id],
    title: finding.title,
    severity: finding.severity,
    why: finding.body,
    fix: "Handle the error.",
  };
  assert.deepEqual(gaps({ ...small, findings: [supported] }), []);
  for (const location of [
    { path: "unrelated.ts" },
    { line: 1 },
    { path: changedFile.path, line: 2 },
    { path: changedFile.path, line: 1, endLine: 2 },
  ])
    assert.ok(
      gaps({ ...small, findings: [{ ...supported, ...location }] }).some(
        (gap) => gap.category === "location",
      ),
    );
});

test("covers only exact repository paths unless a complete diff covers all changed paths", () => {
  assert.equal(
    reviewAssessmentInternals.evidenceCoversPath(repositoryEvidence(), "src/change.ts"),
    true,
  );
  assert.equal(
    reviewAssessmentInternals.evidenceCoversPath(
      { id: "ev-2", kind: "repository_diff", status: "complete", paths: ["src/change.ts"] },
      "src/change.ts",
    ),
    true,
  );
  assert.equal(
    reviewAssessmentInternals.evidenceCoversPath(
      { id: "ev-2", kind: "repository_glob", status: "complete", path: "src" },
      "src/change.ts",
    ),
    false,
  );
  assert.equal(
    reviewAssessmentInternals.evidenceCoversPath(
      { id: "ev-3", kind: "external_tool", status: "complete" },
      "src/change.ts",
    ),
    false,
  );
  assert.equal(
    reviewAssessmentInternals.evidenceCoversPath(
      {
        id: "ev-4",
        kind: "repository_file",
        status: "complete",
        path: "src/change.ts",
        contentKind: "binary",
      },
      "src/change.ts",
    ),
    false,
  );
  assert.equal(
    reviewAssessmentInternals.evidenceCoversPath(
      {
        id: "ev-5",
        kind: "repository_file",
        status: "complete",
        path: "src/change.ts",
        contentKind: "text",
      },
      "src/change.ts",
    ),
    true,
  );
  assert.equal(
    reviewAssessmentInternals.isRepositoryEvidence({
      id: "ev-6",
      kind: "repository_file",
      status: "complete",
      path: "src/change.ts",
      contentKind: "text",
    }),
    true,
  );
  assert.equal(
    reviewAssessmentInternals.toolResponseDocument(jsonResponse({ done: true }))?.done,
    true,
  );
});

test("keeps four structured state snapshots without advancing or evicting source cursors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "review-state-readers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "source");
  const content = "source line\n".repeat(8_000);
  await writeFile(path, content);
  const readers = new ReviewQueryReaderStore(() => undefined);
  t.after(() => Promise.all(readers.cleanupOperations()));
  const source = { path, sizeBytes: Buffer.byteLength(content), cleanup: () => Promise.resolve() };
  const query = readers.createSource(source, "repository_file", {
    path: changedFile.path,
    revision: "head",
    kind: "text",
  });
  await query.reader.readNext({ nextCursor: query.cursor });
  for (let index = 1; index < 32; index += 1)
    readers.createSource(source, "repository_file", {
      path: `optional-${index}.ts`,
      revision: "base",
      kind: "text",
    });
  const ledger = new ReviewEvidenceLedger(root);
  const recovery = new ReviewSubmissionRecovery();
  const state = createReviewStateTool({
    signal: undefined,
    isActive: () => true,
    files: [
      { ...changedFile, previousPath: "old.ts", status: "renamed" },
      ...Array.from({ length: 600 }, (_, index) => ({ ...changedFile, path: `other-${index}.ts` })),
    ],
    headSha: "b".repeat(40),
    mergeBaseSha: "a".repeat(40),
    briefingComplete: () => true,
    ledger,
    readers,
    recovery,
    gaps: () => [],
  });
  const document = (result: unknown) => {
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MODEL_TOOL_RESULT_BYTES);
    const parsed = reviewAssessmentInternals.toolResponseDocument(result);
    assert.ok(parsed);
    return parsed;
  };
  const first = document(await state.handler({ paths: undefined, cursor: undefined }, {}));
  assert.equal(first.done, false);
  assert.equal(first.content, undefined);
  const records = first.records as {
    kind: string;
    tool?: string;
    arguments?: Record<string, unknown>;
  }[];
  assert.equal(records[0]?.kind, "next_call");
  assert.equal(records[0]?.tool, "read_pr_diff");
  const restartedPaths = records[0]?.arguments?.paths;
  assert.ok(Array.isArray(restartedPaths));
  assert.ok(restartedPaths.includes(changedFile.path));
  assert.ok(restartedPaths.includes("old.ts"));
  const cursor = String(first.nextCursor);
  const original = document(await state.handler({ paths: undefined, cursor }, {}));
  ledger.observeBatch([
    call(
      "read_repository_file",
      { path: "old.ts", revision: "base" },
      jsonResponse({ kind: "text", page: 1, content: "old source", done: true }),
    ),
  ]);
  const originalFirst = document(
    await state.handler({ paths: undefined, cursor: cursor.replace(/:2$/u, ":1") }, {}),
  );
  assert.deepEqual(originalFirst, first);
  recovery.observeUse("rejected", {});
  for (let index = 0; index < 3; index += 1)
    await state.handler({ paths: undefined, cursor: undefined }, {});
  assert.deepEqual(document(await state.handler({ paths: undefined, cursor }, {})), original);
  await state.handler({ paths: undefined, cursor: undefined }, {});
  const expired = await state.handler({ paths: undefined, cursor }, {});
  assert.equal(expired.isError, true);
  assert.match(JSON.stringify(expired), /expired/u);
  assert.equal(readers.has(query.cursor), true);
  assert.equal(ledger.issued.size, 1);
  const mismatch = document(
    await readers.readPage(query.cursor, "repository_file", { revision: "base", path: "wrong.ts" }),
  );
  assert.deepEqual(mismatch.nextCall, {
    tool: "read_repository_file",
    arguments: { revision: "head", path: changedFile.path, cursor: query.cursor },
  });
  const resumed = document(
    await readers.readPage(query.cursor, "repository_file", {
      revision: "head",
      path: changedFile.path,
    }),
  );
  assert.equal(resumed.page, 2);
});

test("reports both rename sides consistently for base, head, diff, and filtered recovery", async () => {
  const renamed = { ...changedFile, path: "new.ts", previousPath: "old.ts", status: "renamed" };
  for (const mode of ["none", "base", "head", "diff"] as const) {
    const ledger = new ReviewEvidenceLedger("/repo");
    if (mode === "diff")
      ledger.observeBatch([
        call(
          "read_pr_diff",
          { paths: ["new.ts", "old.ts"] },
          jsonResponse({ page: 1, content: "rename diff", done: true }),
        ),
      ]);
    else if (mode !== "none")
      ledger.observeBatch([
        call(
          "read_repository_file",
          {
            path: mode === "base" ? "old.ts" : "new.ts",
            revision: mode,
          },
          jsonResponse({ kind: "text", page: 1, content: "source", done: true }),
        ),
      ]);
    const state = createReviewStateTool({
      signal: undefined,
      isActive: () => true,
      files: [renamed],
      headSha: "b".repeat(40),
      mergeBaseSha: "a".repeat(40),
      briefingComplete: () => true,
      ledger,
      readers: new ReviewQueryReaderStore(() => undefined),
      recovery: new ReviewSubmissionRecovery(),
      gaps: () => [],
    });
    const expected = {
      kind: "changed_file",
      path: "new.ts",
      previousPath: "old.ts",
      status: "renamed",
      observed: mode === "head" || mode === "diff",
      previousObserved: mode === "base" || mode === "diff",
    };
    for (const paths of [undefined, ["old.ts"], ["new.ts"]]) {
      const response = await state.handler({ paths, cursor: undefined }, {});
      assert.ok(Buffer.byteLength(JSON.stringify(response)) <= MODEL_TOOL_RESULT_BYTES);
      const document = reviewAssessmentInternals.toolResponseDocument(response);
      assert.ok(document);
      const records = document.records as Record<string, unknown>[];
      assert.deepEqual(
        records.find((record) => record.kind === "changed_file"),
        expected,
      );
      const unread = [
        ...(expected.observed ? [] : ["new.ts"]),
        ...(expected.previousObserved ? [] : ["old.ts"]),
      ].filter((path) => paths === undefined || paths.includes(path));
      assert.deepEqual(
        records
          .filter((record) => record.kind === "next_call")
          .map(({ kind, tool, arguments: args }) => ({ kind, tool, arguments: args })),
        unread.length === 0
          ? []
          : [{ kind: "next_call", tool: "read_pr_diff", arguments: { paths: unread } }],
      );
    }
  }
});
