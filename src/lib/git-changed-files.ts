import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import { cancellationReason, throwIfAborted } from "./bootstrap/cancellation.js";
import type { ChangedFile, PullRequestContext } from "./types.js";

const execFileAsync = promisify(execFile);
const MAX_LOCAL_CHANGED_FILES = 3_000;
const MAX_LOCAL_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_LOCAL_DIFF_LINE_BYTES = 1_000_000;
const MAX_LOCAL_ADDED_LINES_PER_FILE = 1_000_000;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

interface GitFileNameStatus {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: string;
}

interface GitFileNumstat {
  readonly additions: number;
  readonly deletions: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nulTokens(value: string): string[] {
  const tokens = value.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  return tokens;
}

export function decodeGitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"') || value.length < 2) {
    throw new Error("Git returned an unterminated quoted path.");
  }
  const bytes: number[] = [];
  for (let index = 1; index < value.length - 1;) {
    const character = value[index];
    if (character !== "\\") {
      if (character === undefined) throw new Error("Git returned an invalid quoted path.");
      const codePoint = value.codePointAt(index);
      if (codePoint === undefined) throw new Error("Git returned an invalid quoted path.");
      bytes.push(...Buffer.from(String.fromCodePoint(codePoint), "utf8"));
      index += String.fromCodePoint(codePoint).length;
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) throw new Error("Git returned an invalid quoted path escape.");
    const escapes: Readonly<Record<string, number>> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '"': 0x22,
      "\\": 0x5c,
    };
    const byte = escapes[escaped];
    if (byte !== undefined) {
      bytes.push(byte);
      index += 2;
      continue;
    }
    const octal = value.slice(index + 1, index + 4);
    if (!/^[0-7]{3}$/u.test(octal)) {
      throw new Error("Git returned an invalid quoted path escape.");
    }
    bytes.push(Number.parseInt(octal, 8));
    index += 4;
  }
  return Buffer.from(bytes).toString("utf8");
}

function gitFileStatus(code: string): string {
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "removed";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "modified";
  }
}

export function parseGitNameStatus(value: string): readonly GitFileNameStatus[] {
  const tokens = nulTokens(value);
  const files: GitFileNameStatus[] = [];
  let index = 0;
  while (index < tokens.length) {
    const statusToken = tokens[index];
    index += 1;
    if (statusToken === undefined || statusToken.length === 0) {
      throw new Error("Git returned an invalid changed-file status.");
    }
    const code = statusToken[0];
    if (code === undefined) throw new Error("Git returned an invalid changed-file status.");
    const firstPath = tokens[index];
    index += 1;
    if (firstPath === undefined || firstPath.length === 0) {
      throw new Error("Git returned an invalid changed-file path.");
    }
    if (code === "R" || code === "C") {
      const path = tokens[index];
      index += 1;
      if (path === undefined || path.length === 0) {
        throw new Error("Git returned an invalid changed-file rename path.");
      }
      files.push({ path, previousPath: firstPath, status: gitFileStatus(code) });
    } else {
      files.push({ path: firstPath, status: gitFileStatus(code) });
    }
    if (files.length > MAX_LOCAL_CHANGED_FILES) {
      throw new Error("Git returned more than the pull request file limit.");
    }
  }
  return files;
}

function gitCount(value: string, label: string): number {
  if (value === "-") return 0;
  if (!/^\d+$/u.test(value)) throw new Error(`Git returned an invalid ${label} count.`);
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error(`Git returned an invalid ${label} count.`);
  return count;
}

