import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { verifyReleaseSource } from "../scripts/verify-release-source.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-release-source-"));
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.name", "Release Test");
  await git(root, "config", "user.email", "release-test@example.com");
  await writeFile(join(root, "action.txt"), "release candidate\n");
  await git(root, "add", "action.txt");
  await git(root, "commit", "-m", "release candidate");
  await git(root, "tag", "v1.0.0-rc.0");
  return root;
}

test("accepts an ancestor release candidate with an identical tree", async () => {
  const root = await repository();
  try {
    await git(root, "commit", "--allow-empty", "-m", "promote release candidate");
    const result = await verifyReleaseSource("v1.0.0-rc.0", "HEAD", root);
    assert.equal(result.sourceCommit, await git(root, "rev-parse", "v1.0.0-rc.0"));
    assert.equal(result.tree, await git(root, "rev-parse", "HEAD^{tree}"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects source changes after the release candidate", async () => {
  const root = await repository();
  try {
    await writeFile(join(root, "action.txt"), "stable changed\n");
    await git(root, "add", "action.txt");
    await git(root, "commit", "-m", "change stable source");
    await assert.rejects(
      verifyReleaseSource("v1.0.0-rc.0", "HEAD", root),
      /does not have the same Git tree/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a matching tree without release-candidate ancestry", async () => {
  const root = await repository();
  try {
    const tree = await git(root, "rev-parse", "HEAD^{tree}");
    const unrelated = await git(root, "commit-tree", tree, "-m", "unrelated stable commit");
    await assert.rejects(
      verifyReleaseSource("v1.0.0-rc.0", unrelated, root),
      /is not an ancestor/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
