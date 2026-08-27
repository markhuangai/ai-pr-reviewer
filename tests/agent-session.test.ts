import {
  agentInternals,
  assert,
  fakeAgentQuery,
  goalContext,
  makeReviewDiff,
  reviewConfig,
  runReviewGoal,
  test,
  type ConversationMessage,
  type PullRequestContext,
  type ReviewConfig,
  type ReviewConversationSnapshot,
  type SDKMessage,
} from "./agent-test-helpers.js";

test("rejects review submission until the prompt and briefing are complete", () => {
  assert.equal(
    agentInternals.reviewSubmissionRejection(false),
    "Wait for the full review prompt before submitting.",
  );
  assert.equal(agentInternals.reviewSubmissionRejection(true), undefined);
  assert.match(
    agentInternals.reviewSubmissionRejection(true, false, false) ?? "",
    /briefing until done=true/u,
  );
  assert.match(
    agentInternals.reviewSubmissionRejection(true, true) ?? "",
    /already been accepted/u,
  );
});

test("requires the complete prior thread before accepting a located finding", async (t) => {
  const conversation: ReviewConversationSnapshot = {
    digest: "thread-digest",
    entries: [
      {
        kind: "inline_thread",
        id: 91,
        rootAvailable: true,
        createdAt: "2026-08-17T00:00:00Z",
        path: "src/change.ts",
        line: 4,
        messages: [
          {
            id: 91,
            authorLogin: "reviewer",
            authorRole: "human",
            body: `This was previously reported. ${"x".repeat(5_000)}`,
            createdAt: "2026-08-17T00:00:00Z",
            updatedAt: "2026-08-17T00:00:00Z",
            path: "src/change.ts",
            line: 4,
          },
        ],
      },
    ],
  };
  const result = await runReviewGoal(
    "Check the changed behavior.",
    0,
    goalContext,
    [],
    conversation,
    reviewConfig(),
    await makeReviewDiff(t),
    "/workspace/repository",
    fakeAgentQuery({
      submission: {
        summary: "One issue",
        findings: [
          {
            title: "Still broken",
            severity: "HIGH",
            why: "The old guard no longer applies.",
            fix: "Restore the guard.",
            path: "src/change.ts",
            line: 4,
          },
        ],
      },
      skipConversationRead: true,
      assertUnreadThreadRejection: true,
      readThreadPath: "src/change.ts",
      readThreadFirstOnly: true,
      repeatThreadSelector: true,
    }),
  );
  assert.equal(result.status, "completed");
  assert.equal(result.submission?.findings[0]?.path, "src/change.ts");
});

test("requires a path-scoped discussion read for sibling threads after an id-scoped read", async (t) => {
  const message = (id: number, body: string): ConversationMessage => ({
    id,
    authorLogin: "reviewer",
    authorRole: "human",
    body,
    createdAt: "2026-08-17T00:00:00Z",
    updatedAt: "2026-08-17T00:00:00Z",
    path: "src/change.ts",
    line: 4,
  });
  const conversation: ReviewConversationSnapshot = {
    digest: "thread-digest",
    entries: [
      {
        kind: "inline_thread",
        id: 91,
        rootAvailable: true,
        createdAt: "2026-08-17T00:00:00Z",
        path: "src/change.ts",
        line: 4,
        messages: [message(91, "First prior finding")],
      },
      {
        kind: "inline_thread",
        id: 92,
        rootAvailable: true,
        createdAt: "2026-08-17T00:02:00Z",
        path: "src/change.ts",
        line: 9,
        messages: [message(92, "Second prior finding")],
      },
    ],
  };
  const result = await runReviewGoal(
    "Check the changed behavior.",
    0,
    goalContext,
    [],
    conversation,
    reviewConfig(),
    await makeReviewDiff(t),
    "/workspace/repository",
    fakeAgentQuery({
      submission: {
        summary: "One issue",
        findings: [
          {
            title: "Still broken",
            severity: "HIGH",
            why: "The old guard no longer applies.",
            fix: "Restore the guard.",
            path: "src/change.ts",
            line: 9,
          },
        ],
      },
      skipConversationRead: true,
      assertUnreadThreadRejection: true,
      assertUnreadThreadAfterId: true,
      readThreadId: 91,
      readThreadPath: "src/change.ts",
    }),
  );
  assert.equal(result.status, "completed");
  assert.equal(result.submission?.findings[0]?.path, "src/change.ts");
});

