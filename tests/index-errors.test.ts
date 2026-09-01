/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/prefer-promise-reject-errors */

import {
  CancellationError,
  GitHubApiError,
  GitHubApi,
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
import { DiagnosticLogger, diagnosticsInternals } from "../src/lib/diagnostics.js";
import type { ContextFileArtifact } from "../src/lib/context-files.js";

test("diagnostic logger emits correlated, redacted operation records", () => {
  const lines: string[] = [];
  let nextId = 0;
  let now = new Date("2026-09-01T00:00:00.000Z");
  const logger = new DiagnosticLogger({
    component: "github",
    context: { run_id: "42" },
    secrets: ["gh-secret", "short"],
    write: (line) => lines.push(line),
    now: () => now,
    id: () => `operation-${++nextId}`,
  });
  const descriptor = {
    phase: "conversation",
    operation: "rest.pull-request.context",
    purpose: "capture pull request metadata",
  } as const;
  const started = logger.start(descriptor, {
    url: "https://api.example.test/repos/owner/repo?signature=gh-secret",
    authorization: "gh-secret",
    request_body: "private body",
    response_headers: {
      "x-github-request-id": "request-1",
      "x-ratelimit-remaining": "4999",
      "set-cookie": "private-cookie",
    },
  });
  now = new Date("2026-09-01T00:00:00.125Z");
  started.success({ status: 200, token: "gh-secret", reason: "short" });
  const skipped = logger.start({ ...descriptor, operation: "rest.issue.lookup" });
  skipped.skipped({ status: 404, reason: "optional issue is absent" });
  const cancelled = logger.start({ ...descriptor, operation: "rest.cancelled" });
  cancelled.cancelled(new CancellationError("SIGTERM"));
  const failed = logger.start({ ...descriptor, operation: "rest.failed" });
  const cause = new Error("upstream short failure");
  failed.failure(new Error("request failed", { cause }), { status: 503 });

  assert.equal(lines.length, 8);
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const first = records[0];
  assert.ok(first);
  assert.equal(first.schema_version, 1);
  assert.equal(first.event, "operation.started");
  assert.equal(first.operation_id, "operation-1");
  assert.equal(first.run_id, "42");
  assert.equal(
    (first.details as Record<string, unknown>).url,
    "https://api.example.test/repos/owner/repo",
  );
  assert.equal((first.details as Record<string, unknown>).authorization, "[OMITTED]");
  assert.equal((first.details as Record<string, unknown>).request_body, "[OMITTED]");
  assert.deepEqual((first.details as Record<string, unknown>).response_headers, {
    "x-github-request-id": "request-1",
    "x-ratelimit-remaining": "4999",
  });
  assert.equal((records[1]?.details as Record<string, unknown>).token, "[OMITTED]");
  assert.equal(records[3]?.event, "operation.skipped");
  assert.equal(records[3]?.outcome, "skipped");
  assert.equal(records[5]?.event, "operation.cancelled");
  assert.equal(records[5]?.outcome, "cancelled");
  assert.equal(records[7]?.outcome, "failure");
  assert.equal(JSON.stringify(records).includes("gh-secret"), false);
  assert.equal(JSON.stringify(records).includes("private body"), false);
  assert.equal(JSON.stringify(records).includes("signature="), false);
});

test("diagnostic serialization bounds complex values and preserves causes", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const deep: Record<string, unknown> = {};
  let current = deep;
  for (let index = 0; index < 8; index += 1) {
    const child: Record<string, unknown> = {};
    current.child = child;
    current = child;
  }
  const projected = JSON.parse(
    diagnosticsInternals.serialized(
      {
        secret: "hidden",
        query: "private query",
        body: "private body",
        headers: { authorization: "hidden-header" },
        status_text: "Forbidden",
        content_length: 12,
        response_headers: "not a header map",
        circular,
        deep,
        values: ["visible", 1n, () => undefined, Symbol("value")],
      },
      ["hidden"],
    ),
  ) as Record<string, unknown>;
  assert.equal(projected.secret, "[OMITTED]");
  assert.equal(projected.query, "[OMITTED]");
  assert.equal(projected.body, "[OMITTED]");
  assert.equal(projected.headers, "[OMITTED]");
  assert.equal(projected.status_text, "Forbidden");
  assert.equal(projected.content_length, 12);
  assert.equal(projected.response_headers, "[OMITTED]");
  assert.equal((projected.circular as Record<string, unknown>).self, "[CIRCULAR]");
  assert.equal((projected.deep as Record<string, unknown>).child !== undefined, true);
  assert.deepEqual(projected.values, [
    "visible",
    "[BIGINT]",
    "[UNSERIALIZABLE]",
    "[UNSERIALIZABLE]",
  ]);

  let error: Error = new Error("level-0");
  for (let index = 1; index <= 7; index += 1) error = new Error(`level-${index}`, { cause: error });
  const errorRecord = diagnosticsInternals.errorRecord(error, []);
  assert.equal(typeof errorRecord, "object");
  assert.equal(JSON.stringify(errorRecord).includes("CAUSE_DEPTH_EXCEEDED"), true);
  const diagnosticError = new Error("response body must not be logged");
  Object.assign(diagnosticError, { diagnosticMessage: "safe status" });
  const safeRecord = diagnosticsInternals.errorRecord(diagnosticError, []);
  assert.equal((safeRecord as Record<string, unknown>).message, "safe status");
  assert.equal(JSON.stringify(safeRecord).includes("response body must not be logged"), false);
  const apiError = new GitHubApiError(403, "response body must not be logged", {
    operation: "rest.user.current",
    requestId: "request-1",
  });
  const apiRecord = diagnosticsInternals.errorRecord(apiError, []);
  assert.equal((apiRecord as Record<string, unknown>).message, "GitHub API request failed (403).");
  assert.equal(JSON.stringify(apiRecord).includes("response body must not be logged"), false);
  const multilineApiError = new GitHubApiError(403, "safe line\nsecret body", {
    operation: "rest.user.current",
  });
  const multilineRecord = diagnosticsInternals.errorRecord(multilineApiError, []);
  assert.equal(JSON.stringify(multilineRecord).includes("secret body"), false);

  const many: Record<string, string> = {};
  for (let index = 0; index < 200; index += 1) many[`field-${index}`] = "x".repeat(2_048);
  const bounded = JSON.parse(diagnosticsInternals.serialized(many, [])) as Record<string, unknown>;
  assert.equal(JSON.stringify(bounded).length <= 8_000, true);
  assert.equal(
    bounded.event === "diagnostic.truncated" ||
      (bounded.details as Record<string, unknown> | undefined)?.truncated === true,
    true,
  );
  const correlated = JSON.parse(
    diagnosticsInternals.serialized(
      {
        component: "github",
        phase: "request",
        operation: "rest.large",
        operation_id: "operation-1",
        outcome: "failure",
        details: { values: Array.from({ length: 20 }, () => "x".repeat(2_048)) },
      },
      [],
    ),
  ) as Record<string, unknown>;
  assert.equal(correlated.operation, "rest.large");
  assert.equal(correlated.operation_id, "operation-1");
  assert.equal(correlated.outcome, "failure");
  assert.equal(
    diagnosticsInternals.stripUrlQuery("https://example.test/path?token=hidden"),
    "https://example.test/path",
  );
  assert.equal(
    diagnosticsInternals.stripEmbeddedUrlQueries(
      "fetch https://example.test/path?token=hidden now",
    ),
    "fetch https://example.test/path now",
  );
  const boundary = JSON.parse(
    diagnosticsInternals.serialized(
      { value: `${"x".repeat(2_040)}boundary-secret${"y".repeat(32)}` },
      ["boundary-secret"],
    ),
  ) as Record<string, unknown>;
  assert.equal(JSON.stringify(boundary).includes("boundary-secret"), false);
  assert.equal(diagnosticsInternals.isCancellation(new Error("request aborted")), true);
  assert.equal(diagnosticsInternals.isCancellation(new Error("other")), false);
});