export function parseGitNumstat(
  value: string,
  files: readonly GitFileNameStatus[],
): readonly GitFileNumstat[] {
  const tokens = nulTokens(value);
  const counts: GitFileNumstat[] = [];
  let index = 0;
  for (const file of files) {
    const record = tokens[index];
    index += 1;
    if (record === undefined) {
      throw new Error("Git returned incomplete changed-file counts.");
    }
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab < 1 || secondTab < firstTab + 2) {
      throw new Error("Git returned invalid changed-file counts.");
    }
    const additionsToken = record.slice(0, firstTab);
    const deletionsToken = record.slice(firstTab + 1, secondTab);
    const firstPath = record.slice(secondTab + 1);
    const additions = gitCount(additionsToken, "addition");
    const deletions = gitCount(deletionsToken, "deletion");
    if (file.previousPath !== undefined) {
      if (firstPath.length !== 0) throw new Error("Git returned an invalid changed-file path.");
      const previousPath = tokens[index];
      const path = tokens[index + 1];
      index += 2;
      if (previousPath !== file.previousPath || path !== file.path) {
        throw new Error("Git returned inconsistent changed-file paths.");
      }
    } else {
      if (firstPath.length === 0) throw new Error("Git returned an invalid changed-file path.");
      if (firstPath !== file.path) throw new Error("Git returned inconsistent changed-file paths.");
    }
    if (additions > Number.MAX_SAFE_INTEGER - deletions) {
      throw new Error("Git returned oversized changed-file counts.");
    }
    counts.push({ additions, deletions });
  }
  if (index !== tokens.length) throw new Error("Git returned extra changed-file counts.");
  return counts;
}

export function diffPath(line: string): string | undefined {
  if (!line.startsWith("+++ ")) return undefined;
  const path = decodeGitPath(line.slice(4));
  if (path === "/dev/null") return undefined;
  return path.startsWith("b/") ? path.slice(2) : path;
}

export async function readGitMergeBase(
  cwd: string,
  baseSha: string,
  headSha: string,
  signal?: AbortSignal,
): Promise<string> {
  const mergeBaseSha = (
    await readGitMetadata(cwd, ["merge-base", baseSha, headSha], signal)
  ).trim();
  if (!COMMIT_SHA_PATTERN.test(mergeBaseSha)) {
    throw new Error("Git returned an invalid pull request merge base.");
  }
  return mergeBaseSha;
}

export async function readGitAddedLines(
  cwd: string,
  mergeBaseSha: string,
  headSha: string,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, ReadonlySet<number>>> {
  throwIfAborted(signal);
  const child = spawn(
    "git",
    [
      `--attr-source=${mergeBaseSha}`,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--find-renames=50%",
      "-l0",
      "--inter-hunk-context=0",
      "--unified=0",
      mergeBaseSha,
      headSha,
      "--",
    ],
    {
      cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const decoder = new StringDecoder("utf8");
  const addedLines = new Map<string, Set<number>>();
  let pending = "";
  let stderr = "";
  let currentPath: string | undefined;
  let fileHeaderRead = false;
  let settled = false;
  const consumeLine = (line: string): void => {
    if (line.length > MAX_LOCAL_DIFF_LINE_BYTES) {
      throw new Error("Git returned an oversized changed-file diff line.");
    }
    if (line.startsWith("diff --git ")) {
      currentPath = undefined;
      fileHeaderRead = false;
      return;
    }
    if (!fileHeaderRead && line.startsWith("+++ ")) {
      currentPath = diffPath(line);
      fileHeaderRead = true;
      return;
    }
    if (currentPath === undefined || !line.startsWith("@@ ")) return;
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (!header) throw new Error("Git returned an invalid changed-file hunk header.");
    const start = Number(header[1]);
    const count = Number(header[2] ?? 1);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(count) ||
      start < 0 ||
      count < 0 ||
      (count > 0 && start < 1)
    ) {
      throw new Error("Git returned an invalid changed-file hunk range.");
    }
    if (count === 0) return;
    const end = start + count - 1;
    if (!Number.isSafeInteger(end) || end > Number.MAX_SAFE_INTEGER) {
      throw new Error("Git returned an oversized changed-file hunk range.");
    }
    const lines = addedLines.get(currentPath) ?? new Set<number>();
    if (lines.size > MAX_LOCAL_ADDED_LINES_PER_FILE - count) {
      throw new Error("Git returned too many added lines for a changed file.");
    }
    for (let lineNumber = start; lineNumber <= end; lineNumber += 1) {
      lines.add(lineNumber);
    }
    addedLines.set(currentPath, lines);
  };
  const fail = (error: unknown, reject: (reason?: unknown) => void): void => {
    if (settled) return;
    settled = true;
    reject(signal?.aborted ? cancellationReason(signal) : error);
  };

  return new Promise<ReadonlyMap<string, ReadonlySet<number>>>((resolvePromise, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        pending += decoder.write(chunk);
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline).replace(/\r$/u, "");
          pending = pending.slice(newline + 1);
          consumeLine(line);
          newline = pending.indexOf("\n");
        }
        if (pending.length > MAX_LOCAL_DIFF_LINE_BYTES) {
          throw new Error("Git returned an oversized changed-file diff line.");
        }
      } catch (error) {
        child.kill();
        fail(error, reject);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_LOCAL_DIFF_LINE_BYTES) stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      fail(error, reject);
    });
    child.once("close", (code, processSignal) => {
      if (settled) return;
      try {
        pending += decoder.end();
        if (pending.length > 0) consumeLine(pending);
        if (signal?.aborted) throw cancellationReason(signal);
        if (code !== 0) {
          throw new Error(
            `Git changed-file diff failed (${code ?? processSignal ?? "unknown"}): ${stderr.trim()}`,
          );
        }
        settled = true;
        resolvePromise(addedLines);
      } catch (error) {
        fail(error, reject);
      }
    });
  });
}

