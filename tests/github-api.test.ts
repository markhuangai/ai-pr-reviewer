/* eslint-disable max-lines, @typescript-eslint/require-await, @typescript-eslint/prefer-promise-reject-errors, @typescript-eslint/only-throw-error */

import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import test from "node:test";

import { CancellationError } from "../src/lib/bootstrap/cancellation.js";
import { GitHubApi, GitHubApiError, githubApiInternals } from "../src/lib/github-api.js";
import { DiagnosticLogger } from "../src/lib/diagnostics.js";
import {
  discoverLinkedIssueNumbers,
  issueSnapshot,
  reviewBriefingDigest,
} from "../src/lib/review-evidence.js";
import type {
  PullRequestContext,
  PullRequestLocator,
  PullRequestReviewRequest,
} from "../src/lib/types.js";

test("discovers same-repository issue references while ignoring code and other repositories", () => {
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 10,
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    baseRef: "main",
    title: "Linked context",
    body: [
      "Fixes #12 and owner/repository#13.",
      "See https://github.com/owner/repository/issues/14.",
      "Ignore owner/other#15 and https://github.com/other/repository/issues/16.",
      "```text\n#17 owner/repository#18\n``` and `#19`.",
    ].join("\n"),
    htmlUrl: "https://github.com/owner/repository/pull/10",
  };
  assert.deepEqual(discoverLinkedIssueNumbers(context), {
    numbers: [12, 13, 14],
    truncated: false,
  });
  assert.deepEqual(
    discoverLinkedIssueNumbers({
      ...context,
      body: "<!-- Example: fixes #99 -->\nFixes #12",
    }),
    { numbers: [12], truncated: false },
  );
  assert.deepEqual(
    discoverLinkedIssueNumbers({
      ...context,
      body: "````\n#17\n```\n#18\n````\nFixes #12",
    }),
    { numbers: [12], truncated: false },
  );
  assert.deepEqual(
    discoverLinkedIssueNumbers({
      ...context,
      body: "~~~~\n#19\n~~~\n#20\n~~~~\nFixes #12",
    }),
    { numbers: [12], truncated: false },
  );
  assert.deepEqual(
    discoverLinkedIssueNumbers({
      ...context,
      body: "Use ``fixes #17`` as an example. Fixes #12",
    }),
    { numbers: [12], truncated: false },
  );
  assert.deepEqual(
    discoverLinkedIssueNumbers({
      ...context,
      body: "`fixes\n#17`\nFixes #12",
    }),
    { numbers: [12], truncated: false },
  );
  assert.deepEqual(
    discoverLinkedIssueNumbers({
      ...context,
      body: "    fixes #17\n\t#18\nFixes #12",
    }),
    { numbers: [12], truncated: false },
  );
});

test("handles empty briefing inputs and malformed linked issue payloads", () => {
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 1,
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    baseRef: "main",
    title: "No body",
    htmlUrl: "https://github.com/owner/repository/pull/1",
  };
  assert.deepEqual(discoverLinkedIssueNumbers(context), { numbers: [], truncated: false });
  const empty = { linkedIssues: [], linkedIssueReferencesTruncated: false } as const;
  assert.equal(reviewBriefingDigest(context, empty), "");
  assert.match(
    reviewBriefingDigest(
      { ...context, body: "context" },
      {
        linkedIssues: [],
        linkedIssueReferencesTruncated: true,
      },
    ),
    /^[0-9a-f]{64}$/u,
  );
  assert.throws(
    () => issueSnapshot(2, { title: "missing body", state: "open", html_url: "" }),
    /invalid linked issue #2/u,
  );
  assert.deepEqual(
    discoverLinkedIssueNumbers({
      ...context,
      body: "#12 #12 #0 https://github.com/owner/repository/not-an-issue/3.",
    }),
    { numbers: [12], truncated: false },
  );
  assert.deepEqual(discoverLinkedIssueNumbers({ ...context, body: "```\n#12\n#13" }), {
    numbers: [],
    truncated: false,
  });
});

test("does not treat file headers as added lines", () => {
  const lines = githubApiInternals.parseAddedLines(
    "--- a/file.ts\n+++ b/file.ts\n@@ -0,0 +1 @@\n+new",
  );
  assert.deepEqual([...lines], [1]);
});

test("counts added lines whose content starts with plus signs", () => {
  const lines = githubApiInternals.parseAddedLines("@@ -0,0 +1 @@\n+++counter");
  assert.deepEqual([...lines], [1]);
});

