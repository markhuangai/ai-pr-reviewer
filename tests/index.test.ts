import {
  GitHubApi,
  GitHubApiError,
  access,
  actionReader,
  assert,
  buildRunSummary,
  cleanWorkspace,
  config,
  createServer,
  emptyConversationApi,
  execFileAsync,
  indexInternals,
  join,
  mkdir,
  mkdtemp,
  readFile,
  readReviewConfig,
  reviewMarker,
  rm,
  runAction,
  test,
  tmpdir,
  type GoalResult,
  type PullRequestContext,
  type PullRequestReviewRequest,
  type ReviewBriefing,
  useWorkspace,
  writeFile,
} from "./index-test-helpers.js";

test("redaction secrets include configured AI and MCP endpoints", () => {
  const secrets = indexInternals.reviewSecrets(config);
  const aiBaseUrl = config.aiBaseUrl;
  assert.ok(aiBaseUrl);
  assert.ok(secrets.includes(aiBaseUrl));
  assert.ok(secrets.includes(config.mcpServers.security?.url ?? ""));
  assert.ok(secrets.includes("ai-url%2Fsecret"));
  assert.ok(secrets.includes("ai-url/secret"));
  assert.ok(secrets.includes("mcp-url%2Fsecret"));
  assert.ok(secrets.includes("mcp-url/secret"));
  assert.ok(secrets.includes("subscription-secret"));
  assert.ok(secrets.includes("bare-key-secret"));
  assert.ok(secrets.includes("camel-api-secret"));
  assert.ok(secrets.includes("camel-access-secret"));
  assert.ok(secrets.includes("camel-client-secret"));
  assert.equal(secrets.includes("2023-06-01"), false);
  assert.equal(secrets.includes("public-tenant"), false);
  assert.equal(secrets.includes("public-monkey"), false);
  assert.ok(secrets.includes("Bearer mcp-header-secret"));
  assert.ok(secrets.includes("mcp-header-secret"));
  assert.ok(secrets.includes("proxy-credentials"));
  assert.equal(secrets.includes("value"), false);
  assert.equal(
    indexInternals.redact(
      `AI failed at ${aiBaseUrl}; MCP failed at ${config.mcpServers.security?.url}.`,
      secrets,
    ),
    "AI failed at [REDACTED]; MCP failed at [REDACTED].",
  );
  assert.equal(
    indexInternals.redact(`${aiBaseUrl}/mcp?signature=leaked`, [
      aiBaseUrl,
      `${aiBaseUrl}/mcp?signature=leaked`,
    ]),
    "[REDACTED]",
  );
  assert.equal(
    indexInternals.redact("MCP returned mcp-header-secret.", secrets),
    "MCP returned [REDACTED].",
  );
  assert.equal(
    indexInternals.redact("Provider returned mcp-url/secret.", secrets),
    "Provider returned [REDACTED].",
  );
  assert.equal(
    indexInternals.redact("a data a prod production prod-prod", ["a", "prod"]),
    "[REDACTED] data [REDACTED] [REDACTED] production [REDACTED]-[REDACTED]",
  );
});

test("redacts generated AI prompts without dropping them", () => {
  const [goal, failedGoal] = indexInternals.redactGoals(
    [
      {
        prompt: "security",
        status: "completed",
        tokenUsage: {
          complete: true,
          models: [
            {
              model: "provider-private-token",
              canonicalModel: "private-token-canonical",
              inputTokens: 1,
              outputTokens: 2,
              cacheReadInputTokens: 3,
              cacheCreationInputTokens: 4,
            },
          ],
        },
        submission: {
          summary: "finding",
          findings: [
            {
              title: "Replace secret",
              severity: "HIGH",
              body: "The value private-token is exposed.",
              agentPrompt:
                "Impact: private-token is exposed.\nRequested fix: Remove private-token.",
              path: "src/change.ts",
              line: 1,
            },
            {
              title: "Keep safe replacement",
              severity: "LOW",
              body: "The value is stale.",
              agentPrompt: "Impact: The value is stale.\nRequested fix: Return the current value.",
              path: "src/change.ts",
              line: 2,
            },
          ],
        },
      },
      {
        prompt: "failure",
        status: "failed",
        error: "private-token failed",
        tokenUsage: {
          complete: false,
          models: [
            {
              model: "private-token-model",
              inputTokens: 0,
              outputTokens: 0,
              cacheReadInputTokens: 0,
              cacheCreationInputTokens: 0,
            },
          ],
        },
      },
    ],
    ["private-token"],
  );

  assert.equal(goal?.submission?.findings[0]?.body, "The value [REDACTED] is exposed.");
  assert.equal(goal?.tokenUsage?.models[0]?.model, "provider-[REDACTED]");
  assert.equal(goal?.tokenUsage?.models[0]?.canonicalModel, "[REDACTED]-canonical");
  assert.equal(
    goal?.submission?.findings[0]?.agentPrompt,
    "Impact: [REDACTED] is exposed.\nRequested fix: Remove [REDACTED].",
  );
  assert.equal(
    goal?.submission?.findings[1]?.agentPrompt,
    "Impact: The value is stale.\nRequested fix: Return the current value.",
  );
  assert.equal(failedGoal?.error, "[REDACTED] failed");
  assert.equal(failedGoal?.tokenUsage?.models[0]?.model, "[REDACTED]-model");
  assert.equal(failedGoal?.submission, undefined);
});

