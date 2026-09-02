/* eslint-disable max-lines */

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
import type {
  ReviewLifecycleReviewRecord,
  ReviewLifecycleSnapshot,
  ReviewLifecycleThreadRecord,
} from "../src/lib/github-review-lifecycle.js";
import { staleReviewBody } from "../src/lib/review-lifecycle.js";
import { DiagnosticLogger } from "../src/lib/diagnostics.js";

test("correlates action phases and cleanup outcomes in diagnostics", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "action",
    write: (line) => lines.push(line),
    id: (() => {
      let index = 0;
      return () => `action-${++index}`;
    })(),
  });
  const api = {
    ...emptyConversationApi("review-owner"),
    getPullRequestFiles: () => Promise.resolve([]),
  } as unknown as GitHubApi;
  const result = await runAction(
    actionReader({ "interact-with-pr": "false" }),
    [],
    {
      createApi: () => api,
      readEventContext: () => Promise.resolve(context),
      createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
      readFiles: () => Promise.resolve([]),
      runGoals: () =>
        Promise.resolve([
          {
            prompt: "correctness",
            status: "completed",
            submission: { summary: "clean", findings: [] },
          },
        ]),
      writeSummary: () => Promise.resolve(),
    },
    new AbortController(),
    diagnostics,
  );
  assert.equal(result.skipped, false);
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const operations = new Set(records.map((record) => record.operation));
  assert.equal(operations.has("action.run"), true);
  assert.equal(operations.has("action.config.read"), true);
  assert.equal(operations.has("action.event.read"), true);
  assert.equal(operations.has("action.diff.capture"), true);
  assert.equal(operations.has("action.goals.run"), true);
  assert.equal(operations.has("action.review.aggregate"), true);
  assert.equal(operations.has("action.summary.write"), true);
  assert.equal(operations.has("action.context.cleanup"), true);
  assert.equal(records.at(-1)?.outcome, "success");
});

test("redaction secrets include configured AI and MCP endpoints", () => {
  const secrets = indexInternals.reviewSecrets(config);
  assert.ok(secrets.includes(config.aiBaseUrl));
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
      `AI failed at ${config.aiBaseUrl}; MCP failed at ${config.mcpServers.security?.url}.`,
      secrets,
    ),
    "AI failed at [REDACTED]; MCP failed at [REDACTED].",
  );
  assert.equal(
    indexInternals.redact(`${config.aiBaseUrl}/mcp?signature=leaked`, [
      config.aiBaseUrl,
      `${config.aiBaseUrl}/mcp?signature=leaked`,
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
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "action",
    write: (line) => lines.push(line),
  });

  await assert.rejects(
    indexInternals.cleanupReviewArtifacts(
      { cleanup: () => Promise.reject(new Error("context cleanup failed")) },
      { cleanup: () => rm(temporaryWorkspace, { force: true, recursive: true }) },
      diagnostics,
    ),
    /context cleanup failed/u,
  );
  await assert.rejects(access(temporaryWorkspace));
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const cleanupFailure = records.find(
    (record) => record.operation === "action.context.cleanup" && record.outcome === "failure",
  );
  assert.ok(cleanupFailure);
  assert.equal(
    ((cleanupFailure.details as Record<string, unknown>).error as Record<string, unknown>).message,
    "context cleanup failed",
  );
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
    if (request.method === "POST" && request.url === "/graphql") {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString("utf8");
      });
      request.on("end", () => {
        const payload = JSON.parse(body) as { readonly query?: string };
        const connection = {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        };
        if (payload.query?.includes("AiPrReviewerReviews") === true) {
          response.end(
            JSON.stringify({
              data: { repository: { pullRequest: { reviews: connection } } },
            }),
          );
          return;
        }
        if (payload.query?.includes("AiPrReviewerThreads") === true) {
          response.end(
            JSON.stringify({
              data: { repository: { pullRequest: { reviewThreads: connection } } },
            }),
          );
          return;
        }
        response.statusCode = 400;
        response.end(JSON.stringify({ message: "unknown GraphQL query" }));
      });
      return;
    }
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
  const localApiUrl = `http://127.0.0.1:${address.port}`;
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
    createApi: (token) => new GitHubApi(token, localApiUrl, undefined, `${localApiUrl}/graphql`),
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
  assert.equal(requests.filter((request) => request.method === "GET").length, 4);
  assert.equal(requests.filter((request) => request.method === "POST").length, 2);
  assert.equal(
    requests.every((request) => request.authorization === "Bearer test-token"),
    true,
  );
  assert.equal(
    requests.some((request) => request.path === "/user"),
    true,
  );
  assert.equal(requests.filter((request) => request.path === "/graphql").length, 2);
  assert.equal(
    requests.some((request) => request.path?.includes("/reviews?") === true),
    false,
  );
  assert.equal(
    requests.some((request) => request.path?.includes("/pulls/9/comments?") === true),
    false,
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
    getReviewLifecycleSnapshot: () =>
      Promise.resolve({
        reviews: [
          {
            nodeId: "review-node-1",
            databaseId: 1,
            author: { login: "review-owner", type: "User" },
            body: marker,
            commitId: context.headSha,
            state: "COMMENTED",
            isMinimized: false,
          },
        ],
        threads: [],
      }),
  } as unknown as GitHubApi;
  const diagnosticLines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "action",
    write: (line) => diagnosticLines.push(line),
  });

  const result = await runAction(
    reader,
    [],
    {
      createApi: () => api,
      readEventContext: () => Promise.resolve(context),
      createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
      runGoals: () => {
        goalRuns += 1;
        return Promise.resolve([]);
      },
      writeSummary: () => Promise.resolve(),
    },
    new AbortController(),
    diagnostics,
  );

  assert.deepEqual(result, { skipped: true });
  assert.equal(goalRuns, 0);
  const records = diagnosticLines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  assert.equal(
    records.some((record) => record.operation === "action.run" && record.outcome === "skipped"),
    true,
  );
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

