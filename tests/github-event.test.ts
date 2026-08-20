import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CancellationError } from "../src/lib/bootstrap/cancellation.js";
import {
  parsePullRequestUrl,
  readPullRequestContext,
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

test("validates every required pull request event field", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-event-invalid-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const path = join(directory, "event.json");
  const valid = {
    number: 7,
    pull_request: {
      title: "Change",
      html_url: "https://github.com/owner/repository/pull/7",
      changed_files: -1,
      head: { sha: "b".repeat(40) },
      base: { sha: "a".repeat(40), ref: "main" },
    },
  };
  await writeFile(path, JSON.stringify(valid));
  assert.equal(
    (await readPullRequestEventContext(path, "owner/repository"))?.changedFiles,
    undefined,
  );
  await writeFile(
    path,
    JSON.stringify({
      ...valid,
      number: undefined,
      pull_request: { ...valid.pull_request, number: 8 },
    }),
  );
  assert.equal((await readPullRequestEventContext(path, "owner/repository"))?.number, 8);

  const previousRepository = process.env.GITHUB_REPOSITORY;
  t.after(() => {
    if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepository;
  });
  delete process.env.GITHUB_REPOSITORY;
  for (const repository of [undefined, "owner", "owner/repository/extra"]) {
    await assert.rejects(readPullRequestEventContext(path, repository), /GITHUB_REPOSITORY/u);
  }
  const cases: Array<readonly [unknown, RegExp]> = [
    [{ ...valid, number: 0 }, /field 'number' is invalid/u],
    [{ ...valid, number: "7" }, /field 'number' is invalid/u],
    [
      { ...valid, pull_request: { ...valid.pull_request, head: null } },
      /pull_request\.head\.sha.*missing/u,
    ],
    [
      { ...valid, pull_request: { ...valid.pull_request, base: {} } },
      /pull_request\.base\.sha.*missing/u,
    ],
    [
      {
        ...valid,
        pull_request: { ...valid.pull_request, base: { sha: "a".repeat(40), ref: "" } },
      },
      /pull_request\.base\.ref.*missing/u,
    ],
    [
      { ...valid, pull_request: { ...valid.pull_request, title: "" } },
      /pull_request\.title.*missing/u,
    ],
    [
      { ...valid, pull_request: { ...valid.pull_request, html_url: null } },
      /pull_request\.html_url.*missing/u,
    ],
  ];
  for (const [event, message] of cases) {
    await writeFile(path, JSON.stringify(event));
    await assert.rejects(readPullRequestEventContext(path, "owner/repository"), message);
  }
});

test("requires a pull request context when no target can be read", async () => {
  assert.equal(await readPullRequestEventContext("", "owner/repository"), undefined);
  await assert.rejects(readPullRequestContext("", "owner/repository"), /No pull request target/u);
});

test("stops before reading a pull request event after cancellation", async () => {
  const controller = new AbortController();
  const reason = new CancellationError("SIGINT");
  controller.abort(reason);
  await assert.rejects(
    readPullRequestEventContext("/missing/event.json", "owner/repository", controller.signal),
    (error: unknown) => error === reason,
  );
});

test("rejects invalid server URLs, repository segments, and pull request numbers", () => {
  const previousServer = process.env.GITHUB_SERVER_URL;
  delete process.env.GITHUB_SERVER_URL;
  try {
    assert.throws(
      () => parsePullRequestUrl("https://github.com/owner/repository/pull/1"),
      /GITHUB_SERVER_URL is not set/u,
    );
  } finally {
    if (previousServer === undefined) delete process.env.GITHUB_SERVER_URL;
    else process.env.GITHUB_SERVER_URL = previousServer;
  }
  for (const [target, server, message] of [
    ["not-a-url", "https://github.com", /absolute HTTP\(S\) URL/u],
    ["ftp://github.com/owner/repository/pull/1", "ftp://github.com", /must use http/u],
    ["https://github.com/owner/repository/pull/1", "not-a-url", /absolute HTTP\(S\) URL/u],
    [
      "https://github.com/owner/repository/pull/1",
      "https://user:pass@github.com",
      /must not contain URL credentials/u,
    ],
  ] as const) {
    assert.throws(() => parsePullRequestUrl(target, server), message);
  }
  for (const path of [
    "/./repository/pull/1",
    "/owner/../pull/1",
    "/owner/repository/pull/0",
    "/owner/repository/pull/01",
    "/owner/repository/pull/not-a-number",
    "/owner!/repository/pull/1",
  ]) {
    assert.throws(
      () => parsePullRequestUrl(`https://github.com${path}`, "https://github.com"),
      /owner\/repository\/pull\/number/u,
    );
  }
  assert.throws(
    () =>
      parsePullRequestUrl(
        `https://github.com/owner/repository/pull/${"9".repeat(400)}`,
        "https://github.com",
      ),
    /invalid pull request number/u,
  );
  assert.equal(
    samePullRequest(
      { repository: "owner/first", number: 1 },
      { repository: "owner/second", number: 1 },
    ),
    false,
  );
});