test("workspace validation rejects ignored content", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-workspace-"));
  t.after(() => rm(workspace, { force: true, recursive: true }));
  await execFileAsync("git", ["init", "--quiet"], { cwd: workspace });
  await writeFile(join(workspace, ".gitignore"), ".env\n");
  await writeFile(join(workspace, "tracked.txt"), "tracked\n");
  await execFileAsync("git", ["add", ".gitignore", "tracked.txt"], { cwd: workspace });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "--message=initial",
    ],
    { cwd: workspace },
  );
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: workspace });
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 1,
    headSha: stdout.trim(),
    baseSha: "base",
    baseRef: "main",
    title: "Change",
    htmlUrl: "https://github.com/owner/repository/pull/1",
  };

  await indexInternals.assertWorkspace(context, workspace);
  await writeFile(join(workspace, ".env"), "SECRET=ignored\n");

  await assert.rejects(
    indexInternals.assertWorkspace(context, workspace),
    /tracked, untracked, or ignored content/,
  );
});

test("attempts workspace cleanup when context cleanup fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-cleanup-test-"));
  const temporaryWorkspace = join(root, "workspace");
  await mkdir(temporaryWorkspace);
  t.after(() => rm(root, { force: true, recursive: true }));

  await assert.rejects(
    indexInternals.cleanupReviewArtifacts(
      { cleanup: () => Promise.reject(new Error("context cleanup failed")) },
      { cleanup: () => rm(temporaryWorkspace, { force: true, recursive: true }) },
    ),
    /context cleanup failed/u,
  );
  await assert.rejects(access(temporaryWorkspace));
});

