import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { throwIfAborted } from "../lib/bootstrap/cancellation.js";
import type { ChangedFile } from "../lib/types.js";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const PATH_PATTERN = /^(?![\\/])(?!(?:[A-Za-z]:|\\\\))[\s\S]{1,4096}$/u;

function isGitMetadataPath(value: string): boolean {
  return /(?:^|[\\/])\.git(?:$|[\\/])/iu.test(value);
}

function validPath(value: string): boolean {
  return (
    PATH_PATTERN.test(value) &&
    !value.includes("\0") &&
    !value.split(/[\\/]/u).some((part) => part === ".." || part === ".") &&
    !isGitMetadataPath(value)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function gitBytes(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      encoding: "buffer",
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      ...(signal === undefined ? {} : { signal }),
    });
    return stdout;
  } catch (error) {
    throwIfAborted(signal);
    throw new Error(`Git snapshot query failed: ${errorMessage(error)}`);
  }
}

function checkedCommit(value: string, label: string): string {
  if (!COMMIT_SHA_PATTERN.test(value)) throw new Error(`${label} is not a full commit SHA.`);
  return value;
}

export interface RepositoryFileSnapshot {
  readonly revision: "base" | "head";
  readonly path: string;
  readonly kind: "text" | "binary" | "missing";
  readonly sizeBytes: number;
  readonly content?: string;
}

export class RepositorySnapshot {
  readonly headSha: string;
  readonly mergeBaseSha: string;
  private readonly allowedPaths: ReadonlySet<string>;

  constructor(
    private readonly cwd: string,
    baseSha: string,
    headSha: string,
    mergeBaseSha: string,
    files: readonly ChangedFile[],
    private readonly signal?: AbortSignal,
  ) {
    checkedCommit(baseSha, "Pull request base SHA");
    this.mergeBaseSha = checkedCommit(mergeBaseSha, "Pull request merge base SHA");
    this.headSha = checkedCommit(headSha, "Pull request head SHA");
    this.allowedPaths = new Set(
      files.flatMap((file) => [
        file.path,
        ...(file.previousPath === undefined ? [] : [file.previousPath]),
      ]),
    );
  }

  private path(path: string): string {
    if (!validPath(path)) throw new Error("Repository path is outside the fixed checkout.");
    if (!this.allowedPaths.has(path))
      throw new Error("Repository path is not a changed pull-request path.");
    return path;
  }

  private sha(revision: "base" | "head"): string {
    return revision === "base" ? this.mergeBaseSha : this.headSha;
  }

  async diff(paths: readonly string[] = []): Promise<string> {
    const selected = paths.map((path) => this.path(path));
    const output = await gitBytes(
      this.cwd,
      [
        `--attr-source=${this.mergeBaseSha}`,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--full-index",
        this.mergeBaseSha,
        this.headSha,
        "--",
        ...selected,
      ],
      this.signal,
    );
    return output.toString("utf8");
  }

  async file(revision: "base" | "head", path: string): Promise<RepositoryFileSnapshot> {
    const selected = this.path(path);
    const sha = this.sha(revision);
    try {
      const bytes = await gitBytes(
        this.cwd,
        ["cat-file", "blob", `${sha}:${selected}`],
        this.signal,
      );
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return { revision, path: selected, kind: "binary", sizeBytes: bytes.byteLength };
      }
      if (bytes.includes(0)) {
        return { revision, path: selected, kind: "binary", sizeBytes: bytes.byteLength };
      }
      return { revision, path: selected, kind: "text", sizeBytes: bytes.byteLength, content };
    } catch (error) {
      if (
        /does not exist|exists on disk, but not in|Not a valid object name|path .* does not exist/iu.test(
          errorMessage(error),
        )
      ) {
        return { revision, path: selected, kind: "missing", sizeBytes: 0 };
      }
      throw error;
    }
  }
}

export const repositorySnapshotInternals = {
  validPath,
  isGitMetadataPath,
  checkedCommit,
};
