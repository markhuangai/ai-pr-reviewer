import { strict as assert } from "node:assert";
import test from "node:test";

import {
  aggregateInternals,
  aggregateReview,
  buildReviewBody,
  buildReviewRequest,
  buildRunSummary,
} from "../src/lib/aggregate.js";
import type { GoalResult } from "../src/lib/types.js";
import { config, context, files } from "./aggregate-test-fixtures.js";

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

test("writes every inline and body finding to a complete run summary", () => {
  const goals: readonly GoalResult[] = [
    {
      prompt: "PRIVATE REVIEW GOAL",
      status: "completed",
      submission: {
        summary: "PRIVATE MODEL SUMMARY",
        findings: [
          {
            title: "Verified issue",
            severity: "HIGH",
            body: "This issue is on an added line.",
            path: "src/change.ts",
            line: 1,
          },
          {
            title: "Repository-wide issue",
            severity: "LOW",
            body: "This issue has no safe inline location.",
          },
        ],
      },
    },
  ];
  const review = aggregateReview(context, config, files, goals);
  const summary = buildRunSummary(context, review, goals);

  assert.match(summary, /^## 🔎 AI review/mu);
  assert.match(summary, /- Result: complete/u);
  assert.match(summary, /Verified issue \(src\/change\.ts:1\)/u);
  assert.match(summary, /This issue is on an added line\./u);
  assert.match(summary, /Repository-wide issue/u);
  assert.match(summary, /This issue has no safe inline location\./u);
  assert.doesNotMatch(summary, /PRIVATE REVIEW GOAL|PRIVATE MODEL SUMMARY/u);
});

test("labels partial and all-failed run summaries", () => {
  const partialGoals: readonly GoalResult[] = [
    {
      prompt: "completed",
      status: "completed",
      submission: { summary: "clean", findings: [] },
    },
    { prompt: "failed", status: "failed", error: "PRIVATE FAILURE" },
  ];
  const partialReview = aggregateReview(context, config, files, partialGoals);
  const partialSummary = buildRunSummary(context, partialReview, partialGoals);
  assert.match(partialSummary, /^## ⚠️ AI review incomplete/mu);
  assert.match(partialSummary, /- Checks completed: 1 of 2/u);
  assert.match(partialSummary, /- Result: incomplete/u);
  assert.doesNotMatch(partialSummary, /PRIVATE FAILURE/u);

  const failedGoals: readonly GoalResult[] = [
    { prompt: "failed-one", status: "failed", error: "PRIVATE FAILURE ONE" },
    { prompt: "failed-two", status: "failed", error: "PRIVATE FAILURE TWO" },
  ];
  const failedReview = aggregateReview(context, config, files, failedGoals);
  const failedSummary = buildRunSummary(context, failedReview, failedGoals);
  assert.match(failedSummary, /^## ⚠️ AI review failed/mu);
  assert.match(failedSummary, /- Checks completed: 0 of 2/u);
  assert.match(failedSummary, /- Result: failed/u);
  assert.match(failedSummary, /see the step logs for redacted diagnostics/u);
  assert.doesNotMatch(failedSummary, /PRIVATE FAILURE/u);
});

test("includes failed-goal snapshots and marks crashed accounting incomplete", () => {
  const goals: readonly GoalResult[] = [
    {
      prompt: "provider failure",
      status: "failed",
      error: "provider failed",
      tokenUsage: {
        complete: true,
        models: [
          {
            model: "review-model",
            inputTokens: 10,
            outputTokens: 2,
            cacheReadInputTokens: 3,
            cacheCreationInputTokens: 4,
          },
        ],
      },
    },
    {
      prompt: "reader crash",
      status: "failed",
      error: "reader crashed",
      tokenUsage: {
        complete: false,
        models: [
          {
            model: "review-model",
            inputTokens: 20,
            outputTokens: 4,
            cacheReadInputTokens: 6,
            cacheCreationInputTokens: 8,
          },
        ],
      },
    },
  ];
  const review = aggregateReview(context, config, files, goals);
  const summary = buildRunSummary(context, review, goals);

  assert.deepEqual(review.tokenUsage.totals, {
    inputTokens: 30,
    outputTokens: 6,
    cacheReadInputTokens: 9,
    cacheCreationInputTokens: 12,
  });
  assert.equal(review.tokenUsage.complete, false);
  assert.match(summary, /<summary>📊 Token usage · 57 tokens<\/summary>/u);
  assert.match(summary, /> ⚠️ \*\*Incomplete SDK accounting\*\*/u);
});

test("keeps the collapsed token block within review and run-summary limits", () => {
  const goals: readonly GoalResult[] = [
    {
      prompt: "many models",
      status: "completed",
      submission: { summary: "clean", findings: [] },
      tokenUsage: {
        complete: true,
        models: Array.from({ length: 1_000 }, (_, index) => ({
          model: `model-${String(index).padStart(4, "0")}-${"界".repeat(1_000)}`,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadInputTokens: 1,
          cacheCreationInputTokens: 1,
        })),
      },
    },
  ];
  const review = aggregateReview(context, config, files, goals);
  const body = buildReviewBody(review, goals);
  const summary = buildRunSummary(context, review, goals);

  assert.ok(body.length <= 60_000);
  assert.ok(Buffer.byteLength(summary, "utf8") <= 1_000_000);
  assert.match(body, /additional model rows omitted/u);
  assert.match(body, /<details>\n<summary>📊 Token usage[\s\S]*<\/summary>[\s\S]*<\/details>/u);
  assert.doesNotMatch(body, /<details open/iu);
});

test("caps run summaries by UTF-8 bytes without cutting a finding", () => {
  const goals: readonly GoalResult[] = Array.from({ length: 100 }, (_, index) => {
    const identifier = String(index).padStart(3, "0");
    return {
      prompt: `goal-${identifier}`,
      status: "completed",
      submission: {
        summary: "large",
        findings: [
          {
            title: `Finding ${identifier}`,
            severity: "LOW",
            body: `BEGIN-${identifier}:${"界".repeat(8_000)}:END-${identifier}`,
          },
        ],
      },
    };
  });
  const review = aggregateReview(context, config, files, goals);
  const summary = buildRunSummary(context, review, goals);
  let included = 0;

  assert.ok(Buffer.byteLength(summary, "utf8") <= 1_000_000);
  assert.match(summary, /additional findings? (?:was|were) omitted/u);
  for (let index = 0; index < goals.length; index += 1) {
    const identifier = String(index).padStart(3, "0");
    const hasHeading = summary.includes(`🟡 Low: Finding ${identifier}`);
    assert.equal(summary.includes(`BEGIN-${identifier}:`), hasHeading);
    assert.equal(summary.includes(`:END-${identifier}`), hasHeading);
    if (hasHeading) included += 1;
  }
  assert.ok(included > 0 && included < goals.length);
});

test("renders the maximum supported finding count with linear byte accounting", () => {
  const goals: readonly GoalResult[] = Array.from({ length: 50 }, (_, goalIndex) => ({
    prompt: `goal-${goalIndex}`,
    status: "completed",
    submission: {
      summary: "many findings",
      findings: Array.from({ length: 100 }, (_, findingIndex) => {
        const identifier = String(goalIndex * 100 + findingIndex).padStart(4, "0");
        return {
          title: `Finding ${identifier}`,
          severity: "LOW" as const,
          body: `Issue ${identifier}.`,
        };
      }),
    },
  }));
  const review = aggregateReview(context, config, files, goals);
  const summary = buildRunSummary(context, review, goals);

  assert.equal(review.findings.length, 5_000);
  assert.match(summary, /Finding 4999/u);
  assert.doesNotMatch(summary, /additional findings? (?:was|were) omitted/u);
  assert.ok(Buffer.byteLength(summary, "utf8") <= 1_000_000);
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
  assert.doesNotMatch(body, /✨ Good job|ai-pr-reviewer:v3|PRIVATE COMPLETED GOAL/u);
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

test("bounds oversized inline prose while preserving a generated AI prompt", () => {
  const finding = {
    title: "Large inline finding",
    severity: "HIGH" as const,
    body: "evidence ".repeat(8_000),
    path: "src/change.ts",
    line: 1,
    goals: [0],
    locationVerified: true,
  };
  const withoutPrompt = aggregateInternals.inlineCommentBody(finding);
  assert.ok(withoutPrompt.length <= 60_000);
  assert.match(withoutPrompt, /Inline finding truncated at 60 KB/u);

  const withPrompt = aggregateInternals.inlineCommentBody({
    ...finding,
    agentPrompt: "Target: `@src/change.ts:1`\n",
  });
  assert.ok(withPrompt.length <= 60_000);
  assert.match(withPrompt, /duplicate evidence omitted to preserve the AI prompt/u);
  assert.match(withPrompt, /Target: `@src\/change\.ts:1`\n```\n\n<\/details>/u);
});

test("rejects an AI prompt that cannot fit in an inline comment", () => {
  assert.throws(
    () =>
      aggregateInternals.inlineCommentBody({
        title: "Oversized prompt",
        severity: "HIGH",
        body: "body",
        agentPrompt: "x".repeat(60_000),
        path: "src/change.ts",
        line: 1,
        goals: [0],
        locationVerified: true,
      }),
    /AI prompt exceeds GitHub's review comment capacity/u,
  );
});
