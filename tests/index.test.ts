import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

import { indexInternals, main, runAction } from "../src/index.js";
import { buildRunSummary, reviewMarker } from "../src/lib/aggregate.js";
import { GitHubApi, GitHubApiError } from "../src/lib/github-api.js";
import { readReviewConfig, type InputReader } from "../src/lib/input.js";
import type {
  GoalResult,
  PullRequestContext,
  PullRequestReviewRequest,
  ReviewConfig,
} from "../src/lib/types.js";

const execFileAsync = promisify(execFile);

function actionReader(overrides: Readonly<Record<string, string>> = {}): InputReader {
  const values: Readonly<Record<string, string>> = {
    "github-pat": "test-token",
    "ai-base-url": "https://ai.example.test",
    "ai-secret": "test-ai-secret",
    model: "review-model",
    "review-prompts": "correctness",
    ...overrides,
  };
  return { get: (name) => values[name] ?? "" };
}

async function cleanWorkspace(t: TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-index-clean-"));
  t.after(() => rm(workspace, { force: true, recursive: true }));
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: workspace });
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
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  });
  const headSha = stdout.trim();
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 9,
    headSha,
    baseSha: headSha,
    baseRef: "main",
    title: "Action flow",
    htmlUrl: "https://github.com/owner/repository/pull/9",
  };
  return { context, workspace };
}

function useWorkspace(t: TestContext, path: string): void {
  const previous = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = path;
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previous;
  });
}

