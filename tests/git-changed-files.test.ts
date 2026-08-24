import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { githubApiInternals, readPullRequestFilesFromCheckout } from "../src/lib/github-api.js";
import type { PullRequestContext } from "../src/lib/types.js";

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
  assert.equal(githubApiInternals.diffPath("+++ /dev/null"), undefined);
  assert.equal(githubApiInternals.diffPath('+++ "b/quoted.txt"'), "quoted.txt");
  assert.equal(githubApiInternals.diffPath("not a file header"), undefined);
  assert.equal(githubApiInternals.decodeGitPath('"a\\tb\\n\\"c\\\\d"'), 'a\tb\n"c\\d');
  assert.throws(
    () => githubApiInternals.decodeGitPath('"unterminated'),
    /unterminated quoted path/u,
  );
  assert.throws(() => githubApiInternals.decodeGitPath('"bad\\q"'), /invalid quoted path escape/u);
  assert.throws(() => githubApiInternals.decodeGitPath('"bad\\'), /unterminated quoted path/u);
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
  await assert.rejects(
    githubApiInternals.readGitMergeBase("/tmp", "a".repeat(40), "b".repeat(40)),
    /invalid pull request merge base/u,
  );

  await writeFile(
    gitPath,
    "#!/bin/sh\nprintf '%s\\n' '+++ b/file.txt'\nprintf '%s\\n' '@@ malformed'\n",
  );
  await assert.rejects(
    githubApiInternals.readGitAddedLines("/tmp", "a".repeat(40), "b".repeat(40)),
    /invalid changed-file hunk header/u,
  );

  await writeFile(
    gitPath,
    "#!/bin/sh\nprintf '%s\\n' 'diff --git a/file.txt b/file.txt' '+++ b/file.txt'\nprintf '%1000001s' ''\nsleep 1\nprintf marker > \"${0}.marker\"\n",
  );
  await assert.rejects(
    githubApiInternals.readGitAddedLines("/tmp", "a".repeat(40), "b".repeat(40)),
    /oversized changed-file diff line/u,
  );
  await assert.rejects(access(`${gitPath}.marker`));
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

test("pins unlimited rename detection for changed-file metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-rename-limit-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await git(root, ["init", "--quiet", "--initial-branch=main"]);
  await git(root, ["config", "diff.renameLimit", "1"]);
  for (let index = 1; index <= 3; index += 1) {
    await writeFile(
      join(root, `old-${index}.txt`),
      Array.from({ length: 10 }, (_, line) => `file-${index}-line-${line}\n`).join(""),
    );
  }
  const baseSha = await commit(root, "rename base");
  for (let index = 1; index <= 3; index += 1) {
    await execFileAsync("git", ["mv", `old-${index}.txt`, `new-${index}.txt`], { cwd: root });
    await writeFile(
      join(root, `new-${index}.txt`),
      Array.from({ length: 10 }, (_, line) =>
        line < 7 ? `file-${index}-line-${line}\n` : `changed-${index}-line-${line}\n`,
      ).join(""),
    );
  }
  const headSha = await commit(root, "rename head");

  const files = await readPullRequestFilesFromCheckout(
    {
      repository: "owner/repository",
      owner: "owner",
      name: "repository",
      number: 1,
      headSha,
      baseSha,
      baseRef: "main",
      changedFiles: 3,
      title: "Rename limit metadata",
      htmlUrl: "https://github.com/owner/repository/pull/1",
    },
    root,
  );
  assert.deepEqual(
    files.map((file) => ({
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
    })),
    [
      { path: "new-1.txt", previousPath: "old-1.txt", status: "renamed" },
      { path: "new-2.txt", previousPath: "old-2.txt", status: "renamed" },
      { path: "new-3.txt", previousPath: "old-3.txt", status: "renamed" },
    ],
  );
});

