import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdtemp, open, realpath, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

import type { ReviewGoal } from "./types.js";

const MAX_CONTEXT_FILES_PER_GOAL = 25;
const MAX_CONTEXT_FILES_PER_RUN = 100;
const MAX_CONTEXT_FILE_BYTES = 100 * 1024 * 1024;
const MAX_CONTEXT_FILE_TOTAL_BYTES = 500 * 1024 * 1024;
const COPY_BUFFER_BYTES = 64 * 1024;

export interface PreparedContextFile {
  readonly path: string;
  readonly snapshotPath: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface ContextFileIdentity {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export type ContextFileIdentityByGoal = readonly (readonly ContextFileIdentity[])[];

export class ContextFileArtifact {
  private cleaned = false;

  constructor(
    readonly filesByGoal: readonly (readonly PreparedContextFile[])[],
    private readonly directory?: string,
  ) {}

  get identity(): ContextFileIdentityByGoal {
    return this.filesByGoal.map((files) =>
      files.map(({ path, sizeBytes, sha256 }) => ({ path, sizeBytes, sha256 })),
    );
  }

  async cleanup(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    if (this.directory !== undefined) {
      await rm(this.directory, { force: true, recursive: true });
    }
  }
}

function isWithin(parent: string, candidate: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath.length === 0 ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith(sep))
  );
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableFileState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertRegularSingleLink(file: BigIntStats, path: string): void {
  if (!file.isFile())
    throw new Error(`Context file ${JSON.stringify(path)} must be a regular file.`);
  if (file.nlink !== 1n) {
    throw new Error(`Context file ${JSON.stringify(path)} must not be hard linked.`);
  }
}

async function preflightContextFiles(paths: readonly string[]): Promise<void> {
  let totalBytes = 0n;
  for (const path of paths) {
    const file = await lstat(path, { bigint: true });
    assertRegularSingleLink(file, path);
    if (file.size > BigInt(MAX_CONTEXT_FILE_BYTES)) {
      throw new Error(
        `Context file ${JSON.stringify(path)} exceeds the ${MAX_CONTEXT_FILE_BYTES}-byte limit.`,
      );
    }
    totalBytes += file.size;
    if (totalBytes > BigInt(MAX_CONTEXT_FILE_TOTAL_BYTES)) {
      throw new Error(`Context files exceed the ${MAX_CONTEXT_FILE_TOTAL_BYTES}-byte total limit.`);
    }
  }
}

async function writeAll(
  file: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < length) {
    const result = await file.write(buffer, written, length - written, position + written);
    if (result.bytesWritten === 0)
      throw new Error("The context file snapshot could not be written.");
    written += result.bytesWritten;
  }
}

async function captureFile(
  path: string,
  snapshotPath: string,
  remainingBytes: number,
): Promise<PreparedContextFile> {
  const before = await lstat(path, { bigint: true });
  assertRegularSingleLink(before, path);
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination: FileHandle | undefined;
  try {
    const opened = await source.stat({ bigint: true });
    assertRegularSingleLink(opened, path);
    if (!sameFileIdentity(before, opened)) {
      throw new Error(`Context file ${JSON.stringify(path)} changed while it was being opened.`);
    }
    if (opened.size > BigInt(MAX_CONTEXT_FILE_BYTES)) {
      throw new Error(
        `Context file ${JSON.stringify(path)} exceeds the ${MAX_CONTEXT_FILE_BYTES}-byte limit.`,
      );
    }
    const sizeBytes = Number(opened.size);
    if (sizeBytes > remainingBytes) {
      throw new Error(`Context files exceed the ${MAX_CONTEXT_FILE_TOTAL_BYTES}-byte total limit.`);
    }

    destination = await open(
      snapshotPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const hash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const buffer = Buffer.allocUnsafe(Math.min(COPY_BUFFER_BYTES, Math.max(sizeBytes, 1)));
    let offset = 0;
    try {
      while (offset < sizeBytes) {
        const length = Math.min(buffer.length, sizeBytes - offset);
        const { bytesRead } = await source.read(buffer, 0, length, offset);
        if (bytesRead === 0) {
          throw new Error(`Context file ${JSON.stringify(path)} ended during snapshot capture.`);
        }
        const chunk = buffer.subarray(0, bytesRead);
        if (chunk.includes(0)) {
          throw new Error(`Context file ${JSON.stringify(path)} must not contain NUL bytes.`);
        }
        decoder.decode(chunk, { stream: true });
        hash.update(chunk);
        await writeAll(destination, chunk, bytesRead, offset);
        offset += bytesRead;
      }
      decoder.decode();
    } catch (error) {
      if (error instanceof TypeError) {
        throw new Error(`Context file ${JSON.stringify(path)} must contain valid UTF-8 text.`);
      }
      throw error;
    }
    await destination.sync();
    const after = await source.stat({ bigint: true });
    if (!stableFileState(opened, after)) {
      throw new Error(`Context file ${JSON.stringify(path)} changed during snapshot capture.`);
    }
    return {
      path,
      snapshotPath,
      sizeBytes,
      sha256: hash.digest("hex"),
    };
  } finally {
    await destination?.close();
    await source.close();
  }
}

export async function prepareContextFiles(
  goals: readonly ReviewGoal[],
  workspace: string,
  requestedTemporaryRoot = process.env.RUNNER_TEMP?.trim() || tmpdir(),
): Promise<ContextFileArtifact> {
  if (goals.some((goal) => goal.files.length > MAX_CONTEXT_FILES_PER_GOAL)) {
    throw new Error(`A review goal supports at most ${MAX_CONTEXT_FILES_PER_GOAL} context files.`);
  }
  const paths = [...new Set(goals.flatMap((goal) => goal.files))];
  if (paths.length > MAX_CONTEXT_FILES_PER_RUN) {
    throw new Error(
      `A review run supports at most ${MAX_CONTEXT_FILES_PER_RUN} unique context files.`,
    );
  }
  if (paths.length === 0) {
    return new ContextFileArtifact(goals.map(() => []));
  }

  await preflightContextFiles(paths);

  const repositoryRoot = await realpath(workspace);
  const temporaryRoot = await realpath(resolve(requestedTemporaryRoot));
  if (isWithin(repositoryRoot, temporaryRoot)) {
    throw new Error("The context file temporary directory must be outside the checkout.");
  }
  const directory = await mkdtemp(join(temporaryRoot, "ai-pr-reviewer-context-"));
  await chmod(directory, 0o700);
  try {
    const prepared = new Map<string, PreparedContextFile>();
    let totalBytes = 0;
    for (const [index, path] of paths.entries()) {
      const snapshotPath = join(directory, `${String(index + 1).padStart(3, "0")}.txt`);
      const file = await captureFile(path, snapshotPath, MAX_CONTEXT_FILE_TOTAL_BYTES - totalBytes);
      totalBytes += file.sizeBytes;
      prepared.set(path, file);
    }
    return new ContextFileArtifact(
      goals.map((goal) =>
        goal.files.map((path) => {
          const file = prepared.get(path);
          if (file === undefined)
            throw new Error(`Context file ${JSON.stringify(path)} was not captured.`);
          return file;
        }),
      ),
      directory,
    );
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

export const contextFileInternals = {
  MAX_CONTEXT_FILE_BYTES,
  MAX_CONTEXT_FILE_TOTAL_BYTES,
  sameFileIdentity,
  stableFileState,
};