export async function readGitMetadata(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  try {
    const { stdout } = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_LOCAL_METADATA_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
    throwIfAborted(signal);
    return stdout;
  } catch (error) {
    throwIfAborted(signal);
    throw new Error(`Git changed-file metadata failed: ${errorMessage(error)}`, { cause: error });
  }
}

export async function readPullRequestFilesFromCheckout(
  context: PullRequestContext,
  cwd: string,
  signal?: AbortSignal,
): Promise<readonly ChangedFile[]> {
  const mergeBaseSha = await readGitMergeBase(cwd, context.baseSha, context.headSha, signal);
  const commonArgs = [
    `--attr-source=${mergeBaseSha}`,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--find-renames=50%",
    "-l0",
  ];
  const nameStatuses = parseGitNameStatus(
    await readGitMetadata(
      cwd,
      [...commonArgs, "--name-status", "-z", mergeBaseSha, context.headSha, "--"],
      signal,
    ),
  );
  const counts = parseGitNumstat(
    await readGitMetadata(
      cwd,
      [...commonArgs, "--numstat", "-z", mergeBaseSha, context.headSha, "--"],
      signal,
    ),
    nameStatuses,
  );
  const addedLines = await readGitAddedLines(cwd, mergeBaseSha, context.headSha, signal);
  const knownPaths = new Set(nameStatuses.map((file) => file.path));
  for (const path of addedLines.keys()) {
    if (!knownPaths.has(path)) throw new Error("Git returned an unknown changed-file path.");
  }
  const files = nameStatuses.map((file, index) => {
    const count = counts[index];
    if (count === undefined) throw new Error("Git returned incomplete changed-file metadata.");
    return {
      path: file.path,
      ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
      status: file.status,
      additions: count.additions,
      deletions: count.deletions,
      changes: count.additions + count.deletions,
      addedLines: addedLines.get(file.path) ?? new Set<number>(),
    };
  });
  if (context.changedFiles !== undefined && files.length > context.changedFiles) {
    throw new Error("Git returned more files than the pull request metadata reports.");
  }
  if (context.changedFiles !== undefined && context.changedFiles > files.length) {
    throw new Error("Git returned an incomplete pull request file list.");
  }
  return files;
}