test("summary-only URL reviews make GET requests and write one run summary", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-index-"));
  t.after(() => rm(workspace, { force: true, recursive: true }));
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: workspace });
  await writeFile(join(workspace, "review.txt"), "base\n");
  await execFileAsync("git", ["add", "review.txt"], { cwd: workspace });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "--message=base",
    ],
    { cwd: workspace },
  );
  const { stdout: baseOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  });
  await writeFile(join(workspace, "review.txt"), "head\n");
  await execFileAsync("git", ["add", "review.txt"], { cwd: workspace });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "--message=head",
    ],
    { cwd: workspace },
  );
  const { stdout: headOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  });
  const baseSha = baseOutput.trim();
  const headSha = headOutput.trim();
  const requests: Array<{
    readonly method: string | undefined;
    readonly path: string | undefined;
    readonly authorization: string | undefined;
  }> = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      authorization: request.headers.authorization,
    });
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/user") {
      response.end(JSON.stringify({ login: "review-action" }));
      return;
    }
    if (request.url?.includes("/reviews?")) {
      response.end("[]");
      return;
    }
    if (request.url?.includes("/pulls/9/comments?")) {
      response.end("[]");
      return;
    }
    if (request.url?.includes("/issues/9/comments?")) {
      response.end(
        JSON.stringify([
          {
            id: 1,
            user: { login: "pr-owner", type: "User" },
            body: "Owner context contains test-ai-secret.",
            created_at: "2026-08-17T00:00:00Z",
            updated_at: "2026-08-17T00:00:00Z",
            performed_via_github_app: null,
          },
        ]),
      );
      return;
    }
    if (request.url?.includes("/files?")) {
      response.end(
        JSON.stringify([
          {
            filename: "live-only.txt",
            status: "modified",
            additions: 1,
            deletions: 1,
            changes: 2,
            patch: "@@ -1 +1 @@\n-base\n+head",
          },
        ]),
      );
      return;
    }
    if (request.url?.endsWith("/issues/12")) {
      response.end(
        JSON.stringify({
          title: "Linked test-ai-secret",
          body: "Linked context contains test-ai-secret.",
          state: "open",
          html_url: "https://github.com/target/project/issues/12",
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        title: "External test-ai-secret",
        body: "Fixes #12; PR context contains test-ai-secret.",
        changed_files: 1,
        head: { sha: headSha },
        base: { sha: baseSha, ref: "main" },
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const previousServerUrl = process.env.GITHUB_SERVER_URL;
  process.env.GITHUB_SERVER_URL = "https://github.com";
  t.after(() => {
    if (previousServerUrl === undefined) delete process.env.GITHUB_SERVER_URL;
    else process.env.GITHUB_SERVER_URL = previousServerUrl;
  });
  const values: Readonly<Record<string, string>> = {
    "github-pat": "test-token",
    "ai-base-url": "https://ai.example.test",
    "ai-secret": "test-ai-secret",
    model: "review-model",
    "review-prompts": JSON.stringify([{ prompt: "correctness" }]),
    "interact-with-pr": "false",
    "pull-request-url": "https://github.com/target/project/pull/9",
  };
  const goals: readonly GoalResult[] = [
    {
      prompt: "correctness",
      status: "completed",
      submission: {
        summary: "one issue",
        findings: [
          {
            title: "Unchecked result",
            severity: "HIGH",
            body: "The returned value is ignored.",
            path: "review.txt",
            line: 1,
          },
        ],
      },
    },
  ];
  let cleanupCount = 0;
  let goalRuns = 0;
  let summaryWrites = 0;
  let renderedSummary = "";

  const result = await runAction({ get: (name) => values[name] ?? "" }, [], {
    createApi: (token) => new GitHubApi(token, `http://127.0.0.1:${address.port}`),
    readEventContext: () => Promise.resolve(undefined),
    createWorkspace: (context, token) => {
      assert.equal(context.repository, "target/project");
      assert.equal(context.title, "External test-ai-secret");
      assert.equal(context.headSha, headSha);
      assert.equal(token, "test-token");
      return Promise.resolve({
        path: workspace,
        cleanup: () => {
          cleanupCount += 1;
          return Promise.resolve();
        },
      });
    },
    runGoals: (
      context,
      files,
      conversation,
      _config,
      contextFiles,
      cwd,
      _queryAgent,
      _abortController,
      briefing: ReviewBriefing | undefined,
    ) => {
      goalRuns += 1;
      assert.equal(context.repository, "target/project");
      assert.equal(context.title, "External [REDACTED]");
      assert.equal(files.length, 1);
      assert.equal(files[0]?.path, "review.txt");
      assert.equal(files[0]?.additions, 1);
      assert.equal(files[0]?.deletions, 1);
      assert.deepEqual([...(files[0]?.addedLines ?? [])], [1]);
      assert.equal(conversation.entries.length, 1);
      const entry = conversation.entries[0];
      assert.equal(entry?.kind, "pr_comment");
      if (entry?.kind !== "pr_comment") assert.fail("Expected a PR-level comment.");
      assert.equal(entry.message.body, "Owner context contains [REDACTED].");
      assert.equal(context.body, "Fixes #12; PR context contains [REDACTED].");
      assert.ok(briefing);
      assert.deepEqual(briefing.linkedIssues, [
        {
          number: 12,
          title: "Linked [REDACTED]",
          body: "Linked context contains [REDACTED].",
          state: "open",
          htmlUrl: "https://github.com/target/project/issues/12",
        },
      ]);
      assert.deepEqual(contextFiles, [[]]);
      assert.equal(cwd, workspace);
      return Promise.resolve(goals);
    },
    writeSummary: (context, review, completedGoals) => {
      summaryWrites += 1;
      renderedSummary = buildRunSummary(context, review, completedGoals);
      return Promise.resolve();
    },
  });

  assert.equal(result.skipped, false);
  assert.equal(result.review?.findings.length, 1);
  assert.equal(goalRuns, 1);
  assert.equal(summaryWrites, 1);
  assert.equal(cleanupCount, 1);
  assert.match(renderedSummary, /Unchecked result/u);
  assert.equal(requests.length, 6);
  assert.equal(
    requests.every((request) => request.method === "GET"),
    true,
  );
  assert.equal(
    requests.every((request) => request.authorization === "Bearer test-token"),
    true,
  );
  assert.equal(
    requests.some((request) => request.path === "/user"),
    true,
  );
  assert.equal(
    requests.filter((request) => request.path?.includes("/reviews?") === true).length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.path?.includes("/pulls/9/comments?") === true).length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.path?.includes("/issues/9/comments?") === true).length,
    1,
  );
  assert.equal(
    requests.some((request) => request.path?.includes("/files?") === true),
    false,
  );
});

