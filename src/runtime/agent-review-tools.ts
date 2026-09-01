import { execFile } from "node:child_process";
import { mkdtemp, open, realpath, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, matchesGlob, relative, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";

import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { throwIfAborted } from "../lib/bootstrap/cancellation.js";
import type { ReviewConversationSnapshot } from "../lib/review-context.js";
import type { ChangedFile, PullRequestContext, ReviewBriefing } from "../lib/types.js";
import { errorMessage, isRecord } from "./agent-logging.js";
import { streamGitToFile } from "./git-stream.js";

const DIFF_PAGE_BYTES = 4 * 1024;
const CONVERSATION_PAGE_BYTES = 4 * 1024;
const REPOSITORY_PAGE_BYTES = 12 * 1024;
export const BRIEFING_PAGE_BYTES = 16 * 1024;
const BRIEFING_BODY_CHUNK_BYTES = 4 * 1024;
const BRIEFING_MAX_AUTHORS = 32;
const BRIEFING_MAX_RECORDS = 4_096;
const BRIEFING_MAX_SERIALIZED_BYTES = 512 * 1024;
const BRIEFING_TRUNCATION_RESERVE_BYTES = 1_024;
export const MODEL_TOOL_RESULT_BYTES = 24 * 1024;
const MAX_GIT_STDERR_BYTES = 64 * 1024;
const COMMIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

const execFileAsync = promisify(execFile);

export function jsonToolResult(value: unknown): CallToolResult {
  const text = JSON.stringify(value);
  if (toolResultSerializedBytes(text) > MODEL_TOOL_RESULT_BYTES) {
    return {
      content: [{ type: "text", text: "Internal review tool output was bounded before delivery." }],
      isError: true,
    };
  }
  return { content: [{ type: "text", text }] };
}

function toolResultSerializedBytes(text: string): number {
  return Buffer.byteLength(JSON.stringify({ content: [{ type: "text", text }] }), "utf8");
}

export function isWithinRepository(cwd: string, candidate: string): boolean {
  const root = resolve(cwd);
  const target = resolve(root, candidate);
  const relativePath = relative(root, target);
  return (
    relativePath.length === 0 ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !relativePath.startsWith(sep))
  );
}

export function isGitMetadataPath(candidate: string): boolean {
  return /(?:^|[\\/{,])\.git(?:$|[\\/},])/i.test(candidate);
}

function globMatchesGitMetadata(pattern: string): boolean {
  try {
    return pattern.split(/[\\/]/u).some((segment) => matchesGlob(".git", segment));
  } catch {
    return true;
  }
}

export function isSafeGlobPattern(pattern: string): boolean {
  const normalized = pattern.replace(/^!/, "");
  if (normalized.includes("..") || globMatchesGitMetadata(normalized)) return false;
  let braceDepth = 0;
  for (const character of normalized) {
    if (character === "{") braceDepth += 1;
    if (character === "}") braceDepth -= 1;
    if (braceDepth < 0 || braceDepth > 1) return false;
  }
  if (braceDepth !== 0) return false;
  for (const match of normalized.matchAll(/\{([^{}]*)\}/g)) {
    for (const alternative of (match[1] ?? "").split(",")) {
      if (alternative.startsWith("/") || alternative.startsWith("\\")) return false;
      if (/^[A-Za-z]:[\\/]/.test(alternative)) return false;
    }
  }
  return true;
}

export function isSafeGrepGlob(
  cwd: string,
  pathCandidate: unknown,
  pattern: string | undefined,
): boolean {
  if (typeof pathCandidate === "string" && !isWithinRepository(cwd, pathCandidate)) return false;
  if (pattern === undefined) return true;
  const normalized = pattern.replace(/^!/, "");
  if (isGitMetadataPath(normalized) || globMatchesGitMetadata(normalized)) return false;
  return true;
}

