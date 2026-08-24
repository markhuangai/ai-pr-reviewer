import { mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { throwIfAborted } from "../lib/bootstrap/cancellation.js";
import type { ChangedFile } from "../lib/types.js";
import { streamGitToFile } from "./git-stream.js";

const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const PATH_PATTERN = /^(?![\\/])(?!(?:[A-Za-z]:|\\\\))[\s\S]{1,4096}$/u;
const MAX_REPOSITORY_QUERY_STORAGE_BYTES = 256 * 1024 * 1024;

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

function isWithin(root: string, candidate: string): boolean {
  const child = relative(resolve(root), resolve(candidate));
  return child === "" || (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child));
}

async function isTextFile(path: string, sizeBytes: number, signal?: AbortSignal): Promise<boolean> {
  const file = await open(path, "r");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  try {
    while (offset < sizeBytes) {
      throwIfAborted(signal);
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.length, sizeBytes - offset),
        offset,
      );
      if (bytesRead === 0) throw new Error("Repository query ended before its recorded size.");
      const chunk = buffer.subarray(0, bytesRead);
      if (chunk.includes(0)) return false;
      try {
        decoder.decode(chunk, { stream: offset + bytesRead < sizeBytes });
      } catch {
        return false;
      }
      offset += bytesRead;
    }
    try {
      decoder.decode();
    } catch {
      return false;
    }
    return true;
  } finally {
    await file.close();
  }
}

function checkedCommit(value: string, label: string): string {
  if (!COMMIT_SHA_PATTERN.test(value)) throw new Error(`${label} is not a full Git commit SHA.`);
  return value;
}

export interface RepositoryQuerySource {
  readonly path: string;
  readonly sizeBytes: number;
  readonly cleanup: () => Promise<void>;
}

export interface RepositoryFileSnapshot {
  readonly revision: "base" | "head";
  readonly path: string;
  readonly kind: "text" | "binary" | "missing";
  readonly sizeBytes: number;
  readonly source?: RepositoryQuerySource;
}

export class RepositorySnapshot {
  readonly headSha: string;
  readonly mergeBaseSha: string;
  private readonly allowedPaths: ReadonlySet<string>;
  private readonly queryDirectories = new Set<string>();
  private queryStorageBytes = 0;

  constructor(
    private readonly cwd: string,
    baseSha: string,
    headSha: string,
    mergeBaseSha: string,
    files: readonly ChangedFile[],
    private readonly signal?: AbortSignal,
    private readonly temporaryRoot = process.env.RUNNER_TEMP?.trim() || tmpdir(),
    private readonly maxQueryStorageBytes = MAX_REPOSITORY_QUERY_STORAGE_BYTES,
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

  private async query(args: readonly string[]): Promise<RepositoryQuerySource> {
    throwIfAborted(this.signal);
    let directory: string | undefined;
    try {
      const repositoryRoot = await realpath(this.cwd);
      const temporaryRoot = await realpath(resolve(this.temporaryRoot));
      if (isWithin(repositoryRoot, temporaryRoot)) {
        throw new Error("Repository query temporary directory must be outside the checkout.");
      }
      const createdDirectory = await mkdtemp(
        join(temporaryRoot, "ai-pr-reviewer-repository-query-"),
      );
      directory = createdDirectory;
      const outputPath = join(createdDirectory, "output");
      await streamGitToFile(this.cwd, args, outputPath, "Git snapshot query", this.signal);
      const { size: sizeBytes } = await stat(outputPath);
      if (sizeBytes > this.maxQueryStorageBytes - this.queryStorageBytes) {
        throw new Error("Repository query storage exceeds the per-goal limit.");
      }
      this.queryDirectories.add(createdDirectory);
      this.queryStorageBytes += sizeBytes;
      let cleaned = false;
      return {
        path: outputPath,
        sizeBytes,
        cleanup: async () => {
          if (cleaned) return;
          cleaned = true;
          if (this.queryDirectories.delete(createdDirectory)) this.queryStorageBytes -= sizeBytes;
          await rm(createdDirectory, { force: true, recursive: true });
        },
      };
    } catch (error) {
      if (directory !== undefined) await rm(directory, { force: true, recursive: true });
      throwIfAborted(this.signal);
      if (/^Git snapshot query failed/iu.test(errorMessage(error))) throw error;
      throw new Error(`Git snapshot query failed: ${errorMessage(error)}`);
    }
  }

  async diff(paths: readonly string[] = []): Promise<RepositoryQuerySource> {
    const selected = paths.map((path) => `:(literal)${this.path(path)}`);
    return this.query([
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
    ]);
  }

  async file(revision: "base" | "head", path: string): Promise<RepositoryFileSnapshot> {
    const selected = this.path(path);
    const sha = this.sha(revision);
    let source: RepositoryQuerySource;
    try {
      source = await this.query(["cat-file", "blob", `${sha}:${selected}`]);
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
    try {
      if (await isTextFile(source.path, source.sizeBytes, this.signal)) {
        return { revision, path: selected, kind: "text", sizeBytes: source.sizeBytes, source };
      }
    } catch (error) {
      await source.cleanup();
      throw error;
    }
    await source.cleanup();
    return { revision, path: selected, kind: "binary", sizeBytes: source.sizeBytes };
  }

  async cleanup(): Promise<void> {
    const directories = [...this.queryDirectories];
    this.queryDirectories.clear();
    this.queryStorageBytes = 0;
    await Promise.all(
      directories.map((directory) => rm(directory, { force: true, recursive: true })),
    );
  }
}

export const repositorySnapshotInternals = {
  MAX_REPOSITORY_QUERY_STORAGE_BYTES,
  validPath,
  isGitMetadataPath,
  isWithin,
  checkedCommit,
};