test("skips an identical current-head review by the authenticated user", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const reader = actionReader();
  const marker = reviewMarker(context, readReviewConfig(reader));
  let goalRuns = 0;
  const api = {
    ...emptyConversationApi("Review-Owner"),
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: context.headSha, baseSha: context.baseSha }),
    listReviews: () =>
      Promise.resolve([
        {
          id: 1,
          author: { login: "review-owner", type: "User" },
          body: marker,
          commitId: context.headSha,
          state: "COMMENTED",
        },
      ]),
  } as unknown as GitHubApi;

  const result = await runAction(reader, [], {
    createApi: () => api,
    readEventContext: () => Promise.resolve(context),
    createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
    runGoals: () => {
      goalRuns += 1;
      return Promise.resolve([]);
    },
    writeSummary: () => Promise.resolve(),
  });

  assert.deepEqual(result, { skipped: true });
  assert.equal(goalRuns, 0);
});

test("passes immutable context snapshots to goals and cleans them after the run", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const contextRoot = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-index-context-"));
  t.after(() => rm(contextRoot, { force: true, recursive: true }));
  const contextPath = join(contextRoot, "ticket.json");
  const originalContent = '{"ticket":"PROJ-123"}\n';
  await writeFile(contextPath, originalContent);
  let snapshotPath = "";
  const api = {
    ...emptyConversationApi(),
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: context.headSha, baseSha: context.baseSha }),
    getPullRequestFiles: () => Promise.resolve([]),
  } as unknown as GitHubApi;

  const result = await runAction(
    actionReader({
      "interact-with-pr": "false",
      "review-prompts": JSON.stringify([
        { prompt: "Review ticket requirements.", files: [contextPath] },
      ]),
    }),
    [],
    {
      createApi: () => api,
      readEventContext: () => Promise.resolve(context),
      createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
      runGoals: async (_context, _files, _conversation, config, contextFiles, cwd) => {
        assert.equal(cwd, workspace);
        assert.deepEqual(config.reviewPrompts, [
          { prompt: "Review ticket requirements.", files: [contextPath] },
        ]);
        const file = contextFiles[0]?.[0];
        assert.ok(file);
        snapshotPath = file.snapshotPath;
        assert.equal(file.path, contextPath);
        assert.equal(await readFile(snapshotPath, "utf8"), originalContent);
        await writeFile(contextPath, "changed after capture\n");
        assert.equal(await readFile(snapshotPath, "utf8"), originalContent);
        return [
          {
            prompt: "Review ticket requirements.",
            status: "completed",
            submission: { summary: "clean", findings: [] },
          },
        ];
      },
      writeSummary: () => Promise.resolve(),
    },
  );

  assert.equal(result.skipped, false);
  assert.notEqual(snapshotPath, "");
  await assert.rejects(access(snapshotPath));
  await indexInternals.assertWorkspace(context, workspace);
});

test("falls back from a rejected approval to a comment review", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const requests: PullRequestReviewRequest[] = [];
  const api = {
    ...emptyConversationApi(),
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: context.headSha, baseSha: context.baseSha }),
    getPullRequestHeadSha: () => Promise.resolve(context.headSha),
    getPullRequestFiles: () => Promise.resolve([]),
    createReview: (_context: PullRequestContext, request: PullRequestReviewRequest) => {
      requests.push(request);
      if (requests.length === 1) {
        return Promise.reject(
          new GitHubApiError(422, "GitHub API request failed: Reviews may not be approved"),
        );
      }
      return Promise.resolve();
    },
  } as unknown as GitHubApi;

  const result = await runAction(actionReader({ "auto-approve": "true" }), [], {
    createApi: () => api,
    readEventContext: () => Promise.resolve(context),
    createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
    runGoals: () =>
      Promise.resolve([
        {
          prompt: "correctness",
          status: "completed",
          submission: { summary: "clean", findings: [] },
        },
      ]),
    writeSummary: () => Promise.resolve(),
  });

  assert.equal(result.skipped, false);
  assert.deepEqual(
    requests.map((request) => request.event),
    ["APPROVE", "COMMENT"],
  );
  assert.match(requests[1]?.body ?? "", /rejected the requested approval/u);
});

