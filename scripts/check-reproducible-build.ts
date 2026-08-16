import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", windowsHide: true });
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

async function files(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) result.push(...(await files(root, path)));
    else result.push(relative(root, path));
  }
  return result.sort();
}

async function snapshot(root: string): Promise<ReadonlyMap<string, string>> {
  const result = new Map<string, string>();
  for (const path of await files(root))
    result.set(path, (await readFile(join(root, path))).toString("base64"));
  return result;
}

export async function verifyReproducibleBuild(
  cwd = process.cwd(),
  command = npmCommand,
): Promise<number> {
  const snapshotRoot = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-repro-"));
  try {
    await run(command, ["run", "build"], cwd);
    await cp(join(cwd, "build"), join(snapshotRoot, "first"), { recursive: true });
    const first = await snapshot(join(snapshotRoot, "first"));
    await run(command, ["run", "build"], cwd);
    const second = await snapshot(join(cwd, "build"));
    if (
      first.size !== second.size ||
      [...first].some(([path, content]) => second.get(path) !== content)
    ) {
      throw new Error("Compiled runtime is not reproducible between two builds.");
    }
    return first.size;
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
}

export const reproducibleBuildInternals = { files, run, snapshot };

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const count = await verifyReproducibleBuild();
  console.log(`Reproducible build verified for ${count} compiled files.`);
}