test("accepts a finding after reading its exact discussion thread by id", async (t) => {
  const conversation: ReviewConversationSnapshot = {
    digest: "exact-thread-digest",
    entries: [
      {
        kind: "inline_thread",
        id: 91,
        rootAvailable: true,
        createdAt: "2026-08-17T00:00:00Z",
        path: "src/change.ts",
        line: 4,
        messages: [
          {
            id: 91,
            authorLogin: "reviewer",
            authorRole: "human",
            body: "This was previously reported.",
            createdAt: "2026-08-17T00:00:00Z",
            updatedAt: "2026-08-17T00:00:00Z",
            path: "src/change.ts",
            line: 4,
          },
        ],
      },
      {
        kind: "inline_thread",
        id: 92,
        rootAvailable: true,
        createdAt: "2026-08-17T00:02:00Z",
        path: "src/change.ts",
        line: 9,
        messages: [],
      },
    ],
  };
  const result = await runReviewGoal(
    "Check the changed behavior.",
    0,
    goalContext,
    [],
    conversation,
    reviewConfig(),
    await makeReviewDiff(t),
    "/workspace/repository",
    fakeAgentQuery({
      submission: {
        summary: "One issue",
        findings: [
          {
            title: "Still broken",
            severity: "HIGH",
            why: "The old guard no longer applies.",
            fix: "Restore the guard.",
            path: "src/change.ts",
            line: 4,
          },
        ],
      },
      skipConversationRead: true,
      assertUnreadThreadRejection: true,
      readThreadId: 91,
    }),
  );
  assert.equal(result.status, "completed");
  assert.equal(result.submission?.findings[0]?.line, 4);
});

test("matches discussion coverage across renamed paths", async (t) => {
  const conversation: ReviewConversationSnapshot = {
    digest: "renamed-thread-digest",
    entries: [
      {
        kind: "inline_thread",
        id: 93,
        rootAvailable: true,
        createdAt: "2026-08-17T00:00:00Z",
        path: "src/old.ts",
        line: 4,
        messages: [
          {
            id: 93,
            authorLogin: "reviewer",
            authorRole: "human",
            body: "This was previously reported.",
            createdAt: "2026-08-17T00:00:00Z",
            updatedAt: "2026-08-17T00:00:00Z",
            path: "src/old.ts",
            line: 4,
          },
        ],
      },
    ],
  };
  const result = await runReviewGoal(
    "Check the changed behavior.",
    0,
    goalContext,
    [
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        changes: 2,
        addedLines: new Set([4]),
      },
    ],
    conversation,
    reviewConfig(),
    await makeReviewDiff(t),
    "/workspace/repository",
    fakeAgentQuery({
      submission: {
        summary: "One issue",
        findings: [
          {
            title: "Still broken",
            severity: "HIGH",
            why: "The old guard no longer applies.",
            fix: "Restore the guard.",
            path: "src/new.ts",
            line: 4,
          },
        ],
      },
      skipConversationRead: true,
      assertUnreadThreadRejection: true,
      readThreadPath: "src/new.ts",
    }),
  );
  assert.equal(result.status, "completed");
  assert.equal(result.submission?.findings[0]?.path, "src/new.ts");
});

test("accepts exactly the four public finding severities", () => {
  for (const severity of ["CRITICAL", "HIGH", "MODERATE", "LOW"] as const) {
    assert.equal(
      agentInternals.submissionSchema.safeParse({
        summary: "finding",
        findings: [
          {
            title: "Actionable defect",
            severity,
            why: "The defect breaks a supported path.",
            fix: "Use the validated value.",
          },
        ],
      }).success,
      true,
      severity,
    );
  }
  for (const severity of ["MEDIUM", "INFO"] as const) {
    assert.equal(
      agentInternals.submissionSchema.safeParse({
        summary: "legacy finding",
        findings: [
          {
            title: "Legacy severity",
            severity,
            why: "The defect breaks a supported path.",
            fix: "Use the validated value.",
          },
        ],
      }).success,
      false,
      severity,
    );
  }
});