test("downgrades a stale auto-approval to a captured comment", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const requests: PullRequestReviewRequest[] = [];
  const api = {
    ...emptyConversationApi(),
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: "f".repeat(40), baseSha: context.baseSha }),
    getPullRequestFiles: () => Promise.resolve([]),
    createReview: (_context: PullRequestContext, request: PullRequestReviewRequest) => {
      requests.push(request);
      return Promise.resolve();
    },
  } as unknown as GitHubApi;

  const result = await runAction(actionReader({ "auto-approve": "true" }), [], {
    createApi: () => api,
    readEventContext: () => Promise.resolve(context),
    createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
    runGoals: () =>
      Promise.resolve([
        {
          prompt: "correctness",
          status: "completed",
          submission: { summary: "clean", findings: [] },
        },
      ]),
    writeSummary: () => Promise.resolve(),
  });

  assert.equal(result.skipped, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.event, "COMMENT");
  assert.match(requests[0]?.body ?? "", /refs changed after capture/u);
});

test("downgrades approval when the captured base changed", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const requests: PullRequestReviewRequest[] = [];
  const api = {
    ...emptyConversationApi(),
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: context.headSha, baseSha: "f".repeat(40) }),
    getPullRequestFiles: () => Promise.resolve([]),
    createReview: (_context: PullRequestContext, request: PullRequestReviewRequest) => {
      requests.push(request);
      return Promise.resolve();
    },
  } as unknown as GitHubApi;

  const result = await runAction(actionReader({ "auto-approve": "true" }), [], {
    createApi: () => api,
    readEventContext: () => Promise.resolve(context),
    createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
    runGoals: () =>
      Promise.resolve([
        {
          prompt: "correctness",
          status: "completed",
          submission: { summary: "clean", findings: [] },
        },
      ]),
    writeSummary: () => Promise.resolve(),
  });

  assert.equal(result.skipped, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.event, "COMMENT");
  assert.match(requests[0]?.body ?? "", /refs changed after capture/u);
});

test("propagates non-approval review failures", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const api = {
    ...emptyConversationApi(),
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: context.headSha, baseSha: context.baseSha }),
    getPullRequestFiles: () => Promise.resolve([]),
    createReview: () => Promise.reject(new GitHubApiError(500, "GitHub unavailable")),
  } as unknown as GitHubApi;
  await assert.rejects(
    runAction(actionReader(), [], {
      createApi: () => api,
      readEventContext: () => Promise.resolve(context),
      createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
      runGoals: () =>
        Promise.resolve([
          {
            prompt: "correctness",
            status: "completed",
            submission: { summary: "finding", findings: [] },
          },
        ]),
      writeSummary: () => Promise.resolve(),
    }),
    /GitHub unavailable/u,
  );
});

test("reviews the captured pull request discussion without rechecking it", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  let issueCommentReads = 0;
  let postedReviews = 0;
  const api = {
    ...emptyConversationApi(),
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: context.headSha, baseSha: context.baseSha }),
    getPullRequestFiles: () => Promise.resolve([]),
    listIssueComments: () => {
      issueCommentReads += 1;
      return Promise.resolve(
        issueCommentReads === 1
          ? []
          : [
              {
                id: 1,
                author: { login: "pr-owner", type: "User" },
                body: "New owner context",
                createdAt: "2026-08-17T00:00:00Z",
                updatedAt: "2026-08-17T00:00:00Z",
                performedViaGitHubApp: false,
              },
            ],
      );
    },
    createReview: () => {
      postedReviews += 1;
      return Promise.resolve();
    },
  } as unknown as GitHubApi;

  const result = await runAction(actionReader(), [], {
    createApi: () => api,
    readEventContext: () => Promise.resolve(context),
    createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
    runGoals: () =>
      Promise.resolve([
        {
          prompt: "correctness",
          status: "completed",
          submission: { summary: "clean", findings: [] },
        },
      ]),
    writeSummary: () => Promise.resolve(),
  });
  assert.equal(result.skipped, false);
  assert.equal(issueCommentReads, 1);
  assert.equal(postedReviews, 1);
});

test("reviews the captured event refs without querying their live state", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  let refReads = 0;
  let postedReviews = 0;
  const snapshotApi = {
    ...emptyConversationApi(),
    getPullRequestRefs: () => {
      refReads += 1;
      return Promise.resolve({ headSha: "f".repeat(40), baseSha: context.baseSha });
    },
    getPullRequestFiles: () => Promise.resolve([]),
    createReview: () => {
      postedReviews += 1;
      return Promise.resolve();
    },
  } as unknown as GitHubApi;
  const result = await runAction(actionReader(), [], {
    createApi: () => snapshotApi,
    readEventContext: () => Promise.resolve(context),
    createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
    runGoals: () =>
      Promise.resolve([
        {
          prompt: "correctness",
          status: "completed",
          submission: { summary: "clean", findings: [] },
        },
      ]),
    writeSummary: () => Promise.resolve(),
  });
  assert.equal(result.skipped, false);
  assert.equal(refReads, 0);
  assert.equal(postedReviews, 1);
});
