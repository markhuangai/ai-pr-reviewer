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

async function changedCommit(
  root: string,
  parent: string,
  paths: readonly string[],
): Promise<string> {
  const payload = join(root, "test-payload");
  await writeFile(payload, "changed release fixture\n");
  const blob = await git(root, "hash-object", "-w", payload);
  await git(root, "read-tree", parent);
  for (const path of paths)
    await git(root, "update-index", "--add", "--cacheinfo", "100644", blob, path);
  const tree = await git(root, "write-tree");
  return git(
    root,
    "-c",
    "user.name=Release source test",
    "-c",
    "user.email=release-test@example.invalid",
    "commit-tree",
    tree,
    "-p",
    parent,
    "-m",
    "Release source fixture",
  );
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
  const { root, temporary, headSha } = await repository();
  try {
    await git(root, "tag", "v1.0.0-rc.0", headSha);
    const stable = await changedCommit(root, headSha, ["src/runtime/index.ts"]);
    await assert.rejects(
      verifyReleaseSource("v1.0.0-rc.0", stable, root),
      /does not have the same runtime source/i,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("accepts release policy changes while retaining the RC runtime provenance", async (t) => {
  const { root, temporary, headSha } = await repository();
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await git(root, "tag", "v1.1.9-rc.2", headSha);
  const stable = await changedCommit(root, headSha, [
    ".github/workflows/release.yml",
    "README.md",
    "scripts/validate-release.ts",
    "scripts/verify-release-source.ts",
    "src/lib/bootstrap/version.ts",
    "dist/lib/bootstrap/version.js",
    "tests/bootstrap.test.ts",
    "tests/release.test.ts",
    "tests/release-source.test.ts",
  ]);
  assert.notEqual(
    await git(root, "rev-parse", `${stable}^{tree}`),
    await git(root, "rev-parse", `${headSha}^{tree}`),
  );
  assert.deepEqual(await verifyReleaseSource("v1.1.9-rc.2", stable, root), {
    sourceCommit: headSha,
    tree: await git(root, "rev-parse", `${headSha}^{tree}`),
  });
});

test("rejects changes to runtime code, dependencies, action metadata, and build configuration", async (t) => {
  const { root, temporary, headSha } = await repository();
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await git(root, "tag", "v1.1.9-rc.2", headSha);
  for (const path of [
    "src/index.ts",
    "src/lib/bootstrap/cancellation.ts",
    "src/bootstrap.ts",
    "dist/bootstrap.js",
    "action.yml",
    "package.json",
    "package-lock.json",
    "tsconfig.build.json",
    "scripts/prepare-runtime.ts",
  ]) {
    const stable = await changedCommit(root, headSha, ["README.md", path]);
    await assert.rejects(verifyReleaseSource("v1.1.9-rc.2", stable, root), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(path));
      return true;
    });
  }
});

test("rejects source references that are not exact RC tags", async () => {
  for (const tag of ["main", "v1.1.9", "v1-prerelease"])
    await assert.rejects(verifyReleaseSource(tag, "HEAD"), /exact vX.Y.Z-rc.N tag/u);
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
