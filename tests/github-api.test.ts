import { strict as assert } from "node:assert";
import test from "node:test";

import { githubApiInternals } from "../src/lib/github-api.js";

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