test("rejects model-authored apply suggestions", () => {
  assert.equal(
    agentInternals.submissionSchema.safeParse({
      summary: "finding",
      findings: [
        {
          title: "Replace the affected region",
          severity: "HIGH",
          why: "The current region returns the wrong value.",
          fix: "Replace the full contiguous region.",
          suggestion: "Change credential.Role to credential.GetRole().",
          path: "src/change.ts",
          line: 10,
        },
      ],
    }).success,
    false,
  );
});

test("rejects required finding prose that normalizes to empty", () => {
  const finding = {
    title: "Actionable defect",
    severity: "HIGH",
    why: "The defect breaks a supported path.",
    fix: "Use the validated value.",
  };

  for (const field of ["title", "why", "fix"] as const) {
    assert.equal(
      agentInternals.submissionSchema.safeParse({
        summary: "finding",
        findings: [{ ...finding, [field]: " \t\n " }],
      }).success,
      false,
      field,
    );
  }
});

test("renders structured finding prose and a deterministic AI prompt", () => {
  const submission = agentInternals.toSubmission({
    summary: "finding",
    findings: [
      {
        title: "  Return   the result ",
        severity: "HIGH",
        why: " The current path   drops the result. ",
        fix: " Return it from the   verified branch. ",
        path: "src/change.ts",
        line: 10,
        endLine: 12,
      },
    ],
  });

  assert.deepEqual(submission.findings[0], {
    title: "Return the result",
    severity: "HIGH",
    body: "**Why it matters:** The current path drops the result.\n\n**Fix:** Return it from the verified branch.",
    agentPrompt: [
      "Verify this finding against the current code. Fix it only if it is still valid,",
      "keep the change minimal, and run the relevant tests.",
      "",
      "Target: `@src/change.ts:10-12`",
      "Finding: Return the result",
      "Impact: The current path drops the result.",
      "Requested fix: Return it from the verified branch.",
    ].join("\n"),
    path: "src/change.ts",
    line: 10,
    endLine: 12,
  });
});

test("does not create an AI prompt without an inline target", () => {
  const submission = agentInternals.toSubmission({
    summary: "finding",
    findings: [
      {
        title: "Return the result",
        severity: "HIGH",
        why: "The current path drops the result.",
        fix: "Return it from the verified branch.",
      },
    ],
  });

  assert.equal(submission.findings[0]?.agentPrompt, undefined);
});

test("teaches the four severity definitions before review submission", () => {
  const events: string[] = [];
  const queued: SDKMessage[] = [];
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 8,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    baseRef: "main",
    title: "Severity contract",
    htmlUrl: "https://github.com/owner/repository/pull/8",
  };

  agentInternals.startReviewPrompt(
    {
      push: (message) => {
        queued.push(message);
        events.push(`push-${queued.length}`);
      },
    },
    "Check severity guidance.",
    context,
    [],
    context.baseSha,
    0,
    [],
    0,
    [],
    () => events.push("activate"),
    () => undefined,
  );

  const prompt = (queued[1] as { message: { content: string } }).message.content;
  for (const severity of ["CRITICAL", "HIGH", "MODERATE", "LOW"])
    assert.match(prompt, new RegExp(`- ${severity}:`, "u"));
  assert.match(prompt, /Omit style preferences, nits, and informational observations/u);
  assert.doesNotMatch(prompt, /- MEDIUM:|- INFO:/u);
  assert.match(prompt, /Set endLine only when the finding spans a contiguous range/u);
  assert.doesNotMatch(prompt, /raw replacement text|apply suggestions/u);
  assert.match(agentInternals.repairPrompt(1), /MEDIUM and INFO are invalid/u);
  assert.match(agentInternals.repairPrompt(1), /path, line, and endLine are optional/u);
  assert.doesNotMatch(agentInternals.repairPrompt(1), /suggestion/u);
  assert.doesNotMatch(agentInternals.repairPrompt(1), /read_pr_conversation|read_pr_diff/u);
  assert.match(agentInternals.repairPrompt(1, false), /read_review_briefing/u);
});

