import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { throwIfAborted } from "./bootstrap/cancellation.js";
import type { PullRequestContext } from "./types.js";

const execFileAsync = promisify(execFile);
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;

export interface PullRequestWorkspace {
  readonly path: string;
  cleanup(): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function remoteUrl(context: PullRequestContext, serverUrl: string): string {
  const server = new URL(serverUrl);
  if (server.protocol !== "https:" && server.protocol !== "http:") {
    throw new Error("GITHUB_SERVER_URL must use http:// or https://.");
  }
  if (server.username !== "" || server.password !== "") {
    throw new Error("GITHUB_SERVER_URL must not contain URL credentials.");
  }
  return `${server.origin}/${context.owner}/${context.name}.git`;
}

function gitEnvironment(
  token: string,
  repositoryUrl: string,
  globalConfigPath: string,
  hooksPath: string,
): NodeJS.ProcessEnv {
  const protocol = new URL(repositoryUrl).protocol.replace(/:$/, "");
  if (!/^[a-z][a-z0-9+.-]*$/i.test(protocol)) {
    throw new Error("The pull request Git remote uses an invalid protocol.");
  }
  const authorization = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  const config: ReadonlyArray<readonly [string, string]> = [
    ["credential.helper", ""],
    [`http.${repositoryUrl}.extraHeader`, `AUTHORIZATION: basic ${authorization}`],
    ["http.followRedirects", "false"],
    ["protocol.allow", "never"],
    [`protocol.${protocol}.allow`, "always"],
    ["submodule.recurse", "false"],
    ["core.hooksPath", hooksPath],
    ["core.fsmonitor", "false"],
    ["filter.lfs.smudge", ""],
    ["filter.lfs.required", "false"],
  ];
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfigPath,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_CONFIG_COUNT: String(config.length),
  };
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toUpperCase();
    if (
      normalizedKey.startsWith("GIT_CONFIG_KEY_") ||
      normalizedKey.startsWith("GIT_CONFIG_VALUE_") ||
      normalizedKey.startsWith("GIT_TRACE") ||
      [
        "GIT_CURL_VERBOSE",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_ASKPASS",
        "GIT_COMMON_DIR",
        "GIT_CONFIG",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_SYSTEM",
        "GIT_DIR",
        "GIT_EXEC_PATH",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_PROXY_COMMAND",
        "GIT_REDIRECT_STDERR",
        "GIT_SSH",
        "GIT_SSH_COMMAND",
        "GIT_TEMPLATE_DIR",
        "GIT_WORK_TREE",
        "SSH_ASKPASS",
      ].includes(normalizedKey)
    ) {
      Reflect.deleteProperty(environment, key);
    }
  }
  environment.GIT_ATTR_NOSYSTEM = "1";
  config.forEach(([key, value], index) => {
    environment[`GIT_CONFIG_KEY_${index}`] = key;
    environment[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return environment;
}

function isWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath.length === 0 ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith(sep))
  );
}

async function git(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      env: environment,
      encoding: "utf8",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    throwIfAborted(signal);
    return stdout.trim();
  } catch (error) {
    throwIfAborted(signal);
    throw new Error(`Git ${args[0] ?? "command"} failed: ${errorMessage(error)}`);
  }
}

async function exactCommit(
  cwd: string,
  ref: string,
  expected: string,
  label: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  if (!COMMIT_SHA_PATTERN.test(expected)) throw new Error(`${label} is not a full commit SHA.`);
  const resolved = await git(
    cwd,
    ["rev-parse", "--verify", `${ref}^{commit}`],
    environment,
    signal,
  );
  if (!COMMIT_SHA_PATTERN.test(resolved) || resolved.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`${label} ${resolved || "did not resolve"} does not match ${expected}.`);
  }
}

async function createFromRemote(
  context: PullRequestContext,
  token: string,
  repositoryUrl: string,
  temporaryRoot: string,
  signal?: AbortSignal,
): Promise<PullRequestWorkspace> {
  throwIfAborted(signal);
  if (!COMMIT_SHA_PATTERN.test(context.baseSha)) {
    throw new Error("Pull request base is not a full commit SHA.");
  }
  if (!COMMIT_SHA_PATTERN.test(context.headSha)) {
    throw new Error("Pull request head is not a full commit SHA.");
  }
  const resolvedTemporaryRoot = await realpath(temporaryRoot);
  throwIfAborted(signal);
  const root = await mkdtemp(join(resolvedTemporaryRoot, "ai-pr-reviewer-checkout-"));
  const repositoryPath = join(root, "repository");
  const globalConfigPath = join(root, "global.gitconfig");
  const hooksPath = join(root, "hooks");
  try {
    throwIfAborted(signal);
    await Promise.all([
      mkdir(repositoryPath, { mode: 0o700 }),
      mkdir(hooksPath, { mode: 0o700 }),
      writeFile(globalConfigPath, "", { mode: 0o600 }),
    ]);
    const environment = gitEnvironment(token, repositoryUrl, globalConfigPath, hooksPath);
    await git(repositoryPath, ["init", "--quiet"], environment, signal);
    await git(
      repositoryPath,
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        repositoryUrl,
        `+${context.baseSha}:refs/ai-pr-reviewer/base`,
        `+${context.headSha}:refs/ai-pr-reviewer/head`,
      ],
      environment,
      signal,
    );
    await exactCommit(
      repositoryPath,
      "refs/ai-pr-reviewer/base",
      context.baseSha,
      "Fetched pull request base",
      environment,
      signal,
    );
    await exactCommit(
      repositoryPath,
      "refs/ai-pr-reviewer/head",
      context.headSha,
      "Fetched pull request head",
      environment,
      signal,
    );
    await git(
      repositoryPath,
      ["checkout", "--quiet", "--detach", "refs/ai-pr-reviewer/head"],
      environment,
      signal,
    );
    return {
      path: repositoryPath,
      cleanup: () => rm(root, { force: true, recursive: true }),
    };
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

export async function createPullRequestWorkspace(
  context: PullRequestContext,
  token: string,
  serverUrl: string | undefined = process.env.GITHUB_SERVER_URL,
  temporaryRoot: string = process.env.RUNNER_TEMP?.trim() || tmpdir(),
  signal?: AbortSignal,
): Promise<PullRequestWorkspace> {
  throwIfAborted(signal);
  if (!serverUrl) throw new Error("GITHUB_SERVER_URL is not set.");
  const callerWorkspace = process.env.GITHUB_WORKSPACE?.trim();
  if (callerWorkspace) {
    const [resolvedCallerWorkspace, resolvedTemporaryRoot] = await Promise.all([
      realpath(callerWorkspace),
      realpath(temporaryRoot),
    ]);
    throwIfAborted(signal);
    if (isWithin(resolvedCallerWorkspace, resolvedTemporaryRoot)) {
      throw new Error("The temporary checkout directory must be outside GITHUB_WORKSPACE.");
    }
  }
  return createFromRemote(context, token, remoteUrl(context, serverUrl), temporaryRoot, signal);
}

export const pullRequestWorkspaceInternals = {
  createFromRemote,
  exactCommit,
  gitEnvironment,
  isWithin,
  remoteUrl,
};
