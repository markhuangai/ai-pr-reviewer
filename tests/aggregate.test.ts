import { strict as assert } from "node:assert";
import test from "node:test";

import {
  aggregateReview,
  buildReviewBody,
  buildReviewRequest,
  reviewMarker,
} from "../src/lib/aggregate.js";
import type {
  ChangedFile,
  GoalResult,
  PullRequestContext,
  ReviewConfig,
} from "../src/lib/types.js";

const context: PullRequestContext = {
  repository: "owner/repository",
  owner: "owner",
  name: "repository",
  number: 42,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  baseSha: "fedcba9876543210fedcba9876543210fedcba98",
  title: "Change",
  htmlUrl: "https://github.com/owner/repository/pull/42",
};

const config: ReviewConfig = {
  githubToken: "github-secret",
  aiBaseUrl: "https://ai.example.test",
  aiSecret: "ai-secret",
  aiAuthMode: "api-key",
  model: "review-model",
  reviewPrompts: ["correctness", "security"],
  parallelCount: 2,
  maxTurns: 50,
  autoApprove: true,
  mcpServers: {},
};

const files: readonly ChangedFile[] = [
  {
    path: "src/change.ts",
    status: "modified",
    additions: 2,
    deletions: 0,
    changes: 2,
    patch: "@@ -1,0 +1,2 @@\n+one\n+two",
    addedLines: new Set([1, 2]),
  },
];