test("reconciles interactive lifecycle state before and after the current review", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const oldSha = "a".repeat(40);
  const findingReview: ReviewLifecycleReviewRecord = {
    nodeId: "finding-review-node",
    databaseId: 22,
    author: { login: "review-action", type: "User" },
    body: `<!-- ai-pr-reviewer:v3:${oldSha}:${"d".repeat(64)} -->\n## 🔎 AI review\n\nSee the inline comments for details.`,
    commitId: oldSha,
    state: "COMMENTED",
    submittedAt: "2026-08-31T00:00:00Z",
    isMinimized: false,
  };
  const cleanReview: ReviewLifecycleReviewRecord = {
    nodeId: "clean-review-node",
    databaseId: 21,
    author: { login: "review-action", type: "User" },
    body: `<!-- ai-pr-reviewer:v3:${oldSha}:${"e".repeat(64)} -->\n## ✨ Good job!\n\nNo actionable issues found.`,
    commitId: oldSha,
    state: "APPROVED",
    submittedAt: "2026-08-31T00:00:00Z",
    isMinimized: false,
  };
  const findingThread: ReviewLifecycleThreadRecord = {
    nodeId: "finding-thread-node",
    isResolved: true,
    isOutdated: true,
    path: "review.txt",
    line: 1,
    originalLine: 1,
    reviewId: findingReview.databaseId,
    reviewNodeId: findingReview.nodeId,
    comments: [
      {
        nodeId: "finding-comment-node",
        databaseId: 220,
        reviewId: findingReview.databaseId,
        reviewNodeId: findingReview.nodeId,
        author: { login: "review-action", type: "User" },
        body: "Old finding",
        commitId: oldSha,
        createdAt: "2026-08-31T00:00:00Z",
        updatedAt: "2026-08-31T00:00:00Z",
      },
    ],
  };
  const snapshot: ReviewLifecycleSnapshot = {
    reviews: [cleanReview, findingReview],
    threads: [findingThread],
  };
  const calls: string[] = [];
  const api = {
    ...emptyConversationApi("review-action"),
    getReviewLifecycleSnapshot: () => Promise.resolve(snapshot),
    getPullRequestHeadSha: () => Promise.resolve(context.headSha),
    updateSubmittedReview: (nodeId: string, body: string) => {
      calls.push(`update:${nodeId}:${body}`);
      return Promise.resolve();
    },
    dismissSubmittedReview: (nodeId: string, message: string) => {
      calls.push(`dismiss:${nodeId}:${message}`);
      return Promise.resolve();
    },
    updateReviewComment: () => Promise.resolve(),
    resolveReviewThread: () => Promise.resolve(),
    minimizeComment: (nodeId: string) => {
      calls.push(`minimize:${nodeId}`);
      return Promise.resolve();
    },
    createReview: () => {
      calls.push("create");
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
  assert.deepEqual(calls, [
    `dismiss:clean-review-node:Superseded by new changes at ${context.headSha}; this automated approval is no longer current.`,
    `update:clean-review-node:${staleReviewBody(cleanReview, context.headSha)}`,
    "create",
    "minimize:finding-review-node",
  ]);
});

test("keeps lifecycle mutations disabled in summary-only mode", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  let lifecycleReads = 0;
  let lifecycleMutations = 0;
  const api = {
    ...emptyConversationApi("review-action"),
    getReviewLifecycleSnapshot: () => {
      lifecycleReads += 1;
      return Promise.resolve({ reviews: [], threads: [] });
    },
    updateSubmittedReview: () => {
      lifecycleMutations += 1;
      return Promise.resolve();
    },
    dismissSubmittedReview: () => {
      lifecycleMutations += 1;
      return Promise.resolve();
    },
    updateReviewComment: () => {
      lifecycleMutations += 1;
      return Promise.resolve();
    },
    resolveReviewThread: () => {
      lifecycleMutations += 1;
      return Promise.resolve();
    },
    minimizeComment: () => {
      lifecycleMutations += 1;
      return Promise.resolve();
    },
  } as unknown as GitHubApi;
  const result = await runAction(actionReader({ "interact-with-pr": "false" }), [], {
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
  assert.equal(lifecycleReads, 1);
  assert.equal(lifecycleMutations, 0);
});

test("publishes 25 inline findings and writes overflow to the run summary", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const files = Array.from({ length: 26 }, (_, index) => ({
    path: `src/change-${String(index).padStart(2, "0")}.ts`,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -0,0 +1 @@\n+change",
    addedLines: new Set([1]),
  }));
  let request: PullRequestReviewRequest | undefined;
  let summary = "";
  let summaryWrites = 0;
  const publicationOrder: string[] = [];
  const api = {
    ...emptyConversationApi("review-action"),
    createReview: (_context: PullRequestContext, reviewRequest: PullRequestReviewRequest) => {
      publicationOrder.push("review");
      request = reviewRequest;
      return Promise.resolve();
    },
  } as unknown as GitHubApi;

  const result = await runAction(actionReader(), [], {
    createApi: () => api,
    readEventContext: () => Promise.resolve(context),
    createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
    readFiles: () => Promise.resolve(files),
    runGoals: () =>
      Promise.resolve([
        {
          prompt: "correctness",
          status: "completed",
          submission: {
            summary: "overflow",
            findings: files.map((file, index) => ({
              title: `Finding ${String(index).padStart(2, "0")}`,
              severity: "MODERATE" as const,
              body: `Evidence ${index}`,
              path: file.path,
              line: 1,
            })),
          },
        },
      ]),
    writeSummary: (summaryContext, review, goals) => {
      publicationOrder.push("summary");
      summaryWrites += 1;
      summary = buildRunSummary(summaryContext, review, goals);
      return Promise.resolve();
    },
  });

  assert.equal(result.review?.inlineFindings.length, 25);
  assert.equal(result.review?.omittedFindings.length, 1);
  assert.equal(request?.comments.length, 25);
  assert.doesNotMatch(request?.body ?? "", /Finding 25|### Findings/u);
  assert.equal(summaryWrites, 1);
  assert.deepEqual(publicationOrder, ["summary", "review"]);
  assert.match(summary, /Finding 25/u);
});
