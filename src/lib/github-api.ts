import { execFile, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import type {
  ChangedFile,
  PullRequestContext,
  PullRequestLocator,
  PullRequestReviewRequest,
} from "./types.js";
import { cancellationReason, throwIfAborted } from "./bootstrap/cancellation.js";

const execFileAsync = promisify(execFile);
const MAX_LOCAL_CHANGED_FILES = 3_000;
const MAX_LOCAL_METADATA_BYTES = 32 * 1024 * 1024;
const MAX_LOCAL_DIFF_LINE_BYTES = 1_000_000;
const MAX_LOCAL_ADDED_LINES_PER_FILE = 1_000_000;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

interface PullRequestFilePayload {
  readonly filename?: unknown;
  readonly previous_filename?: unknown;
  readonly status?: unknown;
  readonly additions?: unknown;
  readonly deletions?: unknown;
  readonly changes?: unknown;
  readonly patch?: unknown;
}

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

interface ReviewPayload {
  readonly id?: unknown;
  readonly body?: unknown;
  readonly commit_id?: unknown;
  readonly state?: unknown;
  readonly submitted_at?: unknown;
  readonly user?: unknown;
}

interface ReviewCommentPayload {
  readonly id?: unknown;
  readonly pull_request_review_id?: unknown;
  readonly in_reply_to_id?: unknown;
  readonly body?: unknown;
  readonly commit_id?: unknown;
  readonly original_commit_id?: unknown;
  readonly path?: unknown;
  readonly line?: unknown;
  readonly original_line?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
  readonly user?: unknown;
}

interface IssueCommentPayload {
  readonly id?: unknown;
  readonly body?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
  readonly performed_via_github_app?: unknown;
  readonly user?: unknown;
}

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerOrZero(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readLogin(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.login !== "string" || value.login.length === 0) {
    return undefined;
  }
  return value.login;
}

function readUser(value: unknown): GitHubCommentAuthor | undefined {
  const login = readLogin(value);
  if (login === undefined || !isRecord(value) || typeof value.type !== "string") return undefined;
  return { login, type: value.type };
}

function positiveId(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`GitHub returned an invalid ${path}.`);
  }
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`GitHub returned an invalid ${path}.`);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return requiredString(value, path);
}

function errorDetails(payload: unknown, statusText: string): string {
  if (!isRecord(payload)) return statusText;
  const details: string[] = [];
  if (typeof payload.message === "string") details.push(payload.message);
  if (Array.isArray(payload.errors)) {
    for (const error of payload.errors) {
      if (typeof error === "string") details.push(error);
      else if (isRecord(error) && typeof error.message === "string") details.push(error.message);
    }
  }
  return details.join("; ") || statusText;
}

function readHeadSha(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.head) || typeof value.head.sha !== "string") {
    return undefined;
  }
  return value.head.sha.length > 0 ? value.head.sha : undefined;
}

function readBaseSha(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.base) || typeof value.base.sha !== "string") {
    return undefined;
  }
  return value.base.sha.length > 0 ? value.base.sha : undefined;
}

function readBaseRef(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.base) || typeof value.base.ref !== "string") {
    return undefined;
  }
  return value.base.ref.length > 0 ? value.base.ref : undefined;
}

function readPullRequestContext(value: unknown, locator: PullRequestLocator): PullRequestContext {
  if (!isRecord(value)) throw new Error("GitHub returned invalid pull request metadata.");
  const headSha = readHeadSha(value);
  const baseSha = readBaseSha(value);
  const baseRef = readBaseRef(value);
  if (headSha === undefined || baseSha === undefined || baseRef === undefined) {
    throw new Error("GitHub returned incomplete pull request ref metadata.");
  }
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new Error("GitHub returned a pull request without a title.");
  }
  const changedFiles =
    typeof value.changed_files === "number" &&
    Number.isInteger(value.changed_files) &&
    value.changed_files >= 0
      ? value.changed_files
      : undefined;
  return {
    ...locator,
    headSha,
    baseSha,
    baseRef,
    ...(changedFiles === undefined ? {} : { changedFiles }),
    title: value.title,
  };
}

function parseAddedLines(patch: string | undefined): ReadonlySet<number> {
  const addedLines = new Set<number>();
  if (!patch) return addedLines;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      newLine = Number(header[1]);
      continue;
    }
    if (newLine < 1 || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      addedLines.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      continue;
    } else {
      newLine += 1;
    }
  }
  return addedLines;
}

