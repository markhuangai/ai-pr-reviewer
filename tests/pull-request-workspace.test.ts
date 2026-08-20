import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

import {
  createPullRequestWorkspace,
  pullRequestWorkspaceInternals,
} from "../src/lib/pull-request-workspace.js";
import type { PullRequestContext } from "../src/lib/types.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "."]);
  await git(cwd, [
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--quiet",
    `--message=${message}`,
  ]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

async function makePullRequestRemote(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-remote-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  const temporary = join(root, "temporary");
  await Promise.all([mkdir(source), mkdir(temporary)]);
  await git(source, ["init", "--quiet", "--initial-branch=main"]);
  await git(root, ["init", "--quiet", "--bare", remote]);
  await writeFile(join(source, "review.txt"), "base\n");
  const baseSha = await commit(source, "base");
  await git(source, ["push", "--quiet", remote, "HEAD:refs/heads/main"]);
  await git(source, ["switch", "--quiet", "--create", "pull-request"]);
  await writeFile(join(source, "review.txt"), "head\n");
  const headSha = await commit(source, "head");
  await git(source, ["push", "--quiet", remote, "HEAD:refs/pull/7/head"]);
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 7,
    headSha,
    baseSha,
    baseRef: "main",
    title: "Change",
    htmlUrl: "https://github.com/owner/repository/pull/7",
  };
  return { context, remote, source, temporary };
}

async function advanceBase(fixture: Awaited<ReturnType<typeof makePullRequestRemote>>) {
  await git(fixture.source, ["switch", "--quiet", "main"]);
  await writeFile(join(fixture.source, "base-tip.txt"), "advanced base\n");
  const sha = await commit(fixture.source, "advance base");
  await git(fixture.source, ["push", "--quiet", fixture.remote, "HEAD:refs/heads/main"]);
  return sha;
}

async function advanceHead(fixture: Awaited<ReturnType<typeof makePullRequestRemote>>) {
  await git(fixture.source, ["switch", "--quiet", "pull-request"]);
  await writeFile(join(fixture.source, "review.txt"), "new head\n");
  const sha = await commit(fixture.source, "advance head");
  await git(fixture.source, ["push", "--quiet", fixture.remote, "HEAD:refs/pull/7/head"]);
  return sha;
}

test("fetches exact pull request refs into an isolated credential-free checkout", async (t) => {
  const fixture = await makePullRequestRemote(t);
  const workspace = await pullRequestWorkspaceInternals.createFromRemote(
    fixture.context,
    "github-secret",
    pathToFileURL(fixture.remote).href,
    fixture.temporary,
  );
  assert.equal(await git(workspace.path, ["rev-parse", "HEAD"]), fixture.context.headSha);
  assert.equal(
    await git(workspace.path, ["rev-parse", "refs/ai-pr-reviewer/base"]),
    fixture.context.baseSha,
  );
  assert.equal(await git(workspace.path, ["status", "--porcelain", "--ignored"]), "");
  assert.equal(await git(workspace.path, ["remote"]), "");
  assert.equal(
    await git(workspace.path, [
      "config",
      "--local",
      "--get-regexp",
      "credential|extraheader",
    ]).catch(() => ""),
    "",
  );
  const root = join(workspace.path, "..");
  await workspace.cleanup();
  await assert.rejects(access(root));
});

test("pins the API base after the live base branch advances", async (t) => {
  const fixture = await makePullRequestRemote(t);
  const liveBaseSha = await advanceBase(fixture);
  assert.notEqual(liveBaseSha, fixture.context.baseSha);

  const workspace = await pullRequestWorkspaceInternals.createFromRemote(
    fixture.context,
    "github-secret",
    pathToFileURL(fixture.remote).href,
    fixture.temporary,
  );
  assert.equal(await git(workspace.path, ["rev-parse", "HEAD"]), fixture.context.headSha);
  assert.equal(
    await git(workspace.path, ["rev-parse", "refs/ai-pr-reviewer/base"]),
    fixture.context.baseSha,
  );
  assert.equal(await readFile(join(workspace.path, "review.txt"), "utf8"), "head\n");
  await workspace.cleanup();
});

test("pins the API head after the pull request ref advances", async (t) => {
  const fixture = await makePullRequestRemote(t);
  const liveHeadSha = await advanceHead(fixture);
  assert.notEqual(liveHeadSha, fixture.context.headSha);

  const workspace = await pullRequestWorkspaceInternals.createFromRemote(
    fixture.context,
    "github-secret",
    pathToFileURL(fixture.remote).href,
    fixture.temporary,
  );
  assert.equal(await git(workspace.path, ["rev-parse", "HEAD"]), fixture.context.headSha);
  assert.equal(
    await git(workspace.path, ["rev-parse", "refs/ai-pr-reviewer/head"]),
    fixture.context.headSha,
  );
  assert.equal(await readFile(join(workspace.path, "review.txt"), "utf8"), "head\n");
  await workspace.cleanup();
});

test("retains the exact fetched commit assertion", async (t) => {
  const fixture = await makePullRequestRemote(t);
  const globalConfigPath = join(fixture.temporary, "global.gitconfig");
  const hooksPath = join(fixture.temporary, "hooks");
  await Promise.all([mkdir(hooksPath), writeFile(globalConfigPath, "")]);
  const environment = pullRequestWorkspaceInternals.gitEnvironment(
    "github-secret",
    pathToFileURL(fixture.remote).href,
    globalConfigPath,
    hooksPath,
  );
  await assert.rejects(
    pullRequestWorkspaceInternals.exactCommit(
      fixture.source,
      "HEAD",
      fixture.context.baseSha,
      "Fetched pull request head",
      environment,
    ),
    /does not match/u,
  );
});

