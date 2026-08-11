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