test("detects server-truncated patches from GitHub change counts", () => {
  const complete = {
    path: "src/change.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: "@@ -1 +1 @@\n-old\n+new",
    addedLines: new Set([1]),
  };
  assert.deepEqual(githubApiInternals.parsePatchCounts(complete.patch), {
    additions: 1,
    deletions: 1,
    complete: true,
  });
  assert.equal(githubApiInternals.isPatchComplete(complete), true);
  assert.equal(
    githubApiInternals.isPatchComplete({
      ...complete,
      additions: 2,
      changes: 3,
    }),
    false,
  );
  assert.equal(
    githubApiInternals.isPatchComplete({
      ...complete,
      patch: "@@ -1,2 +1,2 @@\n-old\n+new",
    }),
    false,
  );
  assert.equal(
    githubApiInternals.isPatchComplete({
      path: "renamed.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
      changes: 0,
      addedLines: new Set(),
    }),
    true,
  );
  assert.equal(
    githubApiInternals.isPatchComplete({
      path: ".gitkeep",
      status: "added",
      additions: 0,
      deletions: 0,
      changes: 0,
      addedLines: new Set(),
    }),
    true,
  );
  assert.equal(
    githubApiInternals.isPatchComplete({
      path: "image.png",
      status: "modified",
      additions: 0,
      deletions: 0,
      changes: 0,
      addedLines: new Set(),
    }),
    false,
  );
});

test("extracts the next API page from a GitHub Link header", () => {
  assert.equal(
    githubApiInternals.nextPagePath(
      '<https://api.github.com/repos/owner/repo/pulls/1/files?page=2>; rel="next", <https://api.github.com/repos/owner/repo/pulls/1/files?page=4>; rel="last"',
      "https://api.github.com",
    ),
    "/repos/owner/repo/pulls/1/files?page=2",
  );
  assert.equal(githubApiInternals.nextPagePath(null, "https://api.github.com"), undefined);
});

test("reads review authors without accepting malformed identities", () => {
  assert.equal(githubApiInternals.readLogin({ login: "review-owner" }), "review-owner");
  assert.equal(githubApiInternals.readLogin({ login: "" }), undefined);
  assert.equal(githubApiInternals.readLogin({}), undefined);
});

test("preserves structured GitHub validation errors", () => {
  assert.equal(
    githubApiInternals.errorDetails(
      { message: "Validation Failed", errors: [{ message: "Reviews may not be approved" }] },
      "Unprocessable Entity",
    ),
    "Validation Failed; Reviews may not be approved",
  );
  assert.equal(githubApiInternals.errorDetails({}, "Unprocessable Entity"), "Unprocessable Entity");
});

test("reads the live pull request head SHA", () => {
  assert.equal(
    githubApiInternals.readHeadSha({ head: { sha: "0123456789abcdef" } }),
    "0123456789abcdef",
  );
  assert.equal(githubApiInternals.readHeadSha({ head: { sha: "" } }), undefined);
  assert.equal(githubApiInternals.readHeadSha({}), undefined);
  assert.equal(
    githubApiInternals.readBaseSha({ base: { sha: "fedcba9876543210" } }),
    "fedcba9876543210",
  );
  assert.equal(githubApiInternals.readBaseSha({ base: { sha: "" } }), undefined);
});

test("retrieves complete pull request metadata through the GitHub HTTP client", async (t) => {
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
    response.end(
      JSON.stringify({
        title: "External change",
        changed_files: 17,
        head: { sha: "b".repeat(40) },
        base: { sha: "a".repeat(40), ref: "release/next" },
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
  const locator: PullRequestLocator = {
    repository: "target/project",
    owner: "target",
    name: "project",
    number: 73,
    htmlUrl: "https://github.com/target/project/pull/73",
  };

  const api = new GitHubApi("test-token", `http://127.0.0.1:${address.port}`);
  assert.deepEqual(await api.getPullRequestContext(locator), {
    ...locator,
    body: "",
    title: "External change",
    changedFiles: 17,
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    baseRef: "release/next",
  });
  assert.deepEqual(requests, [
    {
      method: "GET",
      path: "/repos/target/project/pulls/73",
      authorization: "Bearer test-token",
    },
  ]);
});

test("logs REST response metadata without recording response bodies", async (t) => {
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "github",
    secrets: ["body-secret"],
    write: (line) => lines.push(line),
    id: (() => {
      let index = 0;
      return () => `rest-${++index}`;
    })(),
  });
  const previous = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ message: "body-secret", errors: [{ message: "permission detail" }] }),
      {
        status: 403,
        statusText: "Forbidden",
        headers: {
          "content-type": "application/json",
          "x-github-request-id": "request-403",
          "x-accepted-github-permissions": "metadata=read",
          "x-ratelimit-remaining": "0",
        },
      },
    );
  t.after(() => {
    globalThis.fetch = previous;
  });
  const api = new GitHubApi("token", "https://api.github.com", undefined, undefined, diagnostics);
  await assert.rejects(api.getAuthenticatedUserLogin(), /body-secret/u);
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const terminal = records.find((record) => record.event === "operation.finished");
  assert.ok(terminal);
  assert.equal(terminal.operation, "rest.user.current");
  assert.equal(terminal.outcome, "failure");
  const details = terminal.details as Record<string, unknown>;
  assert.equal(details.status, 403);
  assert.equal(details.request_id, "request-403");
  assert.equal(details.required_permission, "metadata:read");
  assert.deepEqual(details.error, {
    name: "GitHubApiError",
    message: "GitHub API request failed (403).",
    diagnosticMessage: "GitHub API request failed (403).",
    operation: "rest.user.current",
    status: 403,
    requestId: "request-403",
    requiredPermission: "metadata:read",
  });
  assert.equal(JSON.stringify(records).includes("body-secret"), false);
  assert.equal(JSON.stringify(records).includes("permission detail"), false);
});