export function isSafeResolvedPath(cwd: string, candidate: string): boolean {
  const root = resolve(cwd);
  const resolved = resolve(candidate);
  return isWithinRepository(cwd, resolved) && !isGitMetadataPath(relative(root, resolved));
}

async function allowsRepositoryPath(cwd: string, candidate: string): Promise<boolean> {
  if (isGitMetadataPath(candidate)) return false;
  if (!isWithinRepository(cwd, candidate)) return false;
  const wildcardIndex = ["*", "?", "[", "]", "{", "}", "!"]
    .map((character) => candidate.indexOf(character))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (wildcardIndex !== undefined) {
    const prefix = candidate.slice(0, wildcardIndex);
    const separatorIndex = Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\"));
    const parent = separatorIndex < 0 ? "." : prefix.slice(0, separatorIndex) || sep;
    try {
      return isSafeResolvedPath(cwd, await realpath(resolve(cwd, parent)));
    } catch {
      return true;
    }
  }
  try {
    return isSafeResolvedPath(cwd, await realpath(resolve(cwd, candidate)));
  } catch {
    return true;
  }
}

export const repositoryReadHook: HookCallback = async (input: HookInput) => {
  if (input.hook_event_name !== "PreToolUse") return { continue: true };
  const toolInput = isRecord(input.tool_input) ? input.tool_input : undefined;
  if (!toolInput) return { continue: true };
  const pathCandidate = input.tool_name === "Read" ? toolInput.file_path : toolInput.path;
  const pathAllowed =
    pathCandidate === undefined ||
    (typeof pathCandidate === "string" && (await allowsRepositoryPath(input.cwd, pathCandidate)));
  const globPattern =
    input.tool_name === "Glob"
      ? toolInput.pattern
      : input.tool_name === "Grep"
        ? toolInput.glob
        : undefined;
  const globPath = typeof globPattern === "string" ? globPattern.replace(/^!/, "") : globPattern;
  const grepScopeAllowed =
    input.tool_name !== "Grep" ||
    isSafeGrepGlob(input.cwd, pathCandidate, typeof globPath === "string" ? globPath : undefined);
  const patternAllowed =
    globPattern === undefined ||
    (typeof globPath === "string" &&
      isSafeGlobPattern(globPath) &&
      (await allowsRepositoryPath(input.cwd, globPath)));
  if (
    !pathAllowed ||
    !grepScopeAllowed ||
    !patternAllowed ||
    (input.tool_name === "Glob" && typeof globPattern !== "string")
  ) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: "Read access is limited to the checked-out repository.",
      },
    };
  }
  return { continue: true };
};

interface PullRequestConversationPage {
  readonly page: number;
  readonly content: string;
  readonly done: boolean;
}

export class PullRequestConversationReader {
  private readonly content: Buffer;
  private readonly decoder = new StringDecoder("utf8");
  private offset = 0;
  private page = 0;
  private reachedEnd = false;

  constructor(conversation: ReviewConversationSnapshot) {
    this.content = Buffer.from(JSON.stringify({ entries: conversation.entries }), "utf8");
  }

  get complete(): boolean {
    return this.reachedEnd;
  }

  readNext(): PullRequestConversationPage {
    if (this.reachedEnd) return { page: this.page, content: "", done: true };
    this.page += 1;
    const end = Math.min(this.offset + CONVERSATION_PAGE_BYTES, this.content.length);
    const chunk = this.content.subarray(this.offset, end);
    this.offset = end;
    const done = this.offset === this.content.length;
    const content = this.decoder.write(chunk) + (done ? this.decoder.end() : "");
    this.reachedEnd = done;
    return { page: this.page, content, done };
  }
}

interface ReviewBriefingPage {
  readonly page: number;
  readonly records: readonly Record<string, unknown>[];
  readonly done: boolean;
}

