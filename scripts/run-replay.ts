import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function prepareReplayRuntime(
  checkout: string,
  packageRoot = resolve(import.meta.dirname, ".."),
  temporaryRoot = tmpdir(),
): Promise<{ entry: string; cleanup: () => Promise<void> }> {
  const root = await realpath(checkout);
  const temporary = await realpath(temporaryRoot);
  const relativePath = relative(root, temporary);
  if (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  )
    throw new Error("Replay temporary directory must be outside the checkout.");
  const directory = await mkdtemp(join(temporary, "ai-pr-reviewer-replay-build-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const compiler = fileURLToPath(import.meta.resolve("typescript/lib/tsc.js"));
    await execFileAsync(
      process.execPath,
      [compiler, "-p", join(packageRoot, "tsconfig.replay.json"), "--outDir", directory],
      { cwd: packageRoot, encoding: "utf8" },
    );
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    await symlink(
      dirname(dirname(dirname(compiler))),
      join(directory, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    return { entry: join(directory, "scripts/replay-review.js"), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function runReplay(args = process.argv.slice(2)): Promise<void> {
  const index = args.indexOf("--checkout");
  const checkout = index < 0 ? undefined : args[index + 1];
  if (checkout === undefined || checkout.startsWith("--"))
    throw new Error(
      "Usage: npm run replay:review -- --case <json> --checkout <repo> --output <json>",
    );
  const runtime = await prepareReplayRuntime(resolve(checkout));
  try {
    const { runReplayCli } = (await import(pathToFileURL(runtime.entry).href)) as {
      runReplayCli: (args: string[]) => Promise<void>;
    };
    await runReplayCli(args);
  } finally {
    await runtime.cleanup();
  }
}

const entry = process.argv[1];
// Node 24.0 supports the launcher but predates import.meta.main.
const main = (import.meta as { main?: boolean }).main;
const directEntry =
  main ?? !process.execArgv.some((arg) => /^-(?:[ep]|-(?:eval|print)(?:=|$))/u.test(arg));
let entryPath: string | undefined;
if (directEntry && entry !== undefined) {
  try {
    entryPath = await realpath(entry);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      (error.code !== "ENOENT" && error.code !== "ENOTDIR")
    )
      throw error;
  }
}
if (entryPath !== undefined && entryPath === (await realpath(fileURLToPath(import.meta.url)))) {
  await runReplay();
}
