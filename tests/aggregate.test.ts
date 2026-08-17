import { strict as assert } from "node:assert";
import test from "node:test";

import {
  aggregateInternals,
  aggregateReview,
  buildReviewBody,
  buildReviewRequest,
  buildRunSummary,
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
  baseRef: "main",
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
  interactWithPullRequest: true,
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
  assert.match(request.body, /🟠 Moderate: Cancellation is ignored/u);
  assert.match(request.body, /🟡 Low: Error loses its reason/u);
  assert.equal(
    request.comments[0]?.body,
    "🚨 Critical **Authorization can be bypassed**\n\nThe caller can cross the repository boundary.",
  );
  assert.equal(
    request.comments[1]?.body,
    "🔴 High **Failure leaves stale state**\n\nThe failure path preserves the previous success state.",
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

test("keeps a generated AI prompt paired with its verified range while merging duplicates", () => {
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
            agentPrompt: "Target: `@src/change.ts:1`\nFinding: Unchecked result",
            path: "src/change.ts",
            line: 1,
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
            agentPrompt: "Target: `@src/change.ts:1-2`\nFinding: Unchecked result",
            path: "src/change.ts",
            line: 1,
            endLine: 2,
          },
        ],
      },
    },
  ];

  const review = aggregateReview(context, config, files, goals);
  assert.equal(review.findings.length, 1);
  assert.equal(
    review.findings[0]?.agentPrompt,
    "Target: `@src/change.ts:1`\nFinding: Unchecked result",
  );
  assert.equal(review.findings[0]?.line, 1);
  assert.equal(review.findings[0]?.endLine, undefined);
  const request = buildReviewRequest(context, review, goals);
  assert.equal(request.comments[0]?.start_line, undefined);
  assert.equal(request.comments[0]?.line, 1);
  assert.match(request.comments[0]?.body ?? "", /Target: `@src\/change\.ts:1`/u);
});

test("does not include secrets in duplicate markers", () => {
  const marker = reviewMarker(context, config);
  assert.doesNotMatch(marker, /github-secret|ai-secret/);
  assert.match(marker, /ai-pr-reviewer:v3:[0-9a-f]{40}:[0-9a-f]{64}/u);
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
  const contextualMarker = reviewMarker(context, config, "conversation-a");
  assert.notEqual(contextualMarker, marker);
  assert.notEqual(contextualMarker, reviewMarker(context, config, "conversation-b"));
  assert.equal(
    aggregateReview(context, config, files, [], "conversation-a").marker,
    contextualMarker,
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

test("maps ranges and renders default-collapsed AI prompts with safe fences", () => {
  const goals: readonly GoalResult[] = [
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
            agentPrompt: [
              "Verify this finding against the current code. Fix it only if it is still valid,",
              "keep the change minimal, and run the relevant tests.",
              "",
              "Target: `@src/change.ts:1-2`",
              "Finding: A ``` marker breaks a fixed fence",
              "Impact: The comment can render incorrectly.",
              "Requested fix: Size the text fence from the complete prompt.",
            ].join("\n"),
            path: "src/change.ts",
            line: 1,
            endLine: 2,
          },
        ],
      },
    },
  ];
  const review = aggregateReview(context, config, files, goals);
  const request = buildReviewRequest(context, review, goals);
  assert.deepEqual(request.comments[0], {
    path: "src/change.ts",
    line: 2,
    side: "RIGHT",
    start_line: 1,
    start_side: "RIGHT",
    body: request.comments[0]?.body,
  });
  assert.match(
    request.comments[0]?.body ?? "",
    /<details>\n<summary>🤖 Prompt for AI Agents<\/summary>\n\n````text\n[\s\S]*Finding: A ``` marker breaks a fixed fence[\s\S]*\n````\n\n<\/details>/u,
  );
  assert.doesNotMatch(request.comments[0]?.body ?? "", /<details open|```suggestion/u);
  assert.doesNotMatch(buildReviewBody(review, goals), /Prompt for AI Agents/u);
  assert.doesNotMatch(buildRunSummary(context, review, goals), /Prompt for AI Agents/u);
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

test("omits AI prompts when the inline range cannot be verified", () => {
  const review = aggregateReview(context, config, files, [
    {
      prompt: "invalid suggestion location",
      status: "completed",
      submission: {
        summary: "invalid suggestion location",
        findings: [
          {
            title: "Unverified replacement",
            severity: "HIGH",
            body: "The claimed line is outside the diff.",
            agentPrompt: "Target: `@src/change.ts:99`\nFinding: Unverified replacement",
            path: "src/change.ts",
            line: 99,
          },
        ],
      },
    },
  ]);
  const request = buildReviewRequest(context, review, [
    {
      prompt: "invalid suggestion location",
      status: "completed",
      submission: { summary: "unused", findings: [] },
    },
  ]);

  assert.equal(review.findings[0]?.agentPrompt, undefined);
  assert.equal(request.comments.length, 0);
  assert.doesNotMatch(request.body, /Prompt for AI Agents|```suggestion/u);
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
