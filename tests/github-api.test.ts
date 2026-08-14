import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import test from "node:test";

import { GitHubApi, githubApiInternals } from "../src/lib/github-api.js";
import type { PullRequestLocator } from "../src/lib/types.js";

test("extracts added line numbers from a unified diff", () => {
  const lines = githubApiInternals.parseAddedLines(
    "@@ -10,2 +20,4 @@\n context\n-old\n+new\n+another\n context",
  );
  assert.deepEqual([...lines], [21, 22]);
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