test("diagnostic writer failures cannot change the action result", () => {
  const logger = new DiagnosticLogger({
    component: "action",
    write: () => {
      throw new Error("writer unavailable");
    },
  });
  assert.doesNotThrow(() => {
    const span = logger.start({ phase: "action", operation: "run", purpose: "run action" });
    span.failure(new Error("failure"));
  });
});

test("diagnostic metadata failures cannot change the action result", async () => {
  const lines: string[] = [];
  const context = {} as Record<string, unknown>;
  Object.defineProperty(context, "run_id", {
    enumerable: true,
    get: () => {
      throw new Error("context unavailable");
    },
  });
  let executed = false;
  const logger = new DiagnosticLogger({
    component: "action",
    context,
    write: (line) => lines.push(line),
  });
  await assert.doesNotReject(
    logger.withSpan({ phase: "action", operation: "run", purpose: "run action" }, () => {
      executed = true;
    }),
  );
  assert.equal(executed, true);
  assert.equal(lines.length, 2);
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  assert.equal(records[0]?.operation_id, records[1]?.operation_id);
  assert.equal(records[0]?.run_id, "[UNSERIALIZABLE]");
});

test("diagnostic id failures cannot change the operation result", async () => {
  const lines: string[] = [];
  let executed = false;
  const logger = new DiagnosticLogger({
    component: "action",
    id: () => {
      throw new Error("id provider unavailable");
    },
    write: (line) => lines.push(line),
  });
  await assert.doesNotReject(
    logger.withSpan({ phase: "action", operation: "run", purpose: "run action" }, () => {
      executed = true;
    }),
  );
  assert.equal(executed, true);
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const started = records.find((record) => record.event === "operation.started");
  const terminal = records.find((record) => record.event === "operation.succeeded");
  assert.ok(started);
  assert.ok(terminal);
  assert.equal(started.operation_id, terminal.operation_id);
  assert.match(String(started.operation_id), /^fallback-\d+$/u);
});

