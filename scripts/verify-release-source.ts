import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const RC_TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rc\.(0|[1-9][0-9]*)$/;

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  return stdout.trim();
}

export async function verifyReleaseSource(
  sourceRcTag: string,
  stableCommit: string,
  cwd = process.cwd(),
): Promise<{ readonly sourceCommit: string; readonly tree: string }> {
  if (!RC_TAG_PATTERN.test(sourceRcTag)) {
    throw new Error("Source release candidate must be an exact vX.Y.Z-rc.N tag.");
  }
  const sourceCommit = await git(["rev-parse", "--verify", `${sourceRcTag}^{commit}`], cwd);
  const resolvedStableCommit = await git(
    ["rev-parse", "--verify", `${stableCommit}^{commit}`],
    cwd,
  );
  try {
    await git(["merge-base", "--is-ancestor", sourceCommit, resolvedStableCommit], cwd);
  } catch {
    throw new Error(`${sourceRcTag} is not an ancestor of ${stableCommit}.`);
  }
  const sourceTree = await git(["rev-parse", `${sourceCommit}^{tree}`], cwd);
  const stableTree = await git(["rev-parse", `${resolvedStableCommit}^{tree}`], cwd);
  if (sourceTree !== stableTree) {
    throw new Error(`${stableCommit} does not have the same Git tree as ${sourceRcTag}.`);
  }
  return { sourceCommit, tree: sourceTree };
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`Missing required ${name} argument.`);
  return value;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const result = await verifyReleaseSource(
    argument("--source-rc-tag"),
    argument("--stable-commit"),
  );
  process.stdout.write(JSON.stringify(result));
}
