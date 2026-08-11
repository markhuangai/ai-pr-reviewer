import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const snapshotRoot = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-repro-"));

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true });
    let settled = false;
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else
        reject(new Error(`${command} ${args.join(" ")} failed (${code ?? signal ?? "unknown"}).`));
    });
  });
}

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

await run(npmCommand, ["run", "build"]);
await cp("build", join(snapshotRoot, "first"), { recursive: true });
const first = await snapshot(join(snapshotRoot, "first"));
await run(npmCommand, ["run", "build"]);
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
