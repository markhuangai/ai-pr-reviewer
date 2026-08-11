import { strict as assert } from "node:assert";
import test from "node:test";

import { aggregateReview, buildReviewRequest, reviewMarker } from "../src/lib/aggregate.js";
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
  assert.match(marker, /ai-pr-reviewer:v1/);
});

test("partial goals force a comment and remain actionable", () => {
  const review = aggregateReview(context, config, files, [
    { prompt: "correctness", status: "completed", submission: { summary: "ok", findings: [] } },
    { prompt: "security", status: "failed", error: "timeout" },
  ]);
  assert.equal(review.partial, true);
  assert.equal(review.event, "COMMENT");
  assert.equal(review.allGoalsFailed, false);
});