test("starts each review with a bounded Claude goal command", () => {
  const command = agentInternals.goalCommand("Check authentication paths and failure handling.");
  assert.equal(
    command,
    "/goal Complete the pull-request review goal: Check authentication paths and failure handling.",
  );
  assert.ok(command.slice("/goal ".length).length <= 4_000);
  const longCommand = agentInternals.goalCommand("x".repeat(5_000));
  assert.ok(longCommand.slice("/goal ".length).length <= 4_000);
  assert.match(longCommand, /full goal is in the review prompt/);
});

test("recognizes only paths under the checked-out repository", () => {
  assert.equal(agentInternals.isWithinRepository("/workspace/repo", "src/index.ts"), true);
  assert.equal(agentInternals.isWithinRepository("/workspace/repo", "/workspace/repo/src"), true);
  assert.equal(agentInternals.isWithinRepository("/workspace/repo", "/workspace/secret"), false);
  assert.equal(agentInternals.isWithinRepository("/workspace/repo", "../secret"), false);
});

test("rejects traversal and absolute alternatives in Glob braces", () => {
  assert.equal(agentInternals.isSafeGlobPattern("src/{lib,test}/**/*.ts"), true);
  assert.equal(agentInternals.isSafeGlobPattern("{../*,src/*}"), false);
  assert.equal(agentInternals.isSafeGlobPattern("{/etc,src}/*"), false);
});

test("allows repository-wide Grep while blocking Git metadata globs", () => {
  assert.equal(agentInternals.isSafeGrepGlob("/workspace/repo", ".", undefined), true);
  assert.equal(agentInternals.isSafeGrepGlob("/workspace/repo", "src", undefined), true);
  assert.equal(agentInternals.isSafeGrepGlob("/workspace/repo", ".", "**/*"), true);
  assert.equal(agentInternals.isSafeGrepGlob("/workspace/repo", "src", "**/*"), true);
  assert.equal(agentInternals.isSafeGrepGlob("/workspace/repo", ".", "src/**/*.ts"), true);
  assert.equal(agentInternals.isSafeGrepGlob("/workspace/repo", ".", "**/.g[i]t/**"), false);
  assert.equal(agentInternals.isSafeGrepGlob("/workspace/repo", ".", "**/.g?t/**"), false);
  assert.equal(agentInternals.isSafeGlobPattern("**/[.]git/**"), false);
  assert.equal(agentInternals.isSafeGlobPattern("/workspace/repo/**/.g[i]t/**"), false);
  assert.equal(agentInternals.isSafeGlobPattern(".github/**"), true);
});

test("blocks Git metadata paths from the reviewer", () => {
  assert.equal(agentInternals.isGitMetadataPath(".git/config"), true);
  assert.equal(agentInternals.isGitMetadataPath(".GIT/config"), true);
  assert.equal(agentInternals.isGitMetadataPath("src/.git/objects"), true);
  assert.equal(agentInternals.isGitMetadataPath(".github/workflows/ci.yml"), false);
  assert.equal(
    agentInternals.isSafeResolvedPath("/workspace/repo", "/workspace/repo/.git/config"),
    false,
  );
  assert.equal(agentInternals.isSafeResolvedPath("/workspace/repo", "/workspace/repo/src"), true);
});

test("reports the reviewed checkout as the subprocess workspace", () => {
  const config: ReviewConfig = {
    githubToken: "github-secret",
    aiBaseUrl: "https://ai.example.test",
    aiSecret: "ai-secret",
    model: "review-model",
    reviewPrompts: [{ prompt: "correctness", files: [] }],
    parallelCount: 1,
    maxTurns: 2,
    autoApprove: false,
    interactWithPullRequest: false,
    mcpServers: {},
  };

  const environment = agentInternals.safeAgentEnvironment(config, "/tmp/reviewed-repository");
  assert.equal(environment.GITHUB_WORKSPACE, "/tmp/reviewed-repository");
  assert.equal(environment.ANTHROPIC_API_KEY, "ai-secret");
  assert.equal(environment.API_TIMEOUT_MS, "300000");
  assert.equal(environment.CLAUDE_STREAM_IDLE_TIMEOUT_MS, "300000");
  assert.equal(environment.CLAUDE_CODE_MAX_RETRIES, "1");
});