test("logs GraphQL authorization errors with bounded metadata", async (t) => {
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "github",
    write: (line) => lines.push(line),
  });
  const previous = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        errors: [
          {
            type: "FORBIDDEN",
            message: "Resource not accessible by integration",
            path: ["repository", "pullRequest", "reviewThreads"],
            locations: [{ line: 3, column: 5, secret: "must-not-appear" }],
            extensions: { code: "FORBIDDEN", secret: "must-not-appear" },
          },
        ],
      }),
      { status: 200, headers: { "x-github-request-id": "graphql-403" } },
    );
  t.after(() => {
    globalThis.fetch = previous;
  });
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 7,
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    baseRef: "main",
    title: "GraphQL authorization",
    htmlUrl: "https://github.com/owner/repository/pull/7",
  };
  const api = new GitHubApi(
    "token",
    "https://api.github.com",
    undefined,
    "https://api.github.com/graphql",
    diagnostics,
  );
  await assert.rejects(api.getReviewLifecycleSnapshot(context), /Resource not accessible/u);
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const terminal = records.find((record) => record.event === "operation.finished");
  assert.ok(terminal);
  assert.equal(terminal.operation, "AiPrReviewerReviews");
  const details = terminal.details as Record<string, unknown>;
  const errorDetails = details.error as Record<string, unknown>;
  assert.equal(errorDetails.name, "GitHubApiError");
  assert.equal(errorDetails.message, "GitHub API request failed (200).");
  assert.equal(errorDetails.diagnosticMessage, "GitHub API request failed (200).");
  assert.equal(errorDetails.operation, "AiPrReviewerReviews");
  assert.equal(errorDetails.status, 200);
  assert.equal(errorDetails.requestId, "graphql-403");
  assert.equal(errorDetails.requiredPermission, "pull_requests:read");
  assert.equal(
    ((errorDetails.graphqlErrors as Array<Record<string, unknown>>)[0] as Record<string, unknown>)
      .message,
    "Resource not accessible by integration",
  );
  assert.deepEqual((details.graphql_errors as Array<Record<string, unknown>>)[0], {
    type: "FORBIDDEN",
    message: "Resource not accessible by integration",
    path: ["repository", "pullRequest", "reviewThreads"],
    locations: [{ line: 3, column: 5 }],
    code: "FORBIDDEN",
  });
  assert.equal(JSON.stringify(records).includes("must-not-appear"), false);

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        message: "forbidden",
        errors: [
          {
            type: "FORBIDDEN",
            message: "Resource not accessible by integration",
            path: ["repository"],
          },
        ],
      }),
      { status: 403, headers: { "x-github-request-id": "graphql-403-http" } },
    );
  await assert.rejects(api.getReviewLifecycleSnapshot(context), /forbidden/u);
  const httpRecords = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const httpTerminal = httpRecords.find(
    (record) =>
      record.operation === "AiPrReviewerReviews" &&
      record.event === "operation.finished" &&
      (record.details as Record<string, unknown> | undefined)?.request_id === "graphql-403-http",
  );
  assert.ok(httpTerminal);
  assert.deepEqual(
    (
      (httpTerminal.details as Record<string, unknown>).graphql_errors as Array<
        Record<string, unknown>
      >
    )[0],
    { type: "FORBIDDEN", message: "Resource not accessible by integration", path: ["repository"] },
  );

  const largeMessage = `graphql-large-${"x".repeat(2_048)}`;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        errors: Array.from({ length: 20 }, () => ({
          type: "FORBIDDEN",
          message: largeMessage,
          path: ["repository", "pullRequest", "reviewThreads"],
          locations: [{ line: 3, column: 5 }],
          extensions: { code: "FORBIDDEN" },
        })),
      }),
      { status: 200, headers: { "x-github-request-id": "graphql-large" } },
    );
  await assert.rejects(api.getReviewLifecycleSnapshot(context), /graphql-large/u);
  const largeRecords = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const largeTerminal = largeRecords.find(
    (record) =>
      record.operation === "AiPrReviewerReviews" &&
      record.event === "operation.finished" &&
      (record.details as Record<string, unknown> | undefined)?.request_id === "graphql-large",
  );
  assert.ok(largeTerminal);
  assert.equal(JSON.stringify(largeTerminal).length <= 8_000, true);
  const largeDetails = largeTerminal.details as Record<string, unknown>;
  assert.equal(largeDetails.status, 200);
  assert.equal(largeDetails.request_id, "graphql-large");
  assert.equal(largeDetails.required_permission, "pull_requests:read");
  assert.equal(largeDetails.graphql_errors, "[TRUNCATED]");
});

