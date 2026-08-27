import { strict as assert } from "node:assert";
import test from "node:test";

import {
  aggregateReview,
  buildReviewBody,
  buildReviewRequest,
  buildRunSummary,
  reviewMarker,
} from "../src/lib/aggregate.js";
import type { GoalResult, ReviewConfig } from "../src/lib/types.js";
import { config, context, files } from "./aggregate-test-fixtures.js";

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

  assert.match(body, new RegExp(`^${review.marker}\\n## ✨ Good job!`, "u"));
  assert.match(body, /<summary>📊 Token usage · 0 tokens<\/summary>/u);
  assert.doesNotMatch(body, /estimated cost|Pricing:|Rates per 1M/iu);
  assert.equal(review.event, "APPROVE");
  assert.doesNotMatch(body, /PRIVATE REVIEW GOAL|PRIVATE MODEL SUMMARY|### Goals|completed/u);
});

test("combines token usage across every goal without showing cost when pricing is absent", () => {
  const goals: readonly GoalResult[] = [
    {
      prompt: "one",
      status: "completed",
      submission: { summary: "clean", findings: [] },
      tokenUsage: {
        complete: true,
        models: [
          {
            model: "review-model",
            canonicalModel: "canonical-model",
            inputTokens: 100,
            outputTokens: 20,
            cacheReadInputTokens: 300,
            cacheCreationInputTokens: 40,
          },
        ],
      },
    },
    {
      prompt: "two",
      status: "completed",
      submission: { summary: "clean", findings: [] },
      tokenUsage: {
        complete: true,
        models: [
          {
            model: "review-model",
            canonicalModel: "canonical-model",
            inputTokens: 5,
            outputTokens: 2,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 4,
          },
        ],
      },
    },
  ];
  const review = aggregateReview(context, config, files, goals);
  const body = buildReviewBody(review, goals);
  const summary = buildRunSummary(context, review, goals);

  assert.deepEqual(review.tokenUsage.totals, {
    inputTokens: 105,
    outputTokens: 22,
    cacheReadInputTokens: 330,
    cacheCreationInputTokens: 44,
  });
  assert.equal(review.tokenUsage.models.length, 1);
  assert.equal(review.tokenUsage.complete, true);
  for (const rendered of [body, summary]) {
    assert.match(rendered, /<details>\n<summary>📊 Token usage · 501 tokens<\/summary>/u);
    assert.doesNotMatch(rendered, /<details open/iu);
    assert.match(
      rendered,
      /\| <code>review-model<\/code><br><sub>canonical: <code>canonical-model<\/code><\/sub> \| 105 \| 22 \| 330 \| 44 \| \*\*501\*\* \|/u,
    );
    assert.doesNotMatch(rendered, /- Total tokens:|#### Models|Rates per/iu);
    assert.doesNotMatch(rendered, /cost|Pricing:|unpriced|Rates per 1M/iu);
  }
});

test("prices raw model IDs before canonical IDs and labels unknown models as a lower bound", () => {
  const pricedConfig: ReviewConfig = {
    ...config,
    modelPricing: {
      currency: "$",
      models: {
        alias: { input: 1, output: 0, cacheHit: 0, cacheCreation: 0 },
        canonical: { input: 100, output: 0, cacheHit: 0, cacheCreation: 0 },
        "canonical-only": { input: 2, output: 0, cacheHit: 0, cacheCreation: 0 },
      },
    },
  };
  const goals: readonly GoalResult[] = [
    {
      prompt: "pricing",
      status: "completed",
      submission: { summary: "clean", findings: [] },
      tokenUsage: {
        complete: true,
        models: [
          {
            model: "alias",
            canonicalModel: "canonical",
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          {
            model: "provider-id",
            canonicalModel: "canonical-only",
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
          {
            model: "ALIAS",
            canonicalModel: "CANONICAL",
            inputTokens: 1_000_000,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
          },
        ],
      },
    },
  ];
  const review = aggregateReview(context, pricedConfig, files, goals);
  const body = buildReviewBody(review, goals);

  assert.equal(review.tokenUsage.estimatedCost, 3);
  assert.equal(
    review.tokenUsage.models.find((usage) => usage.model === "alias")?.pricingModel,
    "alias",
  );
  assert.equal(
    review.tokenUsage.models.find((usage) => usage.model === "provider-id")?.pricingModel,
    "canonical-only",
  );
  assert.equal(
    review.tokenUsage.models.find((usage) => usage.model === "ALIAS")?.pricing,
    undefined,
  );
  assert.match(
    body,
    /<summary>📊 Token usage · 3,000,000 tokens · 💰 Estimated at least \$3\.00<\/summary>/u,
  );
  assert.match(body, /\| <code>ALIAS<\/code><br><sub>⚠️ unpriced<\/sub> \| — \| — \| — \| — \|/u);
  assert.match(
    body,
    /\| <code>provider-id<\/code><br><sub>match: <code>canonical-only<\/code><\/sub> \| \$2 \| \$0 \| \$0 \| \$0 \|/u,
  );
  assert.match(body, /\| \*\*Total\*\* \| \*\*3,000,000\*\*/u);
  assert.doesNotMatch(body, /Pricing:|Rates per/iu);
});

test("rounds only the grand total and preserves escaped currency and model text", () => {
  const dangerousModel = "</details>\n# injected";
  const goals: readonly GoalResult[] = [
    {
      prompt: "pricing",
      status: "completed",
      submission: { summary: "clean", findings: [] },
      tokenUsage: {
        complete: true,
        models: [
          {
            model: dangerousModel,
            inputTokens: 100_000,
            outputTokens: 50_000,
            cacheReadInputTokens: 1_000_000,
            cacheCreationInputTokens: 30_000,
          },
        ],
      },
    },
  ];
  const rates = { input: 1.2, output: 2, cacheHit: 0.12, cacheCreation: 0.6 };
  for (const [currency, expected] of [
    ["$", "$0.36"],
    ["USD", "USD0.36"],
    ["USD ", "USD 0.36"],
  ] as const) {
    const review = aggregateReview(
      context,
      { ...config, modelPricing: { currency, models: { [dangerousModel]: rates } } },
      files,
      goals,
    );
    const body = buildReviewBody(review, goals);
    const summary = buildRunSummary(context, review, goals);
    assert.ok(Math.abs((review.tokenUsage.estimatedCost ?? 0) - 0.358) < 1e-12);
    for (const rendered of [body, summary]) {
      assert.ok(rendered.includes(`💰 Estimated ${expected}`));
      assert.match(rendered, /\| Model \| Input \| Output \| Cache hit \| Cache creation \|/u);
      assert.doesNotMatch(rendered, /calculated line item/iu);
      assert.match(rendered, /<code>&lt;\/details&gt;&#10;# injected<\/code>/u);
      assert.doesNotMatch(rendered, /<\/details>\n# injected/u);
    }
  }

  const escaped = aggregateReview(
    context,
    {
      ...config,
      modelPricing: { currency: "</summary>\n# cost ", models: { [dangerousModel]: rates } },
    },
    files,
    goals,
  );
  assert.match(buildReviewBody(escaped, goals), /&lt;\/summary&gt;&#10;# cost 0\.36/u);
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
  assert.equal(marker, reviewMarker(context, { ...config, githubToken: "another-github-token" }));
  const highEffortMarker = reviewMarker(context, { ...config, effort: "high" });
  assert.notEqual(marker, highEffortMarker);
  assert.notEqual(highEffortMarker, reviewMarker(context, { ...config, effort: "medium" }));
  const customPrompt = "custom reviewer prompt";
  const customPromptMarker = reviewMarker(context, { ...config, systemPrompt: customPrompt });
  assert.notEqual(marker, customPromptMarker);
  assert.notEqual(
    customPromptMarker,
    reviewMarker(context, { ...config, systemPrompt: "another prompt" }),
  );
  assert.doesNotMatch(customPromptMarker, /custom reviewer prompt/u);
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
  const briefingMarker = reviewMarker(context, config, "", [], "briefing-a");
  assert.notEqual(briefingMarker, marker);
  assert.notEqual(briefingMarker, reviewMarker(context, config, "", [], "briefing-b"));
  assert.equal(
    aggregateReview(context, config, files, [], "conversation-a").marker,
    contextualMarker,
  );
  assert.equal(
    aggregateReview(context, config, files, [], "", [], "briefing-a").marker,
    briefingMarker,
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

test("binds duplicate review identity to context contents and goal authorization", () => {
  const ticket = {
    path: "/runner/context/ticket.json",
    sizeBytes: 100,
    sha256: "a".repeat(64),
  };
  const policy = {
    path: "/runner/context/policy.txt",
    sizeBytes: 200,
    sha256: "b".repeat(64),
  };
  const first = reviewMarker(context, config, "conversation", [[ticket, policy], []]);
  assert.equal(first, reviewMarker(context, config, "conversation", [[policy, ticket], []]));
  assert.notEqual(
    first,
    reviewMarker(context, config, "conversation", [
      [{ ...ticket, sha256: "c".repeat(64) }, policy],
      [],
    ]),
  );
  assert.notEqual(first, reviewMarker(context, config, "conversation", [[], [ticket, policy]]));
  assert.equal(
    aggregateReview(context, config, files, [], "conversation", [[ticket, policy], []]).marker,
    first,
  );
  assert.equal(first.includes(ticket.path), false);
  assert.equal(first.includes(ticket.sha256), false);
});

test("includes stable pricing configuration in duplicate marker identity", () => {
  const first: ReviewConfig = {
    ...config,
    modelPricing: {
      currency: "$",
      models: {
        beta: { input: 2, output: 3, cacheHit: 0.2, cacheCreation: 0.4 },
        alpha: { input: 1, output: 4, cacheHit: 0.1, cacheCreation: 0.5 },
      },
    },
  };
  const reordered: ReviewConfig = {
    ...config,
    modelPricing: {
      currency: "$",
      models: {
        alpha: { input: 1, output: 4, cacheHit: 0.1, cacheCreation: 0.5 },
        beta: { input: 2, output: 3, cacheHit: 0.2, cacheCreation: 0.4 },
      },
    },
  };

  assert.equal(reviewMarker(context, first), reviewMarker(context, reordered));
  assert.notEqual(reviewMarker(context, first), reviewMarker(context, config));
  assert.notEqual(
    reviewMarker(context, first),
    reviewMarker(context, {
      ...reordered,
      modelPricing: {
        currency: "$",
        models: {
          alpha: { input: 1, output: 4, cacheHit: 0.1, cacheCreation: 0.5 },
          beta: { input: 2.1, output: 3, cacheHit: 0.2, cacheCreation: 0.4 },
        },
      },
    }),
  );
  assert.notEqual(
    reviewMarker(context, first),
    reviewMarker(context, {
      ...reordered,
      modelPricing: {
        currency: "USD",
        models: {
          alpha: { input: 1, output: 4, cacheHit: 0.1, cacheCreation: 0.5 },
          beta: { input: 2, output: 3, cacheHit: 0.2, cacheCreation: 0.4 },
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
