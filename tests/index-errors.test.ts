import {
  CancellationError,
  type GitHubApi,
  actionReader,
  assert,
  buildRunSummary,
  cleanWorkspace,
  emptyConversationApi,
  indexInternals,
  join,
  main,
  mkdtemp,
  rm,
  runAction,
  test,
  tmpdir,
  type GoalResult,
  type PullRequestContext,
  useWorkspace,
} from "./index-test-helpers.js";

test("cancellation prevents new summaries and pull request writes", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);

  for (const interactWithPullRequest of [true, false]) {
    const controller = new AbortController();
    const reason = new CancellationError("SIGTERM");
    let summaries = 0;
    let reviews = 0;
    const api = {
      ...emptyConversationApi(),
      getPullRequestFiles: () => Promise.resolve([]),
      createReview: () => {
        reviews += 1;
        return Promise.resolve();
      },
    } as unknown as GitHubApi;
    await assert.rejects(
      runAction(
        actionReader({ "interact-with-pr": String(interactWithPullRequest) }),
        [],
        {
          createApi: () => api,
          readEventContext: () => Promise.resolve(context),
          createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
          runGoals: (
            _context,
            _files,
            _conversation,
            _config,
            _contextFiles,
            _cwd,
            _queryAgent,
            receivedController,
          ) => {
            assert.equal(receivedController, controller);
            controller.abort(reason);
            return Promise.resolve([
              {
                prompt: "correctness",
                status: "completed",
                submission: { summary: "clean", findings: [] },
              },
            ]);
          },
          writeSummary: () => {
            summaries += 1;
            return Promise.resolve();
          },
        },
        controller,
      ),
      (error: unknown) => error === reason,
    );
    assert.equal(summaries, 0);
    assert.equal(reviews, 0);
  }
});

test("rejects mismatched event URL targets", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const api = emptyConversationApi() as unknown as GitHubApi;

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
        createApi: () => api,
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
    ...emptyConversationApi(),
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
      actionReader({
        "interact-with-pr": "false",
        "review-prompts": JSON.stringify([{ prompt: "one" }, { prompt: "two" }]),
      }),
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
  const summaries: string[] = [];
  const api = {
    ...emptyConversationApi(),
    getPullRequestRefs: () =>
      Promise.resolve({ headSha: context.headSha, baseSha: context.baseSha }),
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
        Promise.resolve([
          {
            prompt: "correctness",
            status: "failed",
            error: "failed",
            tokenUsage: {
              complete: true,
              models: [
                {
                  model: "review-model",
                  inputTokens: 4,
                  outputTokens: 3,
                  cacheReadInputTokens: 2,
                  cacheCreationInputTokens: 1,
                },
              ],
            },
          },
        ]),
      writeSummary: (summaryContext, review, goals) => {
        summaries.push(buildRunSummary(summaryContext, review, goals));
        return Promise.resolve();
      },
    }),
    /no pull request review was posted/u,
  );
  assert.equal(reviews, 0);
  assert.equal(summaries.length, 1);
  assert.match(summaries[0] ?? "", /AI review failed/u);
  assert.match(summaries[0] ?? "", /📊 Token usage · 10 tokens/u);
});

test("workspace validation rejects a different HEAD", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  await assert.rejects(
    indexInternals.assertWorkspace({ ...context, headSha: "f".repeat(40) }, workspace),
    /does not match pull request head/u,
  );
});

test("main reports input failures without throwing secrets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-index-main-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const previousInputs = Object.entries(process.env).filter(([key]) => key.startsWith("INPUT_"));
  const previousEventPath = process.env.GITHUB_EVENT_PATH;
  const previousExitCode = process.exitCode;
  const output: string[] = [];
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("INPUT_")) Reflect.deleteProperty(process.env, key);
    }
    for (const [key, value] of previousInputs) process.env[key] = value;
    if (previousEventPath === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = previousEventPath;
    process.exitCode = previousExitCode;
  });

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("INPUT_")) Reflect.deleteProperty(process.env, key);
  }
  Object.assign(process.env, {
    "INPUT_GITHUB-PAT": "github-test-token",
    "INPUT_AI-BASE-URL": "https://ai.example.test",
    "INPUT_AI-SECRET": "ai-test-secret",
    INPUT_MODEL: "test-model",
    "INPUT_REVIEW-PROMPTS": JSON.stringify([{ prompt: "correctness" }]),
    INPUT_TEST_SECRET: "environment-secret",
  });
  process.env.GITHUB_EVENT_PATH = join(root, "environment-secret-missing-event.json");
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    output.push(chunk.toString());
    return true;
  });

  await main();

  const failureOutput = output.join("");
  assert.equal(process.exitCode, 1);
  assert.doesNotMatch(failureOutput, /environment-secret/u);
  assert.match(failureOutput, /\[REDACTED\]-missing-event\.json/u);
});

test("main treats cancellation as a clean stop", async (t) => {
  const output: string[] = [];
  const previousExitCode = process.exitCode;
  t.after(() => {
    process.exitCode = previousExitCode;
  });
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    output.push(chunk.toString());
    return true;
  });
  const controller = new AbortController();
  controller.abort(new CancellationError("SIGTERM"));
  await main(controller);
  assert.match(
    output.join(""),
    /Pull request review cancelled; no new review or run summary will be published\./u,
  );
  assert.doesNotMatch(output.join(""), /::error::/u);
  assert.equal(process.exitCode, previousExitCode);
});