test("logs network failures and strips signed URL query parameters", async (t) => {
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "github",
    write: (line) => lines.push(line),
  });
  const previous = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed for https://api.example.test/user?signature=private");
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  await assert.rejects(
    new GitHubApi(
      "token",
      "https://api.example.test",
      undefined,
      undefined,
      diagnostics,
    ).getAuthenticatedUserLogin(),
    /fetch failed/u,
  );
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const terminal = records.find((record) => record.event === "operation.finished");
  assert.ok(terminal);
  assert.equal(terminal.outcome, "failure");
  assert.equal(JSON.stringify(records).includes("signature="), false);
  const errorDetails = (terminal.details as Record<string, unknown>).error as Record<
    string,
    unknown
  >;
  assert.equal(typeof errorDetails.message, "string");
  assert.equal((errorDetails.message as string).endsWith("/user"), true);
});

test("records header-construction failures without leaking newline-containing tokens", async () => {
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "github",
    write: (line) => lines.push(line),
  });
  const token = "token\nwith-newline";
  await assert.rejects(
    new GitHubApi(
      token,
      "https://api.example.test",
      undefined,
      undefined,
      diagnostics,
    ).getAuthenticatedUserLogin(),
  );
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const started = records.find(
    (record) => record.operation === "rest.user.current" && record.event === "operation.started",
  );
  const terminal = records.find(
    (record) => record.operation === "rest.user.current" && record.event === "operation.finished",
  );
  assert.ok(started);
  assert.ok(terminal);
  assert.equal(started.operation_id, terminal.operation_id);
  assert.equal(terminal.outcome, "failure");
  assert.equal(JSON.stringify(records).includes(token), false);
});

test("preserves pre-aborted cancellation before malformed header construction", async (t) => {
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "github",
    write: (line) => lines.push(line),
  });
  const previous = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    throw new Error("request should not be sent");
  };
  t.after(() => {
    globalThis.fetch = previous;
  });
  const controller = new AbortController();
  const reason = new CancellationError("SIGTERM");
  controller.abort(reason);
  await assert.rejects(
    new GitHubApi(
      "token\nwith-newline",
      "https://api.example.test",
      controller.signal,
      undefined,
      diagnostics,
    ).getAuthenticatedUserLogin(),
    (error: unknown) => error === reason,
  );
  assert.equal(requests, 0);
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const started = records.find(
    (record) => record.operation === "rest.user.current" && record.event === "operation.started",
  );
  const terminal = records.find(
    (record) => record.operation === "rest.user.current" && record.event === "operation.cancelled",
  );
  assert.ok(started);
  assert.ok(terminal);
  assert.equal(started.operation_id, terminal.operation_id);
});

test("retains REST response metadata when the response body read fails", async (t) => {
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "github",
    write: (line) => lines.push(line),
  });
  const previous = globalThis.fetch;
  const bodyError = Object.freeze(new Error("rest-body-read-sentinel"));
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 502,
      headers: new Headers({ "x-github-request-id": "rest-body-read" }),
      text: async () => {
        throw bodyError;
      },
    }) as unknown as Response;
  t.after(() => {
    globalThis.fetch = previous;
  });
  await assert.rejects(
    new GitHubApi(
      "token",
      "https://api.example.test",
      undefined,
      undefined,
      diagnostics,
    ).getAuthenticatedUserLogin(),
    (error: unknown) => error === bodyError,
  );
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const terminal = records.find((record) => record.event === "operation.finished");
  assert.ok(terminal);
  const details = terminal.details as Record<string, unknown>;
  assert.equal(details.status, 502);
  assert.equal(details.request_id, "rest-body-read");
  assert.equal(details.required_permission, "metadata:read");
  assert.equal(
    (details.error as Record<string, unknown>).message,
    "GitHub REST response body read failed.",
  );
  assert.equal(JSON.stringify(records).includes("rest-body-read-sentinel"), false);

  const primitiveBodyError = "rest-primitive-body-read-sentinel";
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 502,
      headers: new Headers({ "x-github-request-id": "rest-primitive-body-read" }),
      text: async () => Promise.reject(primitiveBodyError),
    }) as unknown as Response;
  await assert.rejects(
    new GitHubApi(
      "token",
      "https://api.example.test",
      undefined,
      undefined,
      diagnostics,
    ).getAuthenticatedUserLogin(),
    (error: unknown) => error === primitiveBodyError,
  );
  const primitiveRecords = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const primitiveTerminal = primitiveRecords.find(
    (record) =>
      record.event === "operation.finished" &&
      (record.details as Record<string, unknown> | undefined)?.request_id ===
        "rest-primitive-body-read",
  );
  assert.ok(primitiveTerminal);
  assert.equal(
    ((primitiveTerminal.details as Record<string, unknown>).error as Record<string, unknown>)
      .message,
    "GitHub REST response body read failed.",
  );
  assert.equal(JSON.stringify(primitiveRecords).includes(primitiveBodyError), false);
});