test("uses the captured merge base for changed-file metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-merge-base-files-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await git(root, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(root, "shared.txt"), "shared\n");
  const mergeBaseSha = await commit(root, "common ancestor");
  await git(root, ["switch", "--quiet", "--create", "pull-request"]);
  await writeFile(join(root, "feature.txt"), "feature\n");
  const headSha = await commit(root, "pull request change");
  await git(root, ["switch", "--quiet", "main"]);
  await writeFile(join(root, "base-only.txt"), "base branch change\n");
  const baseSha = await commit(root, "advance base branch");

  const files = await readPullRequestFilesFromCheckout(
    {
      repository: "owner/repository",
      owner: "owner",
      name: "repository",
      number: 1,
      headSha,
      baseSha,
      baseRef: "main",
      changedFiles: 1,
      title: "Merge-base metadata",
      htmlUrl: "https://github.com/owner/repository/pull/1",
    },
    root,
  );
  assert.deepEqual(
    files.map((file) => ({
      path: file.path,
      additions: file.additions,
      deletions: file.deletions,
    })),
    [{ path: "feature.txt", additions: 1, deletions: 0 }],
  );
  assert.equal(await githubApiInternals.readGitMergeBase(root, baseSha, headSha), mergeBaseSha);
});

test("uses the captured merge-base attributes for changed-file metadata", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-attribute-source-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await git(root, ["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(root, ".gitattributes"), "");
  await writeFile(join(root, "notes.txt"), "before\n");
  const baseSha = await commit(root, "base");
  await writeFile(join(root, ".gitattributes"), "*.txt -diff\n");
  await writeFile(join(root, "notes.txt"), "after\n");
  const headSha = await commit(root, "head attributes and text change");

  const files = await readPullRequestFilesFromCheckout(
    {
      repository: "owner/repository",
      owner: "owner",
      name: "repository",
      number: 1,
      headSha,
      baseSha,
      baseRef: "main",
      changedFiles: 2,
      title: "Attribute source metadata",
      htmlUrl: "https://github.com/owner/repository/pull/1",
    },
    root,
  );
  const notes = files.find((file) => file.path === "notes.txt");
  assert.ok(notes);
  assert.equal(notes.status, "modified");
  assert.equal(notes.additions, 1);
  assert.equal(notes.deletions, 1);
  assert.deepEqual([...notes.addedLines], [1]);
});

test("decodes quoted UTF-8 paths and pins diff prefixes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-quoted-path-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await git(root, ["init", "--quiet", "--initial-branch=main"]);
  await git(root, ["config", "core.quotePath", "true"]);
  await mkdir(join(root, "b"));
  await git(root, ["config", "diff.noprefix", "true"]);
  const path = "b/ümlaut.txt";
  await writeFile(join(root, path), "before\n");
  const baseSha = await commit(root, "base");
  await writeFile(join(root, path), "after\n");
  const headSha = await commit(root, "quoted path change");

  const files = await readPullRequestFilesFromCheckout(
    {
      repository: "owner/repository",
      owner: "owner",
      name: "repository",
      number: 1,
      headSha,
      baseSha,
      baseRef: "main",
      changedFiles: 1,
      title: "Quoted path metadata",
      htmlUrl: "https://github.com/owner/repository/pull/1",
    },
    root,
  );
  assert.equal(files.length, 1);
  assert.equal(files[0]?.path, path);
  assert.deepEqual([...(files[0]?.addedLines ?? [])], [1]);
  assert.equal(githubApiInternals.decodeGitPath('"b/\\303\\274mlaut.txt"'), path);
});

test("does not infer unchanged lines from merged zero-context hunks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-inter-hunk-context-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await git(root, ["init", "--quiet", "--initial-branch=main"]);
  await git(root, ["config", "diff.interHunkContext", "1"]);
  await writeFile(join(root, "lines.txt"), "one\ntwo\nthree\nfour\n");
  const baseSha = await commit(root, "base");
  await writeFile(join(root, "lines.txt"), "ONE\ntwo\nTHREE\nfour\n");
  const headSha = await commit(root, "two separated changes");

  const files = await readPullRequestFilesFromCheckout(
    {
      repository: "owner/repository",
      owner: "owner",
      name: "repository",
      number: 1,
      headSha,
      baseSha,
      baseRef: "main",
      changedFiles: 1,
      title: "Inter-hunk context",
      htmlUrl: "https://github.com/owner/repository/pull/1",
    },
    root,
  );
  assert.deepEqual([...(files[0]?.addedLines ?? [])], [1, 3]);
});
