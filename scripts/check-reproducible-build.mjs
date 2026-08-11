import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const snapshotRoot = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-repro-"));

async function files(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...(await files(root, path)));
    else result.push(relative(root, path));
  }
  return result.sort();
}

async function snapshot(root) {
  const result = new Map();
  for (const path of await files(root))
    result.set(path, (await readFile(join(root, path))).toString("base64"));
  return result;
}

await execFileAsync(npmCommand, ["run", "build"], { stdio: "inherit" });
await cp("build", join(snapshotRoot, "first"), { recursive: true });
const first = await snapshot(join(snapshotRoot, "first"));
await execFileAsync(npmCommand, ["run", "build"], { stdio: "inherit" });
const second = await snapshot("build");
if (
  first.size !== second.size ||
  [...first].some(([path, content]) => second.get(path) !== content)
) {
  await rm(snapshotRoot, { recursive: true, force: true });
  throw new Error("Compiled runtime is not reproducible between two builds.");
}
await rm(snapshotRoot, { recursive: true, force: true });
console.log(`Reproducible build verified for ${first.size} compiled files.`);