test("retains GraphQL response metadata when the response body read fails", async (t) => {
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "github",
    write: (line) => lines.push(line),
  });
  const previous = globalThis.fetch;
  const bodyError = Object.freeze(new Error("graphql-body-read-sentinel"));
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 502,
      headers: new Headers({ "x-github-request-id": "graphql-body-read" }),
      text: async () => {
        throw bodyError;
      },
    }) as unknown as Response;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 7,
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    baseRef: "main",
    title: "GraphQL body read",
    htmlUrl: "https://github.com/owner/repository/pull/7",
  };
  await assert.rejects(
    new GitHubApi(
      "token",
      "https://api.example.test",
      undefined,
      "https://api.example.test/graphql",
      diagnostics,
    ).getReviewLifecycleSnapshot(context),
    (error: unknown) => error === bodyError,
  );
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const terminal = records.find((record) => record.event === "operation.finished");
  assert.ok(terminal);
  const details = terminal.details as Record<string, unknown>;
  assert.equal(details.status, 502);
  assert.equal(details.request_id, "graphql-body-read");
  assert.equal(details.required_permission, "pull_requests:read");
  assert.equal(
    (details.error as Record<string, unknown>).message,
    "GitHub GraphQL response body read failed.",
  );
  assert.equal(JSON.stringify(records).includes("graphql-body-read-sentinel"), false);

  const primitiveBodyError = "graphql-primitive-body-read-sentinel";
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 502,
      headers: new Headers({ "x-github-request-id": "graphql-primitive-body-read" }),
      text: async () => Promise.reject(primitiveBodyError),
    }) as unknown as Response;
  await assert.rejects(
    new GitHubApi(
      "token",
      "https://api.example.test",
      undefined,
      "https://api.example.test/graphql",
      diagnostics,
    ).getReviewLifecycleSnapshot(context),
    (error: unknown) => error === primitiveBodyError,
  );
  const primitiveRecords = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const primitiveTerminal = primitiveRecords.find(
    (record) =>
      record.event === "operation.finished" &&
      (record.details as Record<string, unknown> | undefined)?.request_id ===
        "graphql-primitive-body-read",
  );
  assert.ok(primitiveTerminal);
  assert.equal(
    ((primitiveTerminal.details as Record<string, unknown>).error as Record<string, unknown>)
      .message,
    "GitHub GraphQL response body read failed.",
  );
  assert.equal(JSON.stringify(primitiveRecords).includes(primitiveBodyError), false);
});