const config: ReviewConfig = {
  githubToken: "github-secret",
  aiBaseUrl:
    "https://ai.example.test/signed?api-version=2023-06-01&token=ai-url%2Fsecret&subscription-key=subscription-secret&apiKey=camel-api-secret&accessToken=camel-access-secret",
  aiSecret: "ai-secret",
  aiAuthMode: "api-key",
  model: "review-model",
  reviewPrompts: ["security"],
  parallelCount: 1,
  maxTurns: 2,
  autoApprove: false,
  interactWithPullRequest: true,
  mcpServers: {
    security: {
      type: "http",
      url: "https://mcp.example.test/review?tenant=public-tenant&monkey=public-monkey&signature=mcp-url%2Fsecret&key=bare-key-secret&clientSecret=camel-client-secret",
      headers: {
        Authorization: "Bearer mcp-header-secret",
        "Proxy-Authorization": "Basic proxy-credentials",
        "X-Label": "public value",
      },
    },
  },
};

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
  const [goal] = indexInternals.redactGoals(
    [
      {
        prompt: "security",
        status: "completed",
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
    ],
    ["private-token"],
  );

  assert.equal(goal?.submission?.findings[0]?.body, "The value [REDACTED] is exposed.");
  assert.equal(
    goal?.submission?.findings[0]?.agentPrompt,
    "Impact: [REDACTED] is exposed.\nRequested fix: Remove [REDACTED].",
  );
  assert.equal(
    goal?.submission?.findings[1]?.agentPrompt,
    "Impact: The value is stale.\nRequested fix: Return the current value.",
  );
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
    if (request.url?.includes("/files?")) {
      response.end(
        JSON.stringify([
          {
            filename: "review.txt",
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
    response.end(
      JSON.stringify({
        title: "External change",
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
    "review-prompts": "correctness",
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
    runGoals: (context, files, _config, cwd) => {
      goalRuns += 1;
      assert.equal(context.repository, "target/project");
      assert.equal(files.length, 1);
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
  assert.equal(requests.length, 5);
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
    false,
  );
  assert.equal(
    requests.some((request) => request.path?.endsWith("/reviews") === true),
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
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: context.headSha, baseSha: context.baseSha }),
    getAuthenticatedUserLogin: () => Promise.resolve("Review-Owner"),
    listReviews: () =>
      Promise.resolve([
        {
          authorLogin: "review-owner",
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

test("falls back from a rejected approval to a comment review", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const requests: PullRequestReviewRequest[] = [];
  const api = {
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: context.headSha, baseSha: context.baseSha }),
    getAuthenticatedUserLogin: () => Promise.resolve("review-owner"),
    listReviews: () => Promise.resolve([]),
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

test("propagates non-approval review failures", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const api = {
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: context.headSha, baseSha: context.baseSha }),
    getAuthenticatedUserLogin: () => Promise.resolve("review-owner"),
    listReviews: () => Promise.resolve([]),
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

test("fails closed for stale refs and mismatched event URL targets", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const staleApi = {
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: "f".repeat(40), baseSha: context.baseSha }),
  } as unknown as GitHubApi;
  await assert.rejects(
    runAction(actionReader(), [], {
      createApi: () => staleApi,
      readEventContext: () => Promise.resolve(context),
      createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
      runGoals: () => Promise.resolve([]),
      writeSummary: () => Promise.resolve(),
    }),
    /refs changed during review/u,
  );

  const previousServer = process.env.GITHUB_SERVER_URL;
  process.env.GITHUB_SERVER_URL = "https://github.com";
  t.after(() => {
    if (previousServer === undefined) delete process.env.GITHUB_SERVER_URL;
    else process.env.GITHUB_SERVER_URL = previousServer;
  });
  await assert.rejects(
    runAction(
      actionReader({ "pull-request-url": "https://github.com/other/repository/pull/10" }),
      [],
      {
        createApi: () => staleApi,
        readEventContext: () => Promise.resolve(context),
        createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
        runGoals: () => Promise.resolve([]),
        writeSummary: () => Promise.resolve(),
      },
    ),
    /must identify the pull request that triggered/u,
  );
});

test("writes failed and partial summary-only results before reporting failure", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const api = {
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: context.headSha, baseSha: context.baseSha }),
    getPullRequestFiles: () => Promise.resolve([]),
  } as unknown as GitHubApi;
  const summaries: string[] = [];
  const dependencies = (goals: readonly GoalResult[]) => ({
    createApi: () => api,
    readEventContext: () => Promise.resolve(context),
    createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
    runGoals: () => Promise.resolve(goals),
    writeSummary: (
      summaryContext: PullRequestContext,
      review: NonNullable<Awaited<ReturnType<typeof runAction>>["review"]>,
      completedGoals: readonly GoalResult[],
    ) => {
      summaries.push(buildRunSummary(summaryContext, review, completedGoals));
      return Promise.resolve();
    },
  });

  await assert.rejects(
    runAction(
      actionReader({ "interact-with-pr": "false" }),
      [],
      dependencies([{ prompt: "correctness", status: "failed", error: "provider failed" }]),
    ),
    /All review goals failed/u,
  );
  await assert.rejects(
    runAction(
      actionReader({ "interact-with-pr": "false", "review-prompts": "one\ntwo" }),
      [],
      dependencies([
        { prompt: "one", status: "completed", submission: { summary: "clean", findings: [] } },
        { prompt: "two", status: "failed", error: "provider failed" },
      ]),
    ),
    /partial result/u,
  );
  assert.equal(summaries.length, 2);
  assert.match(summaries[0] ?? "", /AI review failed/u);
  assert.match(summaries[1] ?? "", /AI review incomplete/u);
});

test("does not post an interactive review when every goal fails", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  let reviews = 0;
  const api = {
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: context.headSha, baseSha: context.baseSha }),
    getAuthenticatedUserLogin: () => Promise.resolve("review-owner"),
    listReviews: () => Promise.resolve([]),
    getPullRequestFiles: () => Promise.resolve([]),
    createReview: () => {
      reviews += 1;
      return Promise.resolve();
    },
  } as unknown as GitHubApi;
  await assert.rejects(
    runAction(actionReader(), [], {
      createApi: () => api,
      readEventContext: () => Promise.resolve(context),
      createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
      runGoals: () =>
        Promise.resolve([{ prompt: "correctness", status: "failed", error: "failed" }]),
      writeSummary: () => Promise.resolve(),
    }),
    /no pull request review was posted/u,
  );
  assert.equal(reviews, 0);
});

test("workspace validation rejects a different HEAD", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  await assert.rejects(
    indexInternals.assertWorkspace({ ...context, headSha: "f".repeat(40) }, workspace),
    /does not match pull request head/u,
  );
});

test("main reports input failures without throwing secrets", async () => {
  const previousExitCode = process.exitCode;
  const previousSecret = process.env.INPUT_TEST_SECRET;
  process.env.INPUT_TEST_SECRET = "environment-secret";
  try {
    await main();
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
    if (previousSecret === undefined) delete process.env.INPUT_TEST_SECRET;
    else process.env.INPUT_TEST_SECRET = previousSecret;
  }
});
