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
            severity: "MEDIUM",
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
            severity: "MEDIUM",
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
            severity: "MEDIUM",
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
              path: "src/other.ts",
              line: 2,
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

test("keeps body findings ahead of oversized goal status", () => {
  const review = aggregateReview(context, config, files, [
    {
      prompt: "goal".repeat(30_000),
      status: "completed",
      submission: {
        summary: "body finding",
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
  ]);
  const body = buildReviewBody(review, [
    {
      prompt: "goal".repeat(30_000),
      status: "completed",
      submission: {
        summary: "body finding",
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
  ]);
  assert.match(body, /Unverified finding/);
  assert.match(body, /Goal status truncated/);
});

test("partial goals force a comment and remain actionable", () => {
  const review = aggregateReview(context, config, files, [
    { prompt: "correctness", status: "completed", submission: { summary: "ok", findings: [] } },
    { prompt: "security", status: "failed", error: "timeout" },
  ]);
  assert.equal(review.partial, true);
  assert.equal(review.event, "COMMENT");
  assert.doesNotMatch(
    buildReviewBody(review, [
      { prompt: "correctness", status: "completed", submission: { summary: "ok", findings: [] } },
      { prompt: "security", status: "failed", error: "timeout" },
    ]),
    /ai-pr-reviewer:v1:/,
  );
  assert.equal(review.allGoalsFailed, false);
});