export function splitUtf8(value: string, maxBytes: number): readonly string[] {
  if (maxBytes < 4) throw new Error("UTF-8 page chunks must allow a complete code point.");
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length === 0) return [""];
  const parts: string[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + maxBytes, bytes.length);
    while (
      end > offset &&
      end < bytes.length &&
      (bytes[end] as number) >= 0x80 &&
      (bytes[end] as number) <= 0xbf
    )
      end -= 1;
    parts.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return parts;
}

function briefingExcerpt(value: string, limit = 320): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function briefingTail(value: string, limit = 320): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `…${normalized.slice(-Math.max(0, limit - 1)).trimStart()}`;
}

function briefingPageWithinLimits(page: ReviewBriefingPage): boolean {
  const text = JSON.stringify(page);
  return (
    Buffer.byteLength(text, "utf8") <= BRIEFING_PAGE_BYTES &&
    toolResultSerializedBytes(text) <= MODEL_TOOL_RESULT_BYTES
  );
}

function briefingBodyRecords(
  record: Record<string, unknown>,
  body: string,
): readonly Record<string, unknown>[] {
  let chunkBytes = Math.min(
    BRIEFING_BODY_CHUNK_BYTES,
    Math.max(4, Buffer.byteLength(body, "utf8")),
  );
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const chunks = splitUtf8(body, chunkBytes);
    const records = chunks.map((chunk, part) => ({
      ...record,
      body: chunk,
      bodyPart: part,
      bodyParts: chunks.length,
    }));
    if (
      records.every((chunkedRecord) =>
        briefingPageWithinLimits({ page: 1, records: [chunkedRecord], done: false }),
      )
    )
      return chunks.length === 1 ? [record] : records;
    if (chunkBytes <= 4) throw new Error("Review briefing body cannot fit the bounded page size.");
    chunkBytes = Math.max(4, Math.floor(chunkBytes / 2));
  }
  throw new Error("Review briefing body cannot fit the bounded page size.");
}

function boundBriefingRecords(
  records: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
  const bounded: Record<string, unknown>[] = [];
  const omittedByKind: Record<string, number> = {};
  let serializedBytes = Buffer.byteLength(
    JSON.stringify({ page: 1, records: [], done: false }),
    "utf8",
  );
  let omittedRecords = 0;
  for (const record of records) {
    const recordBytes = Buffer.byteLength(JSON.stringify(record), "utf8");
    const commaBytes = bounded.length === 0 ? 0 : 1;
    if (
      bounded.length >= BRIEFING_MAX_RECORDS ||
      serializedBytes + commaBytes + recordBytes + BRIEFING_TRUNCATION_RESERVE_BYTES >
        BRIEFING_MAX_SERIALIZED_BYTES
    ) {
      omittedRecords += 1;
      const kind = typeof record.kind === "string" ? record.kind : "unknown";
      omittedByKind[kind] = (omittedByKind[kind] ?? 0) + 1;
      continue;
    }
    bounded.push(record);
    serializedBytes += commaBytes + recordBytes;
  }
  if (omittedRecords === 0) return bounded;
  bounded.push({
    kind: "briefing_truncated",
    omittedRecords,
    omittedByKind,
    maxRecords: BRIEFING_MAX_RECORDS,
    maxSerializedBytes: BRIEFING_MAX_SERIALIZED_BYTES,
  });
  return bounded;
}

export class ReviewBriefingReader {
  private readonly records: readonly Record<string, unknown>[];
  private index = 0;
  private page = 0;
  private reachedEnd = false;