function parsePatchCounts(patch: string | undefined): {
  readonly additions: number;
  readonly deletions: number;
  readonly complete: boolean;
} {
  if (!patch) return { additions: 0, deletions: 0, complete: false };
  let remainingOld = 0;
  let remainingNew = 0;
  let hasHunk = false;
  let complete = true;
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (hasHunk && (remainingOld !== 0 || remainingNew !== 0)) complete = false;
      remainingOld = Number(header[2] ?? 1);
      remainingNew = Number(header[4] ?? 1);
      hasHunk = true;
      continue;
    }
    if (!hasHunk || line.length === 0 || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      additions += 1;
      if (remainingNew === 0) complete = false;
      else remainingNew -= 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
      if (remainingOld === 0) complete = false;
      else remainingOld -= 1;
    } else if (line.startsWith(" ")) {
      if (remainingOld === 0 || remainingNew === 0) complete = false;
      else {
        remainingOld -= 1;
        remainingNew -= 1;
      }
    } else complete = false;
  }
  if (!hasHunk || remainingOld !== 0 || remainingNew !== 0) complete = false;
  return { additions, deletions, complete };
}

export function isPatchComplete(file: ChangedFile): boolean {
  if (file.patch === undefined) {
    return (
      (file.status === "added" || file.status === "removed" || file.status === "renamed") &&
      file.additions === 0 &&
      file.deletions === 0
    );
  }
  const counts = parsePatchCounts(file.patch);
  return (
    counts.complete && counts.additions === file.additions && counts.deletions === file.deletions
  );
}

function readFilePayload(value: unknown, index: number): ChangedFile {
  if (!isRecord(value))
    throw new Error(`GitHub returned an invalid changed-file record at index ${index}.`);
  const payload = value as PullRequestFilePayload;
  if (typeof payload.filename !== "string" || payload.filename.length === 0) {
    throw new Error(`GitHub returned a changed file without a filename at index ${index}.`);
  }
  const patch = typeof payload.patch === "string" ? payload.patch : undefined;
  return {
    path: payload.filename,
    ...(typeof payload.previous_filename === "string" && payload.previous_filename.length > 0
      ? { previousPath: payload.previous_filename }
      : {}),
    status: typeof payload.status === "string" ? payload.status : "modified",
    additions: integerOrZero(payload.additions),
    deletions: integerOrZero(payload.deletions),
    changes: integerOrZero(payload.changes),
    ...(patch === undefined ? {} : { patch }),
    addedLines: parseAddedLines(patch),
  };
}

function nulTokens(value: string): string[] {
  const tokens = value.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  return tokens;
}

function decodeGitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"') || value.length < 2) {
    throw new Error("Git returned an unterminated quoted path.");
  }
  const bytes: number[] = [];
  for (let index = 1; index < value.length - 1; ) {
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

function parseGitNameStatus(value: string): readonly GitFileNameStatus[] {
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

function parseGitNumstat(
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

function diffPath(line: string): string | undefined {
  if (!line.startsWith("+++ ")) return undefined;
  const path = decodeGitPath(line.slice(4));
  if (path === "/dev/null") return undefined;
  return path.startsWith("b/") ? path.slice(2) : path;
}

async function readGitMergeBase(
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

async function readGitAddedLines(
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
      "--find-renames=50%",
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

async function readGitMetadata(
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
    throw new Error(`Git changed-file metadata failed: ${errorMessage(error)}`);
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
    "--find-renames=50%",
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

export interface GitHubCommentAuthor {
  readonly login: string;
  readonly type: string;
}

export interface ExistingReview {
  readonly id: number;
  readonly author?: GitHubCommentAuthor;
  readonly body: string;
  readonly commitId: string | null;
  readonly state: string;
  readonly submittedAt?: string;
}

export interface PullRequestReviewCommentRecord {
  readonly id: number;
  readonly reviewId?: number;
  readonly inReplyToId?: number;
  readonly author?: GitHubCommentAuthor;
  readonly body: string;
  readonly commitId: string;
  readonly originalCommitId: string;
  readonly path: string;
  readonly line?: number;
  readonly originalLine?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PullRequestIssueCommentRecord {
  readonly id: number;
  readonly author?: GitHubCommentAuthor;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly performedViaGitHubApp: boolean;
}

function optionalUser(value: unknown, path: string): GitHubCommentAuthor | undefined {
  if (value === null) return undefined;
  const user = readUser(value);
  if (user === undefined) throw new Error(`GitHub returned an invalid ${path}.`);
  return user;
}

function optionalId(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return positiveId(value, path);
}

function nullableId(value: unknown, path: string): number | undefined {
  if (value === null) return undefined;
  return positiveId(value, path);
}

function readReviewPayload(value: unknown, index: number): ExistingReview {
  if (!isRecord(value)) throw new Error(`GitHub returned an invalid review at index ${index}.`);
  const review = value as ReviewPayload;
  const submittedAt =
    review.submitted_at === undefined || review.submitted_at === null
      ? undefined
      : requiredString(review.submitted_at, `review submitted_at at index ${index}`);
  const author = optionalUser(review.user, `review user at index ${index}`);
  return {
    id: positiveId(review.id, `review id at index ${index}`),
    ...(author === undefined ? {} : { author }),
    body: requiredString(review.body, `review body at index ${index}`),
    commitId: nullableString(review.commit_id, `review commit_id at index ${index}`),
    state: requiredString(review.state, `review state at index ${index}`),
    ...(submittedAt === undefined ? {} : { submittedAt }),
  };
}

function readReviewCommentPayload(value: unknown, index: number): PullRequestReviewCommentRecord {
  if (!isRecord(value)) {
    throw new Error(`GitHub returned an invalid pull request review comment at index ${index}.`);
  }
  const comment = value as ReviewCommentPayload;
  const inReplyToId = optionalId(
    comment.in_reply_to_id,
    `pull request review comment in_reply_to_id at index ${index}`,
  );
  const line = optionalId(comment.line, `pull request review comment line at index ${index}`);
  const originalLine = optionalId(
    comment.original_line,
    `pull request review comment original_line at index ${index}`,
  );
  const reviewId = nullableId(
    comment.pull_request_review_id,
    `pull request review comment review id at index ${index}`,
  );
  const author = optionalUser(comment.user, `pull request review comment user at index ${index}`);
  return {
    id: positiveId(comment.id, `pull request review comment id at index ${index}`),
    ...(reviewId === undefined ? {} : { reviewId }),
    ...(inReplyToId === undefined ? {} : { inReplyToId }),
    ...(author === undefined ? {} : { author }),
    body: requiredString(comment.body, `pull request review comment body at index ${index}`),
    commitId: requiredString(
      comment.commit_id,
      `pull request review comment commit_id at index ${index}`,
    ),
    originalCommitId: requiredString(
      comment.original_commit_id,
      `pull request review comment original_commit_id at index ${index}`,
    ),
    path: requiredString(comment.path, `pull request review comment path at index ${index}`),
    ...(line === undefined ? {} : { line }),
    ...(originalLine === undefined ? {} : { originalLine }),
    createdAt: requiredString(
      comment.created_at,
      `pull request review comment created_at at index ${index}`,
    ),
    updatedAt: requiredString(
      comment.updated_at,
      `pull request review comment updated_at at index ${index}`,
    ),
  };
}

function readIssueCommentPayload(value: unknown, index: number): PullRequestIssueCommentRecord {
  if (!isRecord(value)) {
    throw new Error(
      `GitHub returned an invalid pull request conversation comment at index ${index}.`,
    );
  }
  const comment = value as IssueCommentPayload;
  const body =
    comment.body === undefined || comment.body === null
      ? ""
      : requiredString(comment.body, `pull request conversation comment body at index ${index}`);
  const author = optionalUser(
    comment.user,
    `pull request conversation comment user at index ${index}`,
  );
  return {
    id: positiveId(comment.id, `pull request conversation comment id at index ${index}`),
    ...(author === undefined ? {} : { author }),
    body,
    createdAt: requiredString(
      comment.created_at,
      `pull request conversation comment created_at at index ${index}`,
    ),
    updatedAt: requiredString(
      comment.updated_at,
      `pull request conversation comment updated_at at index ${index}`,
    ),
    performedViaGitHubApp:
      comment.performed_via_github_app !== undefined && comment.performed_via_github_app !== null,
  };
}

interface RequestPage<T> {
  readonly payload: T;
  readonly headers: Headers;
}

function nextPagePath(link: string | null, apiUrl: string): string | undefined {
  if (!link) return undefined;
  const next = link
    .split(",")
    .map((part) => /<([^>]+)>;\s*rel="next"/.exec(part)?.[1])
    .find((value): value is string => value !== undefined);
  if (!next) return undefined;
  const absolute = new URL(next);
  const base = new URL(apiUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  const path = absolute.pathname.startsWith(basePath)
    ? absolute.pathname.slice(basePath.length) || "/"
    : absolute.pathname;
  return `${path}${absolute.search}`;
}

export class GitHubApi {
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly signal: AbortSignal | undefined;

  constructor(
    token: string,
    apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    signal?: AbortSignal,
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.token = token;
    this.signal = signal;
  }

  async getAuthenticatedUserLogin(): Promise<string> {
    const login = readLogin(await this.request<unknown>("/user"));
    if (login === undefined) throw new Error("GitHub returned no authenticated user login.");
    return login;
  }

  async getPullRequestContext(locator: PullRequestLocator): Promise<PullRequestContext> {
    const payload = await this.request<unknown>(
      `/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}/pulls/${locator.number}`,
    );
    return readPullRequestContext(payload, locator);
  }

  async getPullRequestRefs(
    context: PullRequestContext,
  ): Promise<{ readonly headSha: string; readonly baseSha: string }> {
    const payload = await this.request<unknown>(
      `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}`,
    );
    const headSha = readHeadSha(payload);
    const baseSha = readBaseSha(payload);
    if (headSha === undefined || baseSha === undefined) {
      throw new Error("GitHub returned incomplete pull request ref metadata.");
    }
    return { headSha, baseSha };
  }

  async getPullRequestHeadSha(context: PullRequestContext): Promise<string> {
    return (await this.getPullRequestRefs(context)).headSha;
  }

  private async requestPage<T>(path: string, init: RequestInit = {}): Promise<RequestPage<T>> {
    const signal = init.signal ?? this.signal;
    throwIfAborted(signal ?? undefined);
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers,
      ...(signal === undefined ? {} : { signal }),
    });
    const text = await response.text();
    throwIfAborted(signal ?? undefined);
    let payload: unknown = undefined;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = undefined;
      }
    }
    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GitHub API request failed (${response.status}): ${errorDetails(payload, response.statusText)}`,
      );
    }
    return { payload: payload as T, headers: response.headers };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.requestPage<T>(path, init)).payload;
  }

  private async listRecords<T>(
    pathForPage: (page: number) => string,
    responseName: string,
    read: (value: unknown, index: number) => T,
  ): Promise<readonly T[]> {
    const records: T[] = [];
    let page = 1;
    let path = pathForPage(page);
    let hasNext = true;
    while (hasNext) {
      const response: RequestPage<unknown> = await this.requestPage<unknown>(path);
      if (!Array.isArray(response.payload)) {
        throw new Error(`GitHub returned an invalid ${responseName} response.`);
      }
      records.push(...response.payload.map((item, index) => read(item, records.length + index)));
      const nextPath = nextPagePath(response.headers.get("link"), this.apiUrl);
      hasNext = nextPath !== undefined || response.payload.length === 100;
      if (!hasNext) continue;
      page += 1;
      path = nextPath ?? pathForPage(page);
    }
    return records;
  }

  async getPullRequestFiles(context: PullRequestContext): Promise<readonly ChangedFile[]> {
    const files: ChangedFile[] = [];
    let page = 1;
    let path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/files?per_page=100&page=${page}`;
    let hasNext = true;
    while (hasNext) {
      const response: RequestPage<unknown> = await this.requestPage<unknown>(path);
      const payload = response.payload;
      if (!Array.isArray(payload))
        throw new Error("GitHub returned an invalid pull request files response.");
      files.push(...payload.map((item, index) => readFilePayload(item, files.length + index)));
      if (files.length > 3_000) {
        throw new Error("GitHub returned more than the pull request file API limit.");
      }
      if (context.changedFiles !== undefined && files.length > context.changedFiles) {
        throw new Error("GitHub returned more files than the pull request metadata reports.");
      }
      if (payload.length < 100) {
        hasNext = false;
        continue;
      }
      page += 1;
      path =
        nextPagePath(response.headers.get("link"), this.apiUrl) ??
        `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/files?per_page=100&page=${page}`;
    }
    if (context.changedFiles !== undefined && context.changedFiles > files.length) {
      throw new Error("GitHub returned an incomplete pull request file list.");
    }
    return files;
  }

  async listReviews(context: PullRequestContext): Promise<readonly ExistingReview[]> {
    return this.listRecords(
      (page) =>
        `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/reviews?per_page=100&page=${page}`,
      "pull request reviews",
      readReviewPayload,
    );
  }

  async listReviewComments(
    context: PullRequestContext,
  ): Promise<readonly PullRequestReviewCommentRecord[]> {
    return this.listRecords(
      (page) =>
        `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/comments?per_page=100&page=${page}`,
      "pull request review comments",
      readReviewCommentPayload,
    );
  }

  async listIssueComments(
    context: PullRequestContext,
  ): Promise<readonly PullRequestIssueCommentRecord[]> {
    return this.listRecords(
      (page) =>
        `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/issues/${context.number}/comments?per_page=100&page=${page}`,
      "pull request conversation comments",
      readIssueCommentPayload,
    );
  }

  async createReview(
    context: PullRequestContext,
    request: PullRequestReviewRequest,
  ): Promise<void> {
    await this.request<unknown>(
      `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/reviews`,
      { method: "POST", body: JSON.stringify(request) },
    );
  }
}

export const githubApiInternals = {
  decodeGitPath,
  diffPath,
  readGitMergeBase,
  readGitAddedLines,
  readGitMetadata,
  parseGitNameStatus,
  parseGitNumstat,
  parseAddedLines,
  parsePatchCounts,
  isPatchComplete,
  nextPagePath,
  readBaseSha,
  readBaseRef,
  readPullRequestContext,
  errorDetails,
  readHeadSha,
  readLogin,
  readIssueCommentPayload,
  readReviewCommentPayload,
  readReviewPayload,
  readUser,
};