test("keeps immutable body-read failures redacted through action lifecycle spans", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const failures: readonly [string, unknown][] = [
    [
      "action-lifecycle-frozen-sentinel",
      Object.freeze(new Error("action-lifecycle-frozen-sentinel")),
    ],
    ["action-lifecycle-primitive-sentinel", "action-lifecycle-primitive-sentinel"],
  ];
  for (const [index, [sentinel, bodyError]] of failures.entries()) {
    globalThis.fetch = async () =>
      ({
        ok: true,
        status: 502,
        headers: new Headers({ "x-github-request-id": `action-lifecycle-${index}` }),
        text: async () => Promise.reject(bodyError),
      }) as unknown as Response;
    const lines: string[] = [];
    const diagnostics = new DiagnosticLogger({
      component: "action",
      write: (line) => lines.push(line),
    });
    const api = new GitHubApi(
      "test-token",
      "https://api.example.test",
      undefined,
      undefined,
      diagnostics,
    );
    await assert.rejects(
      runAction(
        actionReader(),
        [],
        {
          createApi: () => api,
          readEventContext: () => Promise.resolve(context),
          createWorkspace: () => Promise.reject(new Error("workspace should not be created")),
          prepareContextFiles: () =>
            Promise.resolve({
              filesByGoal: [[]],
              identity: [],
              cleanup: () => Promise.resolve(),
            } as unknown as ContextFileArtifact),
          readFiles: () => Promise.resolve([]),
          runGoals: () => Promise.resolve([]),
          writeSummary: () => Promise.resolve(),
        },
        new AbortController(),
        diagnostics,
      ),
      (error: unknown) => error === bodyError,
    );
    const records = lines.map(
      (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
    );
    const terminal = records.find(
      (record) => record.operation === "action.run" && record.event === "operation.finished",
    );
    assert.ok(terminal);
    assert.equal(
      ((terminal.details as Record<string, unknown>).error as Record<string, unknown>).message,
      "GitHub REST response body read failed.",
    );
    assert.equal(JSON.stringify(records).includes(sentinel), false);
  }
});

test("diagnostic spans preserve non-coercible rejected values", async () => {
  const lines: string[] = [];
  const logger = new DiagnosticLogger({ component: "action", write: (line) => lines.push(line) });
  const reason = Object.create(null) as object;
  await assert.rejects(
    logger.withSpan(
      { phase: "action", operation: "non-coercible", purpose: "preserve a rejection" },
      () => Promise.reject(reason),
    ),
    (error: unknown) => error === reason,
  );
  assert.equal(lines.length, 2);
  assert.equal(JSON.stringify(lines).includes("UNSERIALIZABLE"), true);
});

test("cancellation prevents new summaries and pull request writes", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);

  for (const interactWithPullRequest of [true, false]) {
    const controller = new AbortController();
    const reason = new CancellationError("SIGTERM");
    const lines: string[] = [];
    const diagnostics = new DiagnosticLogger({
      component: "action",
      context: { run_id: `cancel-${String(interactWithPullRequest)}` },
      write: (line) => lines.push(line),
    });
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
        diagnostics,
      ),
      (error: unknown) => error === reason,
    );
    assert.equal(summaries, 0);
    assert.equal(reviews, 0);
    const records = lines.map(
      (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
    );
    const terminal = records.find(
      (record) => record.operation === "action.run" && record.outcome === "cancelled",
    );
    assert.ok(terminal);
    assert.equal(terminal.run_id, `cancel-${String(interactWithPullRequest)}`);
  }
});

test("correlates full action cleanup failures with the parent failure", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "action",
    context: { run_id: "cleanup-failure" },
    write: (line) => lines.push(line),
  });
  const api = {
    ...emptyConversationApi(),
    getPullRequestFiles: () => Promise.resolve([]),
  } as unknown as GitHubApi;
  await assert.rejects(
    runAction(
      actionReader({ "interact-with-pr": "false" }),
      [],
      {
        createApi: () => api,
        readEventContext: () => Promise.resolve(context),
        createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
        readFiles: () => Promise.resolve([]),
        prepareContextFiles: () =>
          Promise.resolve({
            filesByGoal: [[]],
            identity: [],
            cleanup: () => Promise.reject(new Error("context cleanup failed")),
          } as unknown as ContextFileArtifact),
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
    ),
    /context cleanup failed/u,
  );
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const cleanup = records.find(
    (record) => record.operation === "action.context.cleanup" && record.outcome === "failure",
  );
  const parent = records.find(
    (record) => record.operation === "action.run" && record.outcome === "failure",
  );
  assert.ok(cleanup);
  assert.ok(parent);
  assert.equal(cleanup.run_id, parent.run_id);
  assert.equal(
    ((parent.details as Record<string, unknown>).error as Record<string, unknown>).message,
    "context cleanup failed",
  );
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
