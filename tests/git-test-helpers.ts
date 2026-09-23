import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

import type { PullRequestContext } from "../src/lib/types.js";
import { PullRequestDiffArtifact } from "../src/runtime/agent-review-tools.js";
import { streamGitToFile } from "../src/runtime/git-stream.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, encoding: "utf8" });
  return stdout.trim();
}

export async function makeExistingCommitRepository(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-agent-history-test-"));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const root = join(parent, "repository");
  const temporaryRoot = join(parent, "temporary");
  await mkdir(temporaryRoot);
  await git(parent, ["clone", "--quiet", "--shared", process.cwd(), root]);
  const headSha = await git(process.cwd(), ["rev-parse", "HEAD"]);
  await git(root, ["checkout", "--quiet", "--detach", headSha]);
  const baseSha = await git(root, ["rev-parse", "HEAD^"]);
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 1,
    baseSha,
    headSha,
    baseRef: "main",
    title: "Existing commit history",
    htmlUrl: "https://github.com/owner/repository/pull/1",
  };
  return { root, temporaryRoot, baseSha, headSha, context };
}

export async function makeDiffFromSnapshots(
  cwd: string,
  mergeBaseSha: string,
  headSha: string,
  temporaryRoot: string,
): Promise<PullRequestDiffArtifact> {
  const directory = await mkdtemp(join(temporaryRoot, "ai-pr-reviewer-diff-test-"));
  const path = join(directory, "pull-request.diff");
  try {
    await streamGitToFile(
      cwd,
      [
        `--attr-source=${mergeBaseSha}`,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--full-index",
        mergeBaseSha,
        headSha,
        "--",
      ],
      path,
      "Git diff",
    );
    const { size } = await stat(path);
    return new PullRequestDiffArtifact(mergeBaseSha, path, size, directory);
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}
