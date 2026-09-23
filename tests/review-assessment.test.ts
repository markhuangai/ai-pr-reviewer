import { strict as assert } from "node:assert";
import test from "node:test";

import type {
  ChangedFile,
  ReviewAssessment,
  ReviewEvidenceReference,
  ReviewFinding,
} from "../src/lib/types.js";
import {
  ReviewEvidenceLedger,
  findInvalidReviewAssessment,
  reviewAssessmentInternals,
  reviewAssessmentSchema,
  reviewEvidenceResultSchema,
} from "../src/runtime/review-assessment.js";

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

function coverage(
  path: string,
  evidenceRefs: readonly string[],
  disposition: "reviewed" | "not_applicable" | "incomplete" = "reviewed",
): ReviewAssessment["coverage"][number] {
  return {
    paths: [path],
    disposition,
    rationale: "The affected behavior was checked against the fixed repository snapshot.",
    evidenceRefs,
  };
}

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
  return { tool_name, tool_input, tool_use_id: `${tool_name}-use`, tool_response: response };
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

test("accepts the bounded assessment contract and rejects extra fields", () => {
  const assessment: ReviewAssessment = {
    coverage: [coverage("src/change.ts", ["ev-1"])],
    candidates: [
      {
        paths: ["src/change.ts"],
        trigger: "A caller ignores the returned error.",
        impact: "The operation appears to succeed while data is missing.",
        evidenceRefs: ["ev-1"],
        countercheck: "Checked for a caller guard and found none.",
        counterevidenceRefs: [],
        verdict: "supported",
        findingIndex: 0,
      },
    ],
  };
  assert.equal(reviewAssessmentSchema.safeParse(assessment).success, true);
  assert.equal(
    reviewAssessmentSchema.safeParse({ ...assessment, unsupported: true }).success,
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
        done: true,
      }),
    ),
    call(
      "mcp__review_output__read_repository_file",
      { revision: "base", path: "unchanged.ts", cursor: "file-cursor" },
      jsonResponse({ revision: "base", path: "unchanged.ts", kind: "text", done: true }),
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

test("records native repository reads, searches, context, briefing, discussion, and MCP output", () => {
  const ledger = new ReviewEvidenceLedger("/repo");
  const observed = ledger.observeBatch([
    call(
      "Read",
      { file_path: "/repo/src/change.ts" },
      {
        type: "text",
        file: {
          filePath: "/repo/src/change.ts",
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
});

test("marks bounded or unverified native repository reads and searches partial", () => {
  const ledger = new ReviewEvidenceLedger("/repo");
  const observed = ledger.observeBatch([
    call(
      "Read",
      { file_path: "/repo/src/change.ts", offset: 10, limit: 20 },
      {
        type: "text",
        file: {
          filePath: "/repo/src/change.ts",
          content: "limited source",
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
    ["partial", "partial"],
  );
  assert.deepEqual(observed[0]?.bounds, { offset: 10, limit: 20, truncated: true });
  assert.deepEqual(observed[1]?.bounds, { offset: 3, headLimit: 5, truncated: true });
  const assessment: ReviewAssessment = {
    coverage: [
      coverage(
        "src/change.ts",
        observed.map((reference) => reference.id),
      ),
    ],
    candidates: [],
  };
  assert.ok(
    findInvalidReviewAssessment(assessment, [], [changedFile], ledger.issued).some((issue) =>
      /completed repository evidence/u.test(issue),
    ),
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

test("marks tool failures and cursor errors failed and bounds the returned evidence list", () => {
  const ledger = new ReviewEvidenceLedger("/repo");
  const failed = ledger.observeBatch([
    call(
      "Grep",
      { path: "src/change.ts" },
      { isError: true, content: [{ type: "text", text: "denied" }] },
    ),
    call("Read", { file_path: "/repo/src/change.ts" }, undefined),
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

test("validates coverage, candidate evidence, and one-to-one finding links", () => {
  const evidence = new Map<string, ReviewEvidenceReference>([["ev-1", repositoryEvidence()]]);
  const valid: ReviewAssessment = {
    coverage: [coverage("src/change.ts", ["ev-1"])],
    candidates: [
      {
        paths: ["src/change.ts"],
        trigger: "The new branch drops the result.",
        impact: "The request reports success without saving the value.",
        evidenceRefs: ["ev-1"],
        countercheck: "Checked the caller and adjacent guard.",
        counterevidenceRefs: [],
        verdict: "supported",
        findingIndex: 0,
      },
    ],
  };
  assert.deepEqual(findInvalidReviewAssessment(valid, [finding], [changedFile], evidence), []);
  assert.ok(
    findInvalidReviewAssessment(
      { ...valid, coverage: [coverage("src/change.ts", ["ev-99"])] },
      [finding],
      [changedFile],
      evidence,
    ).some((issue) => /unknown evidence/u.test(issue)),
  );
  assert.ok(
    findInvalidReviewAssessment(
      { ...valid, coverage: [coverage("src/unchanged.ts", ["ev-1"])] },
      [finding],
      [changedFile],
      evidence,
    ).some((issue) => /unchanged path/u.test(issue)),
  );
  assert.ok(
    findInvalidReviewAssessment(
      {
        ...valid,
        coverage: [coverage("src/change.ts", ["ev-1"]), coverage("src/change.ts", ["ev-1"])],
      },
      [finding],
      [changedFile],
      evidence,
    ).some((issue) => /classified more than once/u.test(issue)),
  );
  assert.ok(
    findInvalidReviewAssessment(
      { ...valid, coverage: [] },
      [finding],
      [changedFile],
      evidence,
    ).some((issue) => /no coverage classification/u.test(issue)),
  );
});

test("requires completed repository evidence for reviewed coverage and supported findings", () => {
  const briefing = new Map<string, ReviewEvidenceReference>([
    ["ev-1", { id: "ev-1", kind: "briefing", status: "complete" }],
  ]);
  const assessment: ReviewAssessment = {
    coverage: [coverage("src/change.ts", ["ev-1"])],
    candidates: [
      {
        paths: ["src/change.ts"],
        trigger: "The caller drops the value.",
        impact: "The write is lost.",
        evidenceRefs: ["ev-1"],
        countercheck: "Looked for a guard.",
        counterevidenceRefs: [],
        verdict: "supported",
        findingIndex: 0,
      },
    ],
  };
  assert.ok(
    findInvalidReviewAssessment(assessment, [finding], [changedFile], briefing).some((issue) =>
      /completed repository evidence/u.test(issue),
    ),
  );
  const partial = new Map<string, ReviewEvidenceReference>([
    ["ev-1", repositoryEvidence({ status: "partial" })],
  ]);
  const firstCandidate = assessment.candidates[0];
  assert.ok(firstCandidate);
  assert.ok(
    findInvalidReviewAssessment(assessment, [finding], [changedFile], partial).some((issue) =>
      /lacks evidence for an affected path/u.test(issue),
    ),
  );
  assert.ok(
    findInvalidReviewAssessment(
      {
        ...assessment,
        candidates: [{ ...firstCandidate, evidenceRefs: [] }],
      },
      [finding],
      [changedFile],
      partial,
    ).some((issue) => /no host-issued evidence/u.test(issue)),
  );
});

test("accepts justified exclusions and unresolved hypotheses without findings", () => {
  const evidence = new Map<string, ReviewEvidenceReference>([["ev-1", repositoryEvidence()]]);
  const notApplicable: ReviewAssessment = {
    coverage: [coverage("src/change.ts", ["ev-1"], "not_applicable")],
    candidates: [],
  };
  assert.deepEqual(findInvalidReviewAssessment(notApplicable, [], [changedFile], evidence), []);
  assert.ok(
    findInvalidReviewAssessment(
      { ...notApplicable, coverage: [coverage("src/change.ts", [], "not_applicable")] },
      [],
      [changedFile],
      evidence,
    ).some((issue) => /not_applicable path.*completed repository evidence/u.test(issue)),
  );
  const unresolved: ReviewAssessment = {
    coverage: [coverage("src/change.ts", ["ev-1"])],
    candidates: [
      {
        paths: ["src/change.ts"],
        trigger: "The caller may mishandle an absent value.",
        impact: "The request may fail.",
        evidenceRefs: ["ev-1"],
        countercheck: "Inspected the available caller but could not resolve the condition.",
        counterevidenceRefs: [],
        verdict: "unresolved",
      },
    ],
  };
  assert.deepEqual(findInvalidReviewAssessment(unresolved, [], [changedFile], evidence), []);
  const incomplete = { coverage: [coverage("src/change.ts", [], "incomplete")], candidates: [] };
  assert.deepEqual(findInvalidReviewAssessment(incomplete, [], [changedFile], evidence), []);
});

test("requires completed repository counterevidence for disproved candidates", () => {
  const evidence = new Map<string, ReviewEvidenceReference>([
    ["ev-1", repositoryEvidence()],
    ["ev-2", { id: "ev-2", kind: "conversation", status: "complete" }],
  ]);
  const candidate = {
    paths: ["src/change.ts"],
    trigger: "The caller may drop an error.",
    impact: "The update may be lost.",
    evidenceRefs: ["ev-1"],
    countercheck: "Found a caller guard.",
    counterevidenceRefs: ["ev-2"],
    verdict: "disproved" as const,
  };
  const assessment: ReviewAssessment = {
    coverage: [coverage("src/change.ts", ["ev-1"])],
    candidates: [candidate],
  };
  assert.ok(
    findInvalidReviewAssessment(assessment, [], [changedFile], evidence).some((issue) =>
      /completed repository counterevidence/u.test(issue),
    ),
  );
  const completeCounterevidence = new Map(evidence).set("ev-3", {
    id: "ev-3",
    kind: "repository_read",
    status: "complete",
    path: "src/guard.ts",
  });
  assert.deepEqual(
    findInvalidReviewAssessment(
      { ...assessment, candidates: [{ ...candidate, counterevidenceRefs: ["ev-3"] }] },
      [],
      [changedFile],
      completeCounterevidence,
    ),
    [],
  );
});

test("requires a supported finding link for every finding", () => {
  const evidence = new Map<string, ReviewEvidenceReference>([["ev-1", repositoryEvidence()]]);
  const unsupported = {
    paths: ["src/change.ts"],
    trigger: "The change drops the result.",
    impact: "The update is lost.",
    evidenceRefs: ["ev-1"],
    countercheck: "Checked the caller.",
    counterevidenceRefs: [],
    verdict: "supported" as const,
  };
  const validCoverage = [coverage("src/change.ts", ["ev-1"])];
  assert.ok(
    findInvalidReviewAssessment(
      { coverage: validCoverage, candidates: [unsupported] },
      [finding],
      [changedFile],
      evidence,
    ).some((issue) => /does not identify its finding/u.test(issue)),
  );
  assert.ok(
    findInvalidReviewAssessment(
      {
        coverage: validCoverage,
        candidates: [
          { ...unsupported, findingIndex: 0 },
          { ...unsupported, findingIndex: 0 },
        ],
      },
      [finding],
      [changedFile],
      evidence,
    ).some((issue) => /needs one supported candidate/u.test(issue)),
  );
  assert.ok(
    findInvalidReviewAssessment(
      {
        coverage: validCoverage,
        candidates: [{ ...unsupported, verdict: "unresolved", findingIndex: 0 }],
      },
      [finding],
      [changedFile],
      evidence,
    ).some((issue) => /non-supported candidate/u.test(issue)),
  );
  assert.ok(
    findInvalidReviewAssessment(
      {
        coverage: validCoverage,
        candidates: [{ ...unsupported, findingIndex: 0, paths: ["other.ts"] }],
      },
      [finding],
      [changedFile],
      evidence,
    ).some((issue) => /not linked to its changed path/u.test(issue)),
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