test("renders a clean review without exposing goal internals", () => {
  const goals: readonly GoalResult[] = [
    {
      prompt: "PRIVATE REVIEW GOAL",
      status: "completed",
      submission: { summary: "PRIVATE MODEL SUMMARY", findings: [] },
    },
  ];
  const review = aggregateReview(context, config, files, goals);
  const body = buildReviewBody(review, goals);

  assert.equal(body, `${review.marker}\n## ✨ Good job!\n\nNo actionable issues found.`);
  assert.equal(review.event, "APPROVE");
  assert.doesNotMatch(body, /PRIVATE REVIEW GOAL|PRIVATE MODEL SUMMARY|### Goals|completed/u);
});

test("formats four public severities without exposing goal provenance", () => {
  const goals: readonly GoalResult[] = [
    {
      prompt: "PRIVATE SECURITY GOAL",
      status: "completed",
      submission: {
        summary: "PRIVATE FINDING SUMMARY",
        findings: [
          {
            title: "Authorization can be bypassed",
            severity: "CRITICAL",
            body: "The caller can cross the repository boundary.",
            path: "src/change.ts",
            line: 1,
          },
          {
            title: "Failure leaves stale state",
            severity: "HIGH",
            body: "The failure path preserves the previous success state.",
            path: "src/change.ts",
            line: 2,
          },
          {
            title: "Cancellation is ignored",
            severity: "MODERATE",
            body: "The retry continues after cancellation.",
          },
          {
            title: "Error loses its reason",
            severity: "LOW",
            body: "The safe diagnostic reason is discarded.",
          },
        ],
      },
    },
  ];
  const review = aggregateReview(context, config, files, goals);
  const request = buildReviewRequest(context, review, goals);

  assert.deepEqual(
    review.findings.map((finding) => finding.severity),
    ["CRITICAL", "HIGH", "MODERATE", "LOW"],
  );
  assert.match(request.body, /## 🔎 AI review/u);
  assert.match(
    request.body,
    /Found \*\*4 actionable issues\*\* — 1 critical, 1 high, 1 moderate, and 1 low\./u,
  );
  assert.match(request.body, /See the inline comments and findings below for details\./u);
  assert.match(request.body, /Moderate · Cancellation is ignored/u);
  assert.match(request.body, /Low · Error loses its reason/u);
  assert.equal(
    request.comments[0]?.body,
    "**Critical · Authorization can be bypassed**\n\nThe caller can cross the repository boundary.",
  );
  assert.equal(
    request.comments[1]?.body,
    "**High · Failure leaves stale state**\n\nThe failure path preserves the previous success state.",
  );
  assert.doesNotMatch(
    `${request.body}\n${request.comments.map((comment) => comment.body).join("\n")}`,
    /PRIVATE SECURITY GOAL|PRIVATE FINDING SUMMARY|Found by goal|### Goals|\[(?:CRITICAL|HIGH|MODERATE|LOW)\]/u,
  );
});

test("allows only low findings through the automatic approval threshold", () => {
  for (const [severity, event] of [
    ["LOW", "APPROVE"],
    ["MODERATE", "COMMENT"],
    ["HIGH", "COMMENT"],
    ["CRITICAL", "COMMENT"],
  ] as const) {
    const review = aggregateReview(context, config, files, [
      {
        prompt: "threshold",
        status: "completed",
        submission: {
          summary: "threshold",
          findings: [{ title: `${severity} issue`, severity, body: "Actionable defect." }],
        },
      },
    ]);
    assert.equal(review.event, event, severity);
  }
});

test("deduplicates findings, preserves the strongest severity, and verifies diff locations", () => {
  const goals: readonly GoalResult[] = [
    {
      prompt: "correctness",
      status: "completed",
      submission: {
        summary: "found issue",
        findings: [
          {
            title: "Unchecked result",
            severity: "HIGH",
            body: "The result is ignored.",
            path: "src/change.ts",
            line: 1,
          },
          {
            title: "Unrelated",
            severity: "LOW",
            body: "Not on the diff.",
            path: "src/old.ts",
            line: 9,
          },
        ],
      },
    },
    {
      prompt: "security",
      status: "completed",
      submission: {
        summary: "same issue",
        findings: [
          {
            title: "Unchecked result",
            severity: "MODERATE",
            body: "The result is ignored in this path.",
            path: "src/change.ts",
            line: 1,
          },
        ],
      },
    },
  ];
  const review = aggregateReview(context, config, files, goals);
  assert.equal(review.findings.length, 2);
  assert.equal(review.findings[0]?.severity, "HIGH");
  assert.equal(review.findings[0]?.goals.length, 2);
  assert.equal(review.inlineFindings.length, 1);
  assert.equal(review.bodyFindings.length, 1);
  assert.equal(review.event, "COMMENT");
  const request = buildReviewRequest(context, review, goals);
  assert.equal(request.comments.length, 1);
  assert.match(request.body, /Location could not be verified/);
});

test("does not include secrets in duplicate markers", () => {
  const marker = reviewMarker(context, config);
  assert.doesNotMatch(marker, /github-secret|ai-secret/);
  assert.match(marker, /ai-pr-reviewer:v2/);
  assert.notEqual(
    marker,
    reviewMarker(context, { ...config, aiBaseUrl: "https://other.example.test" }),
  );
  assert.notEqual(marker, reviewMarker(context, { ...config, aiAuthMode: "auth-token" }));
  assert.equal(marker, reviewMarker(context, { ...config, githubToken: "another-github-token" }));
  assert.notEqual(
    marker,
    reviewMarker({ ...context, baseSha: "1111111111111111111111111111111111111111" }, config),
  );
  assert.notEqual(
    marker,
    reviewMarker(context, {
      ...config,
      mcpServers: {
        security: {
          type: "http",
          url: "https://mcp.example.test",
          tools: [{ name: "dependency_advice", permission_policy: "always_deny" }],
        },
      },
    }),
  );
  assert.notEqual(
    marker,
    reviewMarker(context, {
      ...config,
      mcpServers: {
        security: {
          type: "http",
          url: "https://mcp.example.test",
          headers: { Authorization: "tenant-a" },
        },
      },
    }),
  );
});

test("maps verified multi-line findings to GitHub review ranges", () => {
  const review = aggregateReview(context, config, files, [
    {
      prompt: "range",
      status: "completed",
      submission: {
        summary: "range",
        findings: [
          {
            title: "Range",
            severity: "MODERATE",
            body: "The whole changed block is affected.",
            path: "src/change.ts",
            line: 1,
            endLine: 2,
          },
        ],
      },
    },
  ]);
  const request = buildReviewRequest(context, review, [
    {
      prompt: "range",
      status: "completed",
      submission: {
        summary: "range",
        findings: [
          {
            title: "Range",
            severity: "MODERATE",
            body: "The whole changed block is affected.",
            path: "src/change.ts",
            line: 1,
            endLine: 2,
          },
        ],
      },
    },
  ]);
  assert.deepEqual(request.comments[0], {
    path: "src/change.ts",
    line: 2,
    side: "RIGHT",
    start_line: 1,
    start_side: "RIGHT",
    body: request.comments[0]?.body,
  });
});

test("rejects oversized finding ranges before location verification", () => {
  const review = aggregateReview(context, config, files, [
    {
      prompt: "range",
      status: "completed",
      submission: {
        summary: "range",
        findings: [
          {
            title: "Oversized range",
            severity: "MODERATE",
            body: "The reported range is too large to verify safely.",
            path: "src/change.ts",
            line: 1,
            endLine: 1_000_000,
          },
        ],
      },
    },
  ]);
  assert.equal(review.findings[0]?.locationVerified, false);
  assert.equal(review.inlineFindings.length, 0);
  assert.match(review.bodyFindings[0]?.body ?? "", /Location could not be verified/);
});

test("keeps verified findings at separate locations distinct", () => {
  const review = aggregateReview(
    context,
    config,
    [
      ...files,
      {
        path: "src/other.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@ -1,0 +1 @@\n+two",
        addedLines: new Set([1]),
      },
    ],
    [
      {
        prompt: "locations",
        status: "completed",
        submission: {
          summary: "two locations",
          findings: [
            {
              title: "Unchecked result",
              severity: "HIGH",
              body: "The result is ignored.",
              path: "src/change.ts",
              line: 1,
            },
            {
              title: "Unchecked result",
              severity: "HIGH",
              body: "The result is ignored.",
              path: "src/other.ts",
              line: 1,
            },
          ],
        },
      },
    ],
  );
  assert.equal(review.findings.length, 2);
});

test("keeps distinct non-Latin findings separate", () => {
  const review = aggregateReview(context, config, files, [
    {
      prompt: "中文",
      status: "completed",
      submission: {
        summary: "中文",
        findings: [
          { title: "安全问题", severity: "HIGH", body: "这里存在安全缺陷。" },
          { title: "性能问题", severity: "HIGH", body: "这里存在性能缺陷。" },
        ],
      },
    },
  ]);
  assert.equal(review.findings.length, 2);
});

test("preserves distinct claimed locations for unverified findings", () => {
  const review = aggregateReview(context, config, files, [
    {
      prompt: "locations",
      status: "completed",
      submission: {
        summary: "locations",
        findings: [
          {
            title: "Unverified issue",
            severity: "MODERATE",
            body: "The same issue was reported at two different paths.",
            path: "src/missing-a.ts",
            line: 10,
          },
          {
            title: "Unverified issue",
            severity: "MODERATE",
            body: "The same issue was reported at two different paths.",
            path: "src/missing-b.ts",
            line: 20,
          },
        ],
      },
    },
  ]);
  assert.equal(review.findings.length, 2);
  assert.match(review.bodyFindings[0]?.body ?? "", /src\/missing-/);
});

test("bounds an oversized merged inline comment", () => {
  const goals: readonly GoalResult[] = Array.from({ length: 10 }, (_, index) => ({
    prompt: `goal-${index}`,
    status: "completed",
    submission: {
      summary: "large",
      findings: [
        {
          title: "Large finding",
          severity: "HIGH",
          body: String.fromCharCode(97 + index).repeat(8_000),
          path: "src/change.ts",
          line: 1,
        },
      ],
    },
  }));
  const review = aggregateReview(context, config, files, goals);
  const request = buildReviewRequest(context, review, goals);
  assert.ok(request.comments.length <= 25);
  assert.ok((request.comments[0]?.body.length ?? 0) <= 60_000);
});

test("bounds merged evidence so later body findings remain visible", () => {
  const duplicateGoals: readonly GoalResult[] = Array.from({ length: 50 }, (_, index) => ({
    prompt: `duplicate-${index}`,
    status: "completed",
    submission: {
      summary: "duplicate",
      findings: [
        {
          title: "Repeated issue",
          severity: "LOW",
          body: `shared evidence context security ${index}`.repeat(1_000),
        },
      ],
    },
  }));
  const review = aggregateReview(
    context,
    config,
    [
      ...files,
      {
        path: "src/other.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        patch: "@@ -1,0 +1 @@\n+other",
        addedLines: new Set([1]),
      },
    ],
    [
      ...duplicateGoals,
      {
        prompt: "later",
        status: "completed",
        submission: {
          summary: "later",
          findings: [
            {
              title: "Later body finding",
              severity: "LOW",
              body: "This distinct finding must remain in the review body.",
            },
          ],
        },
      },
    ],
  );
  const repeated = review.findings.find((finding) => finding.title === "Repeated issue");
  assert.ok(repeated);
  assert.ok(repeated.body.length <= 16_000);
  assert.match(buildReviewBody(review, duplicateGoals), /Later body finding/);
});

test("keeps body findings while withholding oversized goal internals", () => {
  const goals: readonly GoalResult[] = [
    {
      prompt: "PRIVATE OVERSIZED GOAL ".repeat(30_000),
      status: "completed",
      submission: {
        summary: "PRIVATE OVERSIZED SUMMARY",
        findings: [
          {
            title: "Unverified finding",
            severity: "LOW",
            body: "This finding must remain visible in the review body.",
            path: "src/other.ts",
            line: 1,
          },
        ],
      },
    },
  ];
  const review = aggregateReview(context, config, files, goals);
  const body = buildReviewBody(review, goals);

  assert.match(body, /Unverified finding/);
  assert.doesNotMatch(body, /PRIVATE OVERSIZED GOAL|PRIVATE OVERSIZED SUMMARY|### Goals/u);
});

test("indexes every body finding before truncating details", () => {
  const goals: readonly GoalResult[] = Array.from({ length: 9 }, (_, index) => ({
    prompt: `goal-${index}`,
    status: "completed",
    submission: {
      summary: "large body finding",
      findings: [
        {
          title: `Body finding ${index + 1}`,
          severity: "LOW",
          body: String(index).repeat(8_000),
        },
      ],
    },
  }));
  const review = aggregateReview(context, config, files, goals);
  const body = buildReviewBody(review, goals);
  assert.match(body, /Body finding 1/);
  assert.match(body, /Body finding 9/);
  assert.ok(body.length <= 60_000);
});

test("partial goals force a comment and remain actionable", () => {
  const goals: readonly GoalResult[] = [
    {
      prompt: "PRIVATE COMPLETED GOAL",
      status: "completed",
      submission: {
        summary: "PRIVATE PARTIAL SUMMARY",
        findings: [
          {
            title: "Partial finding",
            severity: "LOW",
            body: "This completed check found an actionable defect.",
          },
        ],
      },
    },
    { prompt: "PRIVATE FAILED GOAL", status: "failed", error: "PRIVATE FAILURE ERROR" },
  ];
  const review = aggregateReview(context, config, files, goals);
  const body = buildReviewBody(review, goals);

  assert.equal(review.partial, true);
  assert.equal(review.event, "COMMENT");
  assert.match(body, /^## ⚠️ Review incomplete\n\n1 of 2 checks completed\./u);
  assert.match(body, /Partial finding/u);
  assert.doesNotMatch(body, /✨ Good job|ai-pr-reviewer:v2|PRIVATE COMPLETED GOAL/u);
  assert.doesNotMatch(
    body,
    /PRIVATE FAILED GOAL|PRIVATE PARTIAL SUMMARY|PRIVATE FAILURE ERROR|Found by goal|### Goals/u,
  );
  assert.equal(review.allGoalsFailed, false);
});

test("binary changed-file metadata does not block an otherwise qualified approval", () => {
  const review = aggregateReview(
    context,
    config,
    [
      {
        path: "assets/image.png",
        status: "modified",
        additions: 0,
        deletions: 0,
        changes: 0,
        addedLines: new Set(),
      },
    ],
    [
      {
        prompt: "correctness",
        status: "completed",
        submission: { summary: "No text findings.", findings: [] },
      },
    ],
  );
  assert.equal(review.partial, false);
  assert.equal(review.event, "APPROVE");
});
