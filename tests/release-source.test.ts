import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

async function repository(): Promise<{
  readonly root: string;
  readonly temporary: string;
  readonly headSha: string;
  readonly ancestors: readonly string[];
}> {
  const temporary = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-release-source-"));
  const root = join(temporary, "repository.git");
  await git(temporary, "clone", "--quiet", "--bare", "--shared", "--no-tags", process.cwd(), root);
  const ancestors = (await git(root, "rev-list", "HEAD")).split("\n");
  const headSha = ancestors[0];
  if (headSha === undefined) throw new Error("The source checkout must contain a commit.");
  return { root, temporary, headSha, ancestors };
}

test("accepts a release candidate at the stable commit with an identical tree", async () => {
  const { root, temporary, headSha } = await repository();
  try {
    await git(root, "tag", "v1.0.0-rc.0", headSha);
    const result = await verifyReleaseSource("v1.0.0-rc.0", headSha, root);
    assert.equal(result.sourceCommit, await git(root, "rev-parse", "v1.0.0-rc.0"));
    assert.equal(result.tree, await git(root, "rev-parse", `${headSha}^{tree}`));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rejects source changes after the release candidate", async () => {
  const { root, temporary, headSha, ancestors } = await repository();
  try {
    const headTree = await git(root, "rev-parse", `${headSha}^{tree}`);
    let releaseCandidate: string | undefined;
    for (const ancestor of ancestors.slice(1)) {
      if ((await git(root, "rev-parse", `${ancestor}^{tree}`)) !== headTree) {
        releaseCandidate = ancestor;
        break;
      }
    }
    assert.ok(releaseCandidate, "the source history must contain a distinct ancestor tree");
    await git(root, "tag", "v1.0.0-rc.0", releaseCandidate);
    await assert.rejects(
      verifyReleaseSource("v1.0.0-rc.0", headSha, root),
      /does not have the same Git tree/i,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("rejects a stable commit that predates the release candidate", async () => {
  const { root, temporary, headSha, ancestors } = await repository();
  try {
    const priorCommit = ancestors[1];
    assert.ok(priorCommit, "the source checkout must contain a parent commit");
    await git(root, "tag", "v1.0.0-rc.0", headSha);
    await assert.rejects(
      verifyReleaseSource("v1.0.0-rc.0", priorCommit, root),
      /is not an ancestor/i,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