test("loads linked issue bodies and excludes linked pull requests", async (t) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("Content-Type", "application/json");
    if (request.url?.endsWith("/issues/12")) {
      response.end(
        JSON.stringify({
          title: "Issue context",
          body: "The caller must preserve this invariant.",
          state: "open",
          html_url: "https://github.com/owner/repository/issues/12",
        }),
      );
      return;
    }
    if (request.url?.endsWith("/issues/13")) {
      response.end(
        JSON.stringify({
          title: "Pull request context",
          body: "This is not an issue.",
          state: "open",
          html_url: "https://github.com/owner/repository/pull/13",
          pull_request: { url: "https://api.github.com/repos/owner/repository/pulls/13" },
        }),
      );
      return;
    }
    if (request.url?.endsWith("/issues/15")) {
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    response.end(
      JSON.stringify({
        title: "Ignored context",
        body: null,
        state: "closed",
        html_url: "https://github.com/owner/repository/issues/14",
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
  const api = new GitHubApi("test-token", `http://127.0.0.1:${address.port}`);
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 11,
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    baseRef: "main",
    title: "Linked issue context",
    body: "Fixes #12 and #13 and #14 and #15.",
    htmlUrl: "https://github.com/owner/repository/pull/11",
  };
  assert.deepEqual(await api.getLinkedIssues(context), {
    linkedIssueReferencesTruncated: false,
    linkedIssues: [
      {
        number: 12,
        title: "Issue context",
        body: "The caller must preserve this invariant.",
        state: "open",
        htmlUrl: "https://github.com/owner/repository/issues/12",
      },
      {
        number: 14,
        title: "Ignored context",
        body: "",
        state: "closed",
        htmlUrl: "https://github.com/owner/repository/issues/14",
      },
    ],
  });
  assert.deepEqual(requests, [
    "/repos/owner/repository/issues/12",
    "/repos/owner/repository/issues/13",
    "/repos/owner/repository/issues/14",
    "/repos/owner/repository/issues/15",
  ]);
});

test("aborts in-flight GitHub requests and blocks later writes", async (t) => {
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "github",
    write: (line) => lines.push(line),
  });
  let requests = 0;
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const server = createServer((request, response) => {
    requests += 1;
    markStarted?.();
    request.once("aborted", () => response.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const controller = new AbortController();
  const api = new GitHubApi(
    "test-token",
    `http://127.0.0.1:${address.port}`,
    controller.signal,
    undefined,
    diagnostics,
  );
  const pending = api.getAuthenticatedUserLogin();
  await started;
  const reason = new CancellationError("SIGTERM");
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);

  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 1,
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    baseRef: "main",
    title: "Cancelled review",
    htmlUrl: "https://github.com/owner/repository/pull/1",
  };
  await assert.rejects(
    api.createReview(context, {
      commit_id: context.headSha,
      body: "body",
      event: "COMMENT",
      comments: [],
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(requests, 1);
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  assert.equal(
    records.some(
      (record) => record.operation === "rest.user.current" && record.outcome === "cancelled",
    ),
    true,
  );
  assert.equal(
    records.some(
      (record) =>
        record.operation === "rest.pull-request.create-review" && record.outcome === "cancelled",
    ),
    true,
  );
});

test("paginates files and conversation records and creates a review", async (t) => {
  const diagnosticLines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "github",
    write: (line) => diagnosticLines.push(line),
  });
  const requests: Array<{
    readonly method: string | undefined;
    readonly url: string | undefined;
    readonly body: string;
  }> = [];
  let serverOrigin = "";
  const file = (index: number) => ({
    filename: `src/file-${index}.ts`,
    ...(index === 0 ? { previous_filename: "src/old.ts" } : {}),
    status: index === 0 ? "renamed" : "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -0,0 +1 @@\n+added",
  });
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body });
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/user") {
        response.end(JSON.stringify({ login: "review-owner" }));
        return;
      }
      if (request.url?.includes("/files?per_page=100&page=1")) {
        response.setHeader(
          "link",
          `<${serverOrigin}/api/repos/owner/repository/pulls/11/files?per_page=100&page=2>; rel="next"`,
        );
        response.end(JSON.stringify(Array.from({ length: 100 }, (_, index) => file(index))));
        return;
      }
      if (request.url?.includes("/files?per_page=100&page=2")) {
        response.end(JSON.stringify([file(100)]));
        return;
      }
      if (request.url?.includes("/reviews?per_page=100&page=1")) {
        response.setHeader(
          "link",
          `<${serverOrigin}/api/repos/owner/repository/pulls/11/reviews?per_page=100&page=2>; rel="next"`,
        );
        response.end(
          JSON.stringify([
            {
              id: 1,
              user: { login: "reviewer", type: "User" },
              body: "First review",
              commit_id: "b".repeat(40),
              state: "COMMENTED",
              submitted_at: "2026-08-17T00:00:00Z",
            },
          ]),
        );
        return;
      }
      if (request.url?.includes("/reviews?per_page=100&page=2")) {
        response.end(
          JSON.stringify([
            {
              id: 2,
              user: { login: "second", type: "User" },
              body: "Second review",
              commit_id: null,
              state: "APPROVED",
              submitted_at: null,
            },
          ]),
        );
        return;
      }
      if (request.url?.includes("/pulls/11/comments?per_page=100&page=1")) {
        response.setHeader(
          "link",
          `<${serverOrigin}/api/repos/owner/repository/pulls/11/comments?per_page=100&page=2>; rel="next"`,
        );
        response.end(
          JSON.stringify([
            {
              id: 10,
              pull_request_review_id: 1,
              in_reply_to_id: null,
              user: { login: "review-bot", type: "Bot" },
              body: "Inline finding",
              commit_id: "b".repeat(40),
              original_commit_id: "a".repeat(40),
              path: "src/file-0.ts",
              line: 2,
              original_line: null,
              created_at: "2026-08-17T00:01:00Z",
              updated_at: "2026-08-17T00:01:01Z",
            },
          ]),
        );
        return;
      }
      if (request.url?.includes("/pulls/11/comments?per_page=100&page=2")) {
        response.end(
          JSON.stringify([
            {
              id: 11,
              pull_request_review_id: null,
              in_reply_to_id: 10,
              user: { login: "owner", type: "User" },
              body: "Owner reply",
              commit_id: "b".repeat(40),
              original_commit_id: "a".repeat(40),
              path: "src/file-0.ts",
              line: null,
              original_line: 2,
              created_at: "2026-08-17T00:02:00Z",
              updated_at: "2026-08-17T00:02:01Z",
            },
          ]),
        );
        return;
      }
      if (request.url?.includes("/issues/11/comments?")) {
        response.end(
          JSON.stringify([
            {
              id: 20,
              user: { login: "owner", type: "User" },
              body: "PR-level context",
              created_at: "2026-08-17T00:03:00Z",
              updated_at: "2026-08-17T00:03:01Z",
              performed_via_github_app: null,
            },
            {
              id: 21,
              user: null,
              body: null,
              created_at: "2026-08-17T00:04:00Z",
              updated_at: "2026-08-17T00:04:01Z",
              performed_via_github_app: { id: 1 },
            },
          ]),
        );
        return;
      }
      if (request.method === "POST" && request.url?.endsWith("/reviews")) {
        response.end("{}");
        return;
      }
      response.end(
        JSON.stringify({
          title: "Paginated change",
          changed_files: 101,
          head: { sha: "b".repeat(40) },
          base: { sha: "a".repeat(40), ref: "main" },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  serverOrigin = `http://127.0.0.1:${address.port}`;
  const api = new GitHubApi(
    "test-token",
    `${serverOrigin}/api/`,
    undefined,
    undefined,
    diagnostics,
  );
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 11,
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    baseRef: "main",
    changedFiles: 101,
    title: "Paginated change",
    htmlUrl: "https://github.com/owner/repository/pull/11",
  };

  assert.equal(await api.getAuthenticatedUserLogin(), "review-owner");
  assert.deepEqual(await api.getPullRequestRefs(context), {
    headSha: context.headSha,
    baseSha: context.baseSha,
  });
  assert.equal(await api.getPullRequestHeadSha(context), context.headSha);
  const files = await api.getPullRequestFiles(context);
  assert.equal(files.length, 101);
  assert.equal(files[0]?.previousPath, "src/old.ts");
  assert.deepEqual([...(files[100]?.addedLines ?? [])], [1]);
  const filePages = diagnosticLines
    .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>)
    .filter(
      (record) =>
        record.event === "operation.started" && record.operation === "rest.pull-request.files",
    )
    .map(
      (record) =>
        ((record.details as Record<string, unknown>).request as Record<string, unknown>).page,
    );
  assert.deepEqual(filePages, [1, 2]);
  assert.deepEqual(await api.listReviews(context), [
    {
      id: 1,
      author: { login: "reviewer", type: "User" },
      body: "First review",
      commitId: "b".repeat(40),
      state: "COMMENTED",
      submittedAt: "2026-08-17T00:00:00Z",
    },
    {
      id: 2,
      author: { login: "second", type: "User" },
      body: "Second review",
      commitId: null,
      state: "APPROVED",
    },
  ]);
  assert.deepEqual(await api.listReviewComments(context), [
    {
      id: 10,
      reviewId: 1,
      author: { login: "review-bot", type: "Bot" },
      body: "Inline finding",
      commitId: "b".repeat(40),
      originalCommitId: "a".repeat(40),
      path: "src/file-0.ts",
      line: 2,
      createdAt: "2026-08-17T00:01:00Z",
      updatedAt: "2026-08-17T00:01:01Z",
    },
    {
      id: 11,
      inReplyToId: 10,
      author: { login: "owner", type: "User" },
      body: "Owner reply",
      commitId: "b".repeat(40),
      originalCommitId: "a".repeat(40),
      path: "src/file-0.ts",
      originalLine: 2,
      createdAt: "2026-08-17T00:02:00Z",
      updatedAt: "2026-08-17T00:02:01Z",
    },
  ]);
  assert.deepEqual(await api.listIssueComments(context), [
    {
      id: 20,
      author: { login: "owner", type: "User" },
      body: "PR-level context",
      createdAt: "2026-08-17T00:03:00Z",
      updatedAt: "2026-08-17T00:03:01Z",
      performedViaGitHubApp: false,
    },
    {
      id: 21,
      body: "",
      createdAt: "2026-08-17T00:04:00Z",
      updatedAt: "2026-08-17T00:04:01Z",
      performedViaGitHubApp: true,
    },
  ]);
  const reviewRequest: PullRequestReviewRequest = {
    commit_id: context.headSha,
    body: "Review body",
    event: "COMMENT",
    comments: [],
  };
  await api.createReview(context, reviewRequest);
  const posted = requests.find((request) => request.method === "POST");
  assert.deepEqual(JSON.parse(posted?.body ?? "{}"), reviewRequest);
});

