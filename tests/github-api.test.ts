import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { CancellationError } from "../src/lib/bootstrap/cancellation.js";
import {
  GitHubApi,
  GitHubApiError,
  githubApiInternals,
  readPullRequestFilesFromCheckout,
} from "../src/lib/github-api.js";
import type {
  PullRequestContext,
  PullRequestLocator,
  PullRequestReviewRequest,
} from "../src/lib/types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "--all"]);
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "--message",
      message,
    ],
    { cwd },
  );
  return git(cwd, ["rev-parse", "HEAD"]);
}

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

test("validates NUL-delimited Git changed-file metadata", () => {
  assert.deepEqual(
    githubApiInternals.parseGitNameStatus("A\0added.txt\0T\0typed.txt\0C\0old.txt\0copy.txt"),
    [
      { path: "added.txt", status: "added" },
      { path: "typed.txt", status: "modified" },
      { path: "copy.txt", previousPath: "old.txt", status: "copied" },
    ],
  );
  assert.throws(() => githubApiInternals.parseGitNameStatus("M\0"), /invalid changed-file path/u);
  assert.throws(
    () => githubApiInternals.parseGitNameStatus("\0M\0file.txt\0"),
    /invalid changed-file status/u,
  );
  assert.throws(
    () => githubApiInternals.parseGitNameStatus("R\0old.txt\0"),
    /invalid changed-file rename path/u,
  );
  assert.throws(() => githubApiInternals.parseGitNameStatus("A\0\0"), /invalid changed-file path/u);
  const tooManyFiles = Array.from({ length: 3_001 }, (_, index) => `M\0file-${index}\0`).join("");
  assert.throws(
    () => githubApiInternals.parseGitNameStatus(tooManyFiles),
    /pull request file limit/u,
  );

  const modified = [{ path: "file.txt", status: "modified" }];
  assert.deepEqual(githubApiInternals.parseGitNumstat("1\t2\tfile.txt", modified), [
    { additions: 1, deletions: 2 },
  ]);
  assert.deepEqual(
    githubApiInternals.parseGitNumstat("-\t-\tbinary.dat", [
      { path: "binary.dat", status: "modified" },
    ]),
    [{ additions: 0, deletions: 0 }],
  );
  assert.deepEqual(
    githubApiInternals.parseGitNumstat("1\t0\t\0old.txt\0new.txt", [
      { path: "new.txt", previousPath: "old.txt", status: "renamed" },
    ]),
    [{ additions: 1, deletions: 0 }],
  );
  assert.throws(
    () => githubApiInternals.parseGitNumstat("", modified),
    /incomplete changed-file counts/u,
  );
  assert.throws(
    () => githubApiInternals.parseGitNumstat("1\tfile.txt", modified),
    /invalid changed-file counts/u,
  );
  assert.throws(
    () => githubApiInternals.parseGitNumstat("invalid", modified),
    /invalid changed-file counts/u,
  );
  assert.throws(
    () => githubApiInternals.parseGitNumstat("1\t0\t", modified),
    /invalid changed-file path/u,
  );
  assert.throws(
    () => githubApiInternals.parseGitNumstat("1\t0\tother.txt", modified),
    /inconsistent changed-file paths/u,
  );
  assert.throws(
    () =>
      githubApiInternals.parseGitNumstat("1\t0\t\0different-old.txt\0new.txt", [
        { path: "new.txt", previousPath: "old.txt", status: "renamed" },
      ]),
    /inconsistent changed-file paths/u,
  );
  assert.throws(
    () => githubApiInternals.parseGitNumstat("1\t0\tfile.txt\0extra", modified),
    /extra changed-file counts/u,
  );
  assert.throws(
    () => githubApiInternals.parseGitNumstat("9007199254740992\t0\tfile.txt", modified),
    /invalid addition count/u,
  );
  assert.throws(
    () => githubApiInternals.parseGitNumstat("not-a-count\t0\tfile.txt", modified),
    /invalid addition count/u,
  );
  assert.throws(
    () => githubApiInternals.parseGitNumstat("9007199254740991\t1\tfile.txt", modified),
    /oversized changed-file counts/u,
  );
});