  constructor(
    context: PullRequestContext,
    files: readonly ChangedFile[],
    conversation: ReviewConversationSnapshot,
    briefing: ReviewBriefing,
  ) {
    const records: Record<string, unknown>[] = [
      {
        kind: "pull_request",
        repository: context.repository,
        number: context.number,
        title: context.title,
        body: context.body ?? "",
        baseSha: context.baseSha,
        headSha: context.headSha,
      },
      {
        kind: "linked_issue_index",
        count: briefing.linkedIssues.length,
        referencesTruncated: briefing.linkedIssueReferencesTruncated,
      },
    ];
    for (const issue of briefing.linkedIssues) {
      records.push({
        kind: "linked_issue",
        number: issue.number,
        title: issue.title,
        state: issue.state,
        htmlUrl: issue.htmlUrl,
        body: issue.body,
      });
    }
    for (const file of files) {
      records.push({
        kind: "changed_file",
        path: file.path,
        ...(file.previousPath === undefined ? {} : { previousPath: file.previousPath }),
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      });
    }
    for (const entry of conversation.entries) {
      const messages = entry.kind === "inline_thread" ? entry.messages : [entry.message];
      const first = messages[0]?.body ?? "";
      const last = messages[messages.length - 1]?.body ?? first;
      const authors = [
        ...new Set(
          messages
            .map((message) => message.authorLogin)
            .filter((login): login is string => login !== undefined),
        ),
      ];
      records.push({
        kind: "discussion_index",
        entryKind: entry.kind,
        id: entry.id,
        ...(entry.kind === "inline_thread"
          ? {
              path: entry.path,
              ...(entry.reviewId === undefined ? {} : { reviewId: entry.reviewId }),
              ...(entry.line === undefined ? {} : { line: entry.line }),
              messageCount: entry.messages.length,
              isResolved: entry.isResolved,
              isOutdated: entry.isOutdated,
              ...(entry.resolvedByLogin === undefined
                ? {}
                : { resolvedByLogin: entry.resolvedByLogin }),
              ...(entry.reviewIsMinimized === undefined
                ? {}
                : { reviewIsMinimized: entry.reviewIsMinimized }),
              ...(entry.reviewMinimizedReason === undefined
                ? {}
                : { reviewMinimizedReason: entry.reviewMinimizedReason }),
            }
          : {}),
        authors: authors.slice(0, BRIEFING_MAX_AUTHORS),
        ...(authors.length > BRIEFING_MAX_AUTHORS ? { authorCount: authors.length } : {}),
        firstExcerpt: briefingExcerpt(first),
        lastExcerpt: briefingTail(last),
      });
    }
    const expandedRecords = records.flatMap((record) => {
      const body = typeof record.body === "string" ? record.body : undefined;
      return body === undefined ? [record] : briefingBodyRecords(record, body);
    });
    this.records = boundBriefingRecords(expandedRecords);
    for (const record of this.records) {
      if (!briefingPageWithinLimits({ page: 1, records: [record], done: false }))
        throw new Error("Review briefing record exceeds the bounded page size.");
    }
  }

  get complete(): boolean {
    return this.reachedEnd;
  }

  readNext(): ReviewBriefingPage {
    if (this.reachedEnd) return { page: this.page, records: [], done: true };
    this.page += 1;
    const records: Record<string, unknown>[] = [];
    while (this.index < this.records.length) {
      const record = this.records[this.index];
      if (record === undefined) break;
      const candidate = { page: this.page, records: [...records, record], done: false };
      if (records.length > 0 && !briefingPageWithinLimits(candidate)) break;
      records.push(record);
      this.index += 1;
    }
    const done = this.index === this.records.length;
    this.reachedEnd = done;
    const page = { page: this.page, records, done };
    if (!briefingPageWithinLimits(page))
      throw new Error("Review briefing page exceeds the bounded page size.");
    return page;
  }
}

interface TextPage {
  readonly page: number;
  readonly content: string;
  readonly done: boolean;
}

