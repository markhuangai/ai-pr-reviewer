import { createHash } from "node:crypto";
import type { ReviewConversationSnapshot } from "../lib/review-context.js";
import type { ChangedFile, PullRequestContext, ReviewBriefing } from "../lib/types.js";
import {
  BRIEFING_PAGE_BYTES,
  MODEL_TOOL_RESULT_BYTES,
  splitUtf8,
  toolResultSerializedBytes,
} from "./agent-review-tools.js";

const BRIEFING_BODY_CHUNK_BYTES = 4 * 1024;
const BRIEFING_MAX_AUTHORS = 32;
const BRIEFING_MAX_RECORDS = 4_096;
const BRIEFING_MAX_SERIALIZED_BYTES = 512 * 1024;
const BRIEFING_TRUNCATION_RESERVE_BYTES = 1_024;

interface ReviewBriefingPage {
  readonly page: number;
  readonly totalPages?: number;
  readonly records: readonly Record<string, unknown>[];
  readonly done: boolean;
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
  private readonly pages: readonly (readonly Record<string, unknown>[])[];
  private readonly delivered = new Set<number>();

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
        ...((briefing.unavailableLinkedIssues?.length ?? 0) === 0
          ? {}
          : { unavailableLinkedIssues: briefing.unavailableLinkedIssues }),
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
    for (const guidance of briefing.repositoryGuidance ?? []) {
      records.push({
        kind: "repository_guidance",
        path: guidance.path,
        revision: guidance.revision,
        body: guidance.content,
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
    const boundedRecords = boundBriefingRecords(expandedRecords);
    const pages: Record<string, unknown>[][] = [];
    let current: Record<string, unknown>[] = [];
    for (const record of boundedRecords) {
      const metadata = {
        page: BRIEFING_MAX_RECORDS,
        totalPages: BRIEFING_MAX_RECORDS,
        done: false,
      };
      if (!briefingPageWithinLimits({ ...metadata, records: [record] }))
        throw new Error("Review briefing record exceeds the bounded page size.");
      if (
        current.length > 0 &&
        !briefingPageWithinLimits({ ...metadata, records: [...current, record] })
      ) {
        pages.push(current);
        current = [];
      }
      current.push(record);
    }
    pages.push(current);
    this.pages = pages;
  }

  get complete(): boolean {
    return this.delivered.size === this.pages.length;
  }

  checkpoint() {
    return {
      identity: createHash("sha256").update(JSON.stringify(this.pages)).digest("hex"),
      delivered: [...this.delivered],
    };
  }

  inherit(checkpoint: ReturnType<ReviewBriefingReader["checkpoint"]>): void {
    if (
      checkpoint.identity !== this.checkpoint().identity ||
      checkpoint.delivered.some(
        (page) => !Number.isInteger(page) || page < 1 || page > this.pages.length,
      )
    )
      throw new Error("Shared briefing does not match this immutable review snapshot.");
    for (const page of checkpoint.delivered) this.delivered.add(page);
  }

  readNext(requestedPage?: number): ReviewBriefingPage {
    const totalPages = this.pages.length;
    if (requestedPage === undefined && this.complete)
      return { page: totalPages, totalPages, records: [], done: true };
    const page =
      requestedPage ?? this.pages.findIndex((_, index) => !this.delivered.has(index + 1)) + 1;
    if (!Number.isInteger(page) || page < 1 || page > totalPages)
      throw new Error(`Review briefing page must be between 1 and ${totalPages}.`);
    this.delivered.add(page);
    return { page, totalPages, records: this.pages[page - 1] ?? [], done: this.complete };
  }
}
