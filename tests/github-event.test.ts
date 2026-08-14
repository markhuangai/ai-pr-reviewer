import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parsePullRequestUrl,
  readPullRequestEventContext,
  samePullRequest,
} from "../src/lib/github-event.js";

test("reads pull request event context including the base ref", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-event-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const path = join(directory, "event.json");
  await writeFile(
    path,
    JSON.stringify({
      number: 7,
      pull_request: {
        title: "Change",
        html_url: "https://github.com/owner/repository/pull/7",
        changed_files: 2,
        head: { sha: "b".repeat(40) },
        base: { sha: "a".repeat(40), ref: "main" },
      },
    }),
  );

  assert.deepEqual(await readPullRequestEventContext(path, "owner/repository"), {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 7,
    headSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    baseRef: "main",
    changedFiles: 2,
    title: "Change",
    htmlUrl: "https://github.com/owner/repository/pull/7",
  });
});

test("ignores non-pull-request event payloads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-event-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const path = join(directory, "event.json");
  await writeFile(path, JSON.stringify({ action: "workflow_dispatch" }));
  assert.equal(await readPullRequestEventContext(path, "owner/repository"), undefined);
});

test("parses same-origin pull request URLs and canonicalizes page subpaths", () => {
  const locator = parsePullRequestUrl(
    "https://github.com/Owner/Repository/pull/42/files?diff=split#discussion",
    "https://github.com",
  );
  assert.deepEqual(locator, {
    repository: "Owner/Repository",
    owner: "Owner",
    name: "Repository",
    number: 42,
    htmlUrl: "https://github.com/Owner/Repository/pull/42",
  });
  assert.equal(samePullRequest({ repository: "owner/repository", number: 42 }, locator), true);
  assert.equal(samePullRequest({ repository: "owner/repository", number: 41 }, locator), false);
});

test("rejects cross-origin and malformed pull request URLs", () => {
  assert.throws(
    () =>
      parsePullRequestUrl("https://example.test/owner/repository/pull/42", "https://github.com"),
    /same origin/,
  );
  assert.throws(
    () =>
      parsePullRequestUrl("https://github.com/owner/repository/issues/42", "https://github.com"),
    /owner\/repository\/pull\/number/,
  );
  assert.throws(
    () =>
      parsePullRequestUrl(
        "https://token@github.com/owner/repository/pull/42",
        "https://github.com",
      ),
    /credentials/,
  );
});