function utf8PageEnd(bytes: Buffer, start: number, proposedEnd: number, hasMore = false): number {
  let end = Math.min(proposedEnd, bytes.length);
  if (!hasMore && end === bytes.length) return end;
  while (end > start && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  if (end > start) return end;
  end = Math.min(start + 1, bytes.length);
  while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end += 1;
  return end;
}

function serializedQueryPageWithinLimit(
  page: TextPage,
  extra: Readonly<Record<string, unknown>>,
): boolean {
  return (
    toolResultSerializedBytes(JSON.stringify({ ...page, ...extra })) <= MODEL_TOOL_RESULT_BYTES
  );
}

export class StringPageReader {
  private readonly bytes: Buffer;
  private readonly pageBytes: number;
  private offset = 0;
  private page = 0;
  private reachedEnd = false;

  constructor(value: string, pageBytes = REPOSITORY_PAGE_BYTES) {
    this.bytes = Buffer.from(value, "utf8");
    const serializedBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const expansion =
      this.bytes.length === 0 ? 1 : Math.max(1, serializedBytes / this.bytes.length);
    this.pageBytes = Math.min(
      pageBytes,
      Math.max(1_024, Math.floor((MODEL_TOOL_RESULT_BYTES - 1_024) / (expansion * 2))),
    );
  }

  get complete(): boolean {
    return this.reachedEnd;
  }

  readNext(extra: Readonly<Record<string, unknown>> = {}): TextPage {
    if (this.reachedEnd) return { page: this.page, content: "", done: true };
    const start = this.offset;
    let end = utf8PageEnd(this.bytes, start, start + this.pageBytes);
    let page: TextPage = {
      page: this.page + 1,
      content: this.bytes.subarray(start, end).toString("utf8"),
      done: end === this.bytes.length,
    };
    while (!serializedQueryPageWithinLimit(page, extra) && end > start) {
      const reducedEnd = utf8PageEnd(this.bytes, start, start + Math.floor((end - start) / 2));
      if (reducedEnd === end) break;
      end = reducedEnd;
      page = {
        page: this.page + 1,
        content: this.bytes.subarray(start, end).toString("utf8"),
        done: end === this.bytes.length,
      };
    }
    if (!serializedQueryPageWithinLimit(page, extra))
      throw new Error("Repository query page exceeds the bounded result size.");
    this.offset = end;
    this.page = page.page;
    this.reachedEnd = page.done;
    return page;
  }
}

export class RepositoryFilePageReader {
  private file: FileHandle | undefined;
  private offset = 0;
  private page = 0;
  private reachedEnd = false;
  private closed = false;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly sizeBytes: number,
    private readonly signal?: AbortSignal,
  ) {}

  get complete(): boolean {
    return this.reachedEnd;
  }

  readNext(extra: Readonly<Record<string, unknown>> = {}): Promise<TextPage> {
    const result = this.operation.then(() => this.readNextPage(extra));
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    await this.operation;
    if (this.closed) return;
    this.closed = true;
    await this.file?.close();
    this.file = undefined;
  }

  private async readNextPage(extra: Readonly<Record<string, unknown>>): Promise<TextPage> {
    throwIfAborted(this.signal);
    if (this.closed) throw new Error("Cannot read a closed repository query.");
    if (this.reachedEnd) return { page: this.page, content: "", done: true };
    this.file ??= await open(this.path, "r");
    throwIfAborted(this.signal);
    const start = this.offset;
    if (this.sizeBytes === 0) {
      const page = { page: this.page + 1, content: "", done: true };
      if (!serializedQueryPageWithinLimit(page, extra))
        throw new Error("Repository query page exceeds the bounded result size.");
      this.page = page.page;
      this.reachedEnd = true;
      return page;
    }
    const requestedBytes = Math.min(REPOSITORY_PAGE_BYTES + 4, this.sizeBytes - start);
    const buffer = Buffer.allocUnsafe(requestedBytes);
    let bytesRead = 0;
    while (bytesRead < requestedBytes) {
      const result = await this.file.read(
        buffer,
        bytesRead,
        requestedBytes - bytesRead,
        start + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    throwIfAborted(this.signal);
    if (bytesRead === 0) throw new Error("Repository query ended before its recorded size.");
    const hasMore = start + bytesRead < this.sizeBytes;
    const available = buffer.subarray(0, bytesRead);
    let end = utf8PageEnd(available, 0, Math.min(REPOSITORY_PAGE_BYTES, bytesRead), hasMore);
    let page: TextPage = {
      page: this.page + 1,
      content: available.subarray(0, end).toString("utf8"),
      done: start + end === this.sizeBytes,
    };
    while (!serializedQueryPageWithinLimit(page, extra) && end > 0) {
      const reducedEnd = utf8PageEnd(available, 0, Math.floor(end / 2), hasMore);
      if (reducedEnd === end) break;
      end = reducedEnd;
      page = {
        page: this.page + 1,
        content: available.subarray(0, end).toString("utf8"),
        done: start + end === this.sizeBytes,
      };
    }
    if (!serializedQueryPageWithinLimit(page, extra))
      throw new Error("Repository query page exceeds the bounded result size.");
    this.offset = start + end;
    this.page = page.page;
    this.reachedEnd = page.done;
    return page;
  }
}

interface PullRequestDiffPage {
  readonly page: number;
  readonly content: string;
  readonly done: boolean;
}

export class PullRequestDiffReader {
  private file: FileHandle | undefined;
  private offset = 0;
  private page = 0;
  private reachedEnd = false;
  private closed = false;
  private operation: Promise<void> = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly size: number,
    private readonly signal?: AbortSignal,
  ) {}

  get complete(): boolean {
    return this.reachedEnd;
  }

  readNext(extra: Readonly<Record<string, unknown>> = {}): Promise<PullRequestDiffPage> {
    const result = this.operation.then(() => this.readNextPage(extra));
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async close(): Promise<void> {
    await this.operation;
    if (this.closed) return;
    this.closed = true;
    await this.file?.close();
    this.file = undefined;
  }

  private async readNextPage(
    extra: Readonly<Record<string, unknown>>,
  ): Promise<PullRequestDiffPage> {
    throwIfAborted(this.signal);
    if (this.closed) throw new Error("Cannot read a closed pull request diff.");
    if (this.reachedEnd) return { page: this.page, content: "", done: true };
    this.file ??= await open(this.path, "r");
    throwIfAborted(this.signal);
    if (this.size === 0) {
      const page = { page: this.page + 1, content: "", done: true };
      if (!serializedQueryPageWithinLimit(page, extra))
        throw new Error("Pull request diff page exceeds the bounded result size.");
      this.page = page.page;
      this.reachedEnd = true;
      return page;
    }
    const start = this.offset;
    const requestedBytes = Math.min(DIFF_PAGE_BYTES + 4, this.size - start);
    const buffer = Buffer.allocUnsafe(requestedBytes);
    let bytesRead = 0;
    while (bytesRead < requestedBytes) {
      const result = await this.file.read(
        buffer,
        bytesRead,
        requestedBytes - bytesRead,
        start + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    throwIfAborted(this.signal);
    if (bytesRead === 0) {
      throw new Error("The pull request diff ended before its recorded size.");
    }
    const available = buffer.subarray(0, bytesRead);
    const hasMore = start + bytesRead < this.size;
    let end = utf8PageEnd(available, 0, Math.min(DIFF_PAGE_BYTES, bytesRead), hasMore);
    const makePage = (pageEnd: number): PullRequestDiffPage => ({
      page: this.page + 1,
      content: available.subarray(0, pageEnd).toString("utf8"),
      done: start + pageEnd === this.size,
    });
    let page = makePage(end);
    while (!serializedQueryPageWithinLimit(page, extra) && end > 0) {
      const reducedEnd = utf8PageEnd(available, 0, Math.floor(end / 2), hasMore);
      if (reducedEnd === end) break;
      end = reducedEnd;
      page = makePage(end);
    }
    if (!serializedQueryPageWithinLimit(page, extra))
      throw new Error("Pull request diff page exceeds the bounded result size.");
    this.offset = start + end;
    this.page = page.page;
    this.reachedEnd = page.done;
    return page;
  }
}

export class PullRequestDiffArtifact {
  constructor(
    readonly mergeBaseSha: string,
    readonly path: string,
    readonly size: number,
    private readonly directory: string,
    private readonly signal?: AbortSignal,
  ) {}

  createReader(): PullRequestDiffReader {
    return new PullRequestDiffReader(this.path, this.size, this.signal);
  }

  async cleanup(): Promise<void> {
    await rm(this.directory, { force: true, recursive: true });
  }
}

export async function resolveCommit(
  cwd: string,
  sha: string,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  if (!COMMIT_SHA_PATTERN.test(sha)) throw new Error(`${label} is not a full Git commit SHA.`);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["rev-parse", "--verify", `${sha}^{commit}`], {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_GIT_STDERR_BYTES,
      ...(signal === undefined ? {} : { signal }),
    }));
  } catch (error) {
    throwIfAborted(signal);
    throw new Error(
      `${label} is not available as a commit in the checkout: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  const resolved = stdout.trim();
  if (!COMMIT_SHA_PATTERN.test(resolved) || resolved.toLowerCase() !== sha.toLowerCase()) {
    throw new Error(`${label} did not resolve to the exact requested commit.`);
  }
  return resolved;
}

export async function resolveMergeBase(
  cwd: string,
  baseSha: string,
  headSha: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync("git", ["merge-base", baseSha, headSha], {
      cwd,
      encoding: "utf8",
      maxBuffer: MAX_GIT_STDERR_BYTES,
      ...(signal === undefined ? {} : { signal }),
    }));
  } catch (error) {
    throwIfAborted(signal);
    throw new Error(`Could not resolve the pull request merge base: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  const mergeBase = stdout.trim();
  if (!COMMIT_SHA_PATTERN.test(mergeBase)) {
    throw new Error("Git returned an invalid pull request merge base.");
  }
  return mergeBase;
}

async function streamGitDiff(
  cwd: string,
  mergeBaseSha: string,
  headSha: string,
  path: string,
  signal?: AbortSignal,
): Promise<void> {
  await streamGitToFile(
    cwd,
    [
      `--attr-source=${mergeBaseSha}`,
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--full-index",
      mergeBaseSha,
      headSha,
      "--",
    ],
    path,
    "Git diff",
    signal,
  );
}

export async function createPullRequestDiff(
  context: PullRequestContext,
  cwd: string,
  requestedTemporaryRoot = process.env.RUNNER_TEMP?.trim() || tmpdir(),
  signal?: AbortSignal,
): Promise<PullRequestDiffArtifact> {
  throwIfAborted(signal);
  const repositoryRoot = await realpath(cwd);
  const temporaryRoot = await realpath(resolve(requestedTemporaryRoot));
  throwIfAborted(signal);
  if (isWithinRepository(repositoryRoot, temporaryRoot)) {
    throw new Error("The pull request diff temporary directory must be outside the checkout.");
  }
  const baseSha = await resolveCommit(
    repositoryRoot,
    context.baseSha,
    "Pull request base SHA",
    signal,
  );
  const headSha = await resolveCommit(
    repositoryRoot,
    context.headSha,
    "Pull request head SHA",
    signal,
  );
  const mergeBaseSha = await resolveMergeBase(repositoryRoot, baseSha, headSha, signal);
  const directory = await mkdtemp(join(temporaryRoot, "ai-pr-reviewer-diff-"));
  const path = join(directory, "pull-request.diff");
  try {
    throwIfAborted(signal);
    await streamGitDiff(repositoryRoot, mergeBaseSha, headSha, path, signal);
    const { size } = await stat(path);
    throwIfAborted(signal);
    return new PullRequestDiffArtifact(mergeBaseSha, path, size, directory, signal);
  } catch (error) {
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}