test("fails closed when local Git metadata commands fail", async () => {
  assert.equal(githubApiInternals.diffPath("+++ odd-path.txt"), "odd-path.txt");
  assert.equal(githubApiInternals.diffPath("not a file header"), undefined);
  await assert.rejects(
    githubApiInternals.readGitAddedLines("/tmp", "a".repeat(40), "b".repeat(40)),
    /changed-file diff failed/u,
  );
  await assert.rejects(
    githubApiInternals.readGitMetadata("/tmp/ai-pr-reviewer-missing-working-tree", ["status"]),
    /changed-file metadata failed/u,
  );
});

test("parses streamed Git diff hunks and rejects malformed output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-git-stub-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const gitPath = join(root, "git");
  await writeFile(
    gitPath,
    "#!/bin/sh\nprintf '%s\\n' 'diff --git a/file.txt b/file.txt'\nprintf '%s\\n' '+++ b/file.txt'\nprintf '%s\\n' '@@ -0,0 +1 @@'\nprintf '%s\\n' '+++ foo'\nprintf '%s\\n' '@@ -1,0 +2,1 @@'\nprintf '%s' '+line'\n",
  );
  await chmod(gitPath, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${root}${previousPath === undefined ? "" : `:${previousPath}`}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  const parsed = await githubApiInternals.readGitAddedLines("/tmp", "a".repeat(40), "b".repeat(40));
  assert.deepEqual([...(parsed.get("file.txt") ?? [])], [1, 2]);

  await writeFile(
    gitPath,
    "#!/bin/sh\nprintf '%s\\n' '+++ b/file.txt'\nprintf '%s\\n' '@@ malformed'\n",
  );
  await assert.rejects(
    githubApiInternals.readGitAddedLines("/tmp", "a".repeat(40), "b".repeat(40)),
    /invalid changed-file hunk header/u,
  );
});

test("reads exact changed-file metadata from the captured checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-files-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await git(root, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(root, "keep.txt"), "base\n");
  await writeFile(join(root, "remove.txt"), "remove\n");
  await writeFile(join(root, "old-name.txt"), "one\ntwo\nthree\n");
  const baseSha = await commit(root, "base");
  await writeFile(join(root, "keep.txt"), "head\n");
  await rm(join(root, "remove.txt"));
  await execFileAsync("git", ["mv", "old-name.txt", "new-name.txt"], { cwd: root });
  await writeFile(join(root, "new-name.txt"), "one\ntwo\nthree\nadded\n");
  const headSha = await commit(root, "head");
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 1,
    headSha,
    baseSha,
    baseRef: "main",
    changedFiles: 3,
    title: "Captured files",
    htmlUrl: "https://github.com/owner/repository/pull/1",
  };

  const files = await readPullRequestFilesFromCheckout(context, root);
  assert.deepEqual(
    files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      addedLines: [...file.addedLines],
    })),
    [
      {
        path: "keep.txt",
        previousPath: undefined,
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        addedLines: [1],
      },
      {
        path: "new-name.txt",
        previousPath: "old-name.txt",
        status: "renamed",
        additions: 1,
        deletions: 0,
        changes: 1,
        addedLines: [4],
      },
      {
        path: "remove.txt",
        previousPath: undefined,
        status: "removed",
        additions: 0,
        deletions: 1,
        changes: 1,
        addedLines: [],
      },
    ],
  );
  await assert.rejects(
    readPullRequestFilesFromCheckout({ ...context, changedFiles: 4 }, root),
    /incomplete pull request file list/u,
  );
  await assert.rejects(
    readPullRequestFilesFromCheckout({ ...context, changedFiles: 0 }, root),
    /more files than the pull request metadata/u,
  );
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

test("aborts in-flight GitHub requests and blocks later writes", async (t) => {
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
  const api = new GitHubApi("test-token", `http://127.0.0.1:${address.port}`, controller.signal);
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
});

test("paginates files and conversation records and creates a review", async (t) => {
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
  const api = new GitHubApi("test-token", `${serverOrigin}/api/`);
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