test("reports malformed GitHub responses and file-count inconsistencies", async (t) => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/user") {
      response.end("{}");
      return;
    }
    if (request.method === "POST") {
      response.statusCode = request.url?.includes("/pulls/8/") ? 500 : 422;
      response.end(
        request.url?.includes("/pulls/8/")
          ? "not-json"
          : JSON.stringify({
              message: "Validation Failed",
              errors: ["plain error", { message: "inline error" }, {}],
            }),
      );
      return;
    }
    const number = /\/pulls\/(\d+)/u.exec(request.url ?? "")?.[1];
    const issueNumber = /\/issues\/(\d+)/u.exec(request.url ?? "")?.[1];
    if (request.url?.includes("/files?")) {
      if (number === "3") response.end("{}");
      else if (number === "5") response.end("[null]");
      else if (number === "6") response.end("[{}]");
      else
        response.end(
          JSON.stringify([
            {
              filename: "one.ts",
              status: "modified",
              additions: -1,
              deletions: "invalid",
              changes: 1.5,
            },
          ]),
        );
      return;
    }
    if (request.url?.includes("/reviews?")) {
      response.end(number === "11" ? "[{}]" : "{}");
      return;
    }
    if (request.url?.includes("/pulls/") && request.url.includes("/comments?")) {
      response.end(number === "13" ? "[{}]" : "{}");
      return;
    }
    if (request.url?.includes("/issues/") && request.url.includes("/comments?")) {
      response.end(issueNumber === "15" ? "[{}]" : "{}");
      return;
    }
    if (number === "1") response.end("null");
    else if (number === "2")
      response.end(JSON.stringify({ head: { sha: "head" }, base: { sha: "base" } }));
    else response.end(JSON.stringify({ head: {}, base: {} }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const api = new GitHubApi("token", `http://127.0.0.1:${address.port}`);
  const locator = (number: number): PullRequestLocator => ({
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number,
    htmlUrl: `https://github.com/owner/repository/pull/${number}`,
  });
  const context = (number: number, changedFiles?: number): PullRequestContext => ({
    ...locator(number),
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    baseRef: "main",
    ...(changedFiles === undefined ? {} : { changedFiles }),
    title: "Malformed response",
  });

  await assert.rejects(api.getAuthenticatedUserLogin(), /no authenticated user login/u);
  await assert.rejects(api.getPullRequestContext(locator(1)), /invalid pull request metadata/u);
  await assert.rejects(api.getPullRequestContext(locator(2)), /incomplete pull request ref/u);
  await assert.rejects(api.getPullRequestRefs(context(1)), /incomplete pull request ref/u);
  await assert.rejects(api.getPullRequestFiles(context(3)), /invalid pull request files/u);
  await assert.rejects(api.listReviews(context(4)), /invalid pull request reviews/u);
  await assert.rejects(api.listReviews(context(11)), /invalid review user at index 0/u);
  await assert.rejects(
    api.listReviewComments(context(12)),
    /invalid pull request review comments/u,
  );
  await assert.rejects(
    api.listReviewComments(context(13)),
    /invalid pull request review comment review id at index 0/u,
  );
  await assert.rejects(
    api.listIssueComments(context(14)),
    /invalid pull request conversation comments/u,
  );
  await assert.rejects(
    api.listIssueComments(context(15)),
    /invalid pull request conversation comment user at index 0/u,
  );
  await assert.rejects(api.getPullRequestFiles(context(5)), /invalid changed-file record/u);
  await assert.rejects(api.getPullRequestFiles(context(6)), /without a filename/u);
  await assert.rejects(
    api.getPullRequestFiles(context(9, 2)),
    /incomplete pull request file list/u,
  );
  await assert.rejects(
    api.getPullRequestFiles(context(10, 0)),
    /more files than the pull request metadata/u,
  );
  await assert.rejects(
    api.createReview(context(7), {
      commit_id: "b".repeat(40),
      body: "body",
      event: "COMMENT",
      comments: [],
    }),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.status === 422 &&
      /Validation Failed; plain error; inline error/u.test(error.message),
  );
  await assert.rejects(
    api.createReview(context(8), {
      commit_id: "b".repeat(40),
      body: "body",
      event: "COMMENT",
      comments: [],
    }),
    /GitHub API request failed \(500\)/u,
  );
});

test("handles uncommon patch and pagination shapes", () => {
  assert.deepEqual(githubApiInternals.parsePatchCounts(undefined), {
    additions: 0,
    deletions: 0,
    complete: false,
  });
  assert.equal(
    githubApiInternals.parsePatchCounts("@@ -1 +1 @@\n context\n+extra").complete,
    false,
  );
  assert.equal(githubApiInternals.parsePatchCounts("not a patch").complete, false);
  assert.equal(
    githubApiInternals.nextPagePath(
      '<https://api.example.test/root>; rel="last"',
      "https://api.example.test/api",
    ),
    undefined,
  );
  assert.equal(
    githubApiInternals.nextPagePath(
      '<https://api.example.test/other?page=2>; rel="next"',
      "https://api.example.test/api",
    ),
    "/other?page=2",
  );
});