test("removes a temporary checkout when an API snapshot commit is unavailable", async (t) => {
  const fixture = await makePullRequestRemote(t);
  await assert.rejects(
    pullRequestWorkspaceInternals.createFromRemote(
      { ...fixture.context, headSha: "f".repeat(40) },
      "github-secret",
      pathToFileURL(fixture.remote).href,
      fixture.temporary,
    ),
    /Git fetch failed/u,
  );
  assert.deepEqual(await readdir(fixture.temporary), []);
});

test("sanitizes inherited Git repository and transport controls", () => {
  const previous = {
    directory: process.env.GIT_DIR,
    traceCurl: process.env.GIT_TRACE_CURL,
    curlVerbose: process.env.GIT_CURL_VERBOSE,
  };
  process.env.GIT_DIR = "/tmp/untrusted-git-dir";
  process.env.GIT_TRACE_CURL = "1";
  process.env.GIT_CURL_VERBOSE = "1";
  try {
    const environment = pullRequestWorkspaceInternals.gitEnvironment(
      "github-secret",
      "https://github.com/owner/repository.git",
      "/tmp/global.gitconfig",
      "/tmp/hooks",
    );
    assert.equal(environment.GIT_DIR, undefined);
    assert.equal(environment.GIT_TRACE_CURL, undefined);
    assert.equal(environment.GIT_CURL_VERBOSE, undefined);
    assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
    assert.equal(environment.GIT_CONFIG_GLOBAL, "/tmp/global.gitconfig");
    assert.equal(
      Object.values(environment).some((value) => value === "github-secret"),
      false,
    );
  } finally {
    if (previous.directory === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = previous.directory;
    if (previous.traceCurl === undefined) delete process.env.GIT_TRACE_CURL;
    else process.env.GIT_TRACE_CURL = previous.traceCurl;
    if (previous.curlVerbose === undefined) delete process.env.GIT_CURL_VERBOSE;
    else process.env.GIT_CURL_VERBOSE = previous.curlVerbose;
  }
});

test("validates server URLs and workspace boundaries", async (t) => {
  const fixture = await makePullRequestRemote(t);
  assert.equal(
    pullRequestWorkspaceInternals.remoteUrl(
      fixture.context,
      "https://github.example.test/ignored/path/",
    ),
    "https://github.example.test/owner/repository.git",
  );
  assert.throws(
    () => pullRequestWorkspaceInternals.remoteUrl(fixture.context, "ftp://example.test"),
    /must use http/u,
  );
  assert.throws(
    () =>
      pullRequestWorkspaceInternals.remoteUrl(fixture.context, "https://user:pass@example.test"),
    /must not contain URL credentials/u,
  );
  assert.equal(pullRequestWorkspaceInternals.isWithin("/workspace", "/workspace"), true);
  assert.equal(pullRequestWorkspaceInternals.isWithin("/workspace", "/workspace/child"), true);
  assert.equal(pullRequestWorkspaceInternals.isWithin("/workspace", "/other"), false);
  await assert.rejects(
    createPullRequestWorkspace(fixture.context, "token", "", fixture.temporary),
    /GITHUB_SERVER_URL is not set/u,
  );

  const caller = join(fixture.temporary, "caller");
  const nestedTemporary = join(caller, "temporary");
  await mkdir(nestedTemporary, { recursive: true });
  const previousWorkspace = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = caller;
  try {
    await assert.rejects(
      createPullRequestWorkspace(fixture.context, "token", "https://github.com", nestedTemporary),
      /must be outside GITHUB_WORKSPACE/u,
    );
  } finally {
    if (previousWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previousWorkspace;
  }
});

test("removes partial workspaces for invalid SHAs and Git failures", async (t) => {
  const fixture = await makePullRequestRemote(t);
  await assert.rejects(
    pullRequestWorkspaceInternals.createFromRemote(
      { ...fixture.context, baseSha: fixture.context.baseSha.slice(0, 12) },
      "token",
      pathToFileURL(fixture.remote).href,
      fixture.temporary,
    ),
    /not a full commit SHA/u,
  );
  await assert.rejects(
    pullRequestWorkspaceInternals.createFromRemote(
      fixture.context,
      "token",
      pathToFileURL(join(fixture.temporary, "missing.git")).href,
      fixture.temporary,
    ),
    /Git fetch failed/u,
  );
  assert.deepEqual(await readdir(fixture.temporary), []);
});

test("removes inherited numbered Git configuration", () => {
  const previousKey = process.env.GIT_CONFIG_KEY_99;
  const previousValue = process.env.GIT_CONFIG_VALUE_99;
  process.env.GIT_CONFIG_KEY_99 = "core.hooksPath";
  process.env.GIT_CONFIG_VALUE_99 = "/tmp/untrusted";
  try {
    const environment = pullRequestWorkspaceInternals.gitEnvironment(
      "token",
      "https://github.com/owner/repository.git",
      "/tmp/global.gitconfig",
      "/tmp/hooks",
    );
    assert.equal(environment.GIT_CONFIG_KEY_99, undefined);
    assert.equal(environment.GIT_CONFIG_VALUE_99, undefined);
    assert.equal(environment.GIT_CONFIG_COUNT, "10");
  } finally {
    if (previousKey === undefined) delete process.env.GIT_CONFIG_KEY_99;
    else process.env.GIT_CONFIG_KEY_99 = previousKey;
    if (previousValue === undefined) delete process.env.GIT_CONFIG_VALUE_99;
    else process.env.GIT_CONFIG_VALUE_99 = previousValue;
  }
});
