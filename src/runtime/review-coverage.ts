import { createReadStream } from "node:fs";

import { throwIfAborted } from "../lib/bootstrap/cancellation.js";
import type {
  ChangedFile,
  ReviewEvidenceReference,
  ReviewFileLineCoverage,
  ReviewLineRange,
  ReviewInspection,
} from "../lib/types.js";
import type { DiffFileSpan } from "./agent-review-tools.js";

export interface ChangedDiffLine {
  readonly revision: "base" | "head";
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

export interface SourceLineIndex {
  readonly path: string;
  readonly revision: "base" | "head";
  readonly size: number;
  readonly lines: readonly {
    readonly line: number;
    readonly start: number;
    readonly end: number;
  }[];
}

export interface SourceDelivery {
  readonly source: Pick<ReviewEvidenceReference, "kind" | "path" | "revision">;
  readonly range: { readonly paths: readonly string[]; readonly totalBytes: number };
  readonly intervals: readonly ReviewLineRange[];
}

async function visitLines(
  path: string,
  visit: (start: number, end: number, prefix: string) => void,
  signal?: AbortSignal,
  prefixBytes = 0,
): Promise<void> {
  let offset = 0;
  let lineStart = 0;
  let prefix = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    throwIfAborted(signal);
    const buffer = chunk as Buffer;
    for (let start = 0; start < buffer.length;) {
      const newline = buffer.indexOf(10, start);
      const end = newline < 0 ? buffer.length : newline;
      if (prefix.length < prefixBytes)
        prefix = Buffer.concat([
          prefix,
          buffer.subarray(start, Math.min(end, start + prefixBytes - prefix.length)),
        ]);
      if (newline < 0) break;
      visit(lineStart, offset + newline + 1, prefix.toString("utf8"));
      lineStart = offset + newline + 1;
      prefix = Buffer.alloc(0);
      start = newline + 1;
    }
    offset += buffer.length;
  }
  throwIfAborted(signal);
  if (offset > lineStart) visit(lineStart, offset, prefix.toString("utf8"));
}

export async function indexDiffLines(path: string, signal?: AbortSignal) {
  const patches: { offset: number; lines: ChangedDiffLine[] }[] = [];
  let base = 0;
  let head = 0;
  let inHunk = false;
  await visitLines(
    path,
    (start, end, prefix) => {
      if (prefix.startsWith("diff --git ")) {
        patches.push({ offset: start, lines: [] });
        inHunk = false;
        return;
      }
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(prefix);
      if (hunk !== null) {
        base = Number(hunk[1]);
        head = Number(hunk[2]);
        inHunk = true;
        return;
      }
      if (!inHunk) return;
      const patch = patches.at(-1);
      if (prefix.startsWith("-")) patch?.lines.push({ revision: "base", line: base++, start, end });
      else if (prefix.startsWith("+"))
        patch?.lines.push({ revision: "head", line: head++, start, end });
      else if (prefix.startsWith(" ")) {
        base += 1;
        head += 1;
      }
    },
    signal,
    256,
  );
  return patches;
}

export async function indexSourceLines(
  source: string,
  wanted: ReadonlySet<number>,
  signal?: AbortSignal,
): Promise<SourceLineIndex["lines"]> {
  const lines: { line: number; start: number; end: number }[] = [];
  if (wanted.size === 0) return lines;
  let line = 0;
  await visitLines(
    source,
    (start, end) => {
      line += 1;
      if (wanted.has(line)) lines.push({ line, start, end });
    },
    signal,
  );
  return lines;
}

function contains(intervals: readonly ReviewLineRange[], start: number, end: number): boolean {
  return intervals.some(([left, right]) => left <= start && right >= end);
}

function compactLines(lines: ReadonlySet<number>): ReviewLineRange[] {
  const ranges: [number, number][] = [];
  for (const line of [...lines].sort((left, right) => left - right)) {
    const last = ranges.at(-1);
    if (last?.[1] === line) last[1] = line + 1;
    else ranges.push([line, line + 1]);
  }
  return ranges;
}

export function changedSourceLines(
  files: readonly DiffFileSpan[],
  path: string,
  revision: "base" | "head",
): ReadonlySet<number> {
  return new Set(
    files.flatMap((file) =>
      (revision === "head" ? file.paths[0] : (file.paths[1] ?? file.paths[0])) === path
        ? (file.changedLines ?? [])
            .filter((line) => line.revision === revision)
            .map((line) => line.line)
        : [],
    ),
  );
}

export function collectLineCoverage(
  files: readonly ChangedFile[],
  indexed: readonly DiffFileSpan[],
  delivered: readonly SourceDelivery[],
  sourceIndexes: readonly SourceLineIndex[],
  references: readonly ReviewEvidenceReference[],
): readonly ReviewFileLineCoverage[] {
  return files.map((file) => {
    const span = indexed.find((candidate) => candidate.paths[0] === file.path);
    const added = new Set<number>();
    const deleted = new Set<number>();
    const diffs = delivered.filter(
      (item) =>
        span !== undefined &&
        item.source.kind === "repository_diff" &&
        item.range.totalBytes === span.size &&
        JSON.stringify(item.range.paths) === JSON.stringify(span.paths),
    );
    const fromSources = { base: new Set<number>(), head: new Set<number>() };
    for (const source of sourceIndexes) {
      const path = source.revision === "head" ? file.path : (file.previousPath ?? file.path);
      if (source.path !== path) continue;
      const reads = delivered.filter(
        (item) =>
          item.source.kind === "repository_file" &&
          item.source.path === path &&
          item.source.revision === source.revision &&
          item.range.totalBytes === source.size,
      );
      for (const bounds of source.lines)
        if (reads.some((item) => contains(item.intervals, bounds.start, bounds.end)))
          fromSources[source.revision].add(bounds.line);
    }
    const native = references.filter(
      (reference) =>
        reference.kind === "repository_read" &&
        reference.status === "complete" &&
        reference.path === file.path &&
        reference.revision === "head" &&
        reference.bounds?.startLine !== undefined &&
        reference.bounds.numLines !== undefined,
    );
    for (const line of span?.changedLines ?? []) {
      const fromNative =
        line.revision === "head" &&
        native.some(
          (reference) =>
            reference.bounds?.startLine !== undefined &&
            reference.bounds.numLines !== undefined &&
            reference.bounds.startLine <= line.line &&
            reference.bounds.startLine + reference.bounds.numLines > line.line,
        );
      if (
        fromSources[line.revision].has(line.line) ||
        fromNative ||
        diffs.some((item) => contains(item.intervals, line.start, line.end))
      )
        (line.revision === "head" ? added : deleted).add(line.line);
    }
    return {
      path: file.path,
      addedLines: compactLines(added),
      deletedLines: compactLines(deleted),
    };
  });
}

export class ReviewCoverageTracker {
  private readonly sources = new Map<string, SourceLineIndex>();

  constructor(
    private readonly files: readonly ChangedFile[],
    private readonly indexed?: readonly DiffFileSpan[],
  ) {}

  checkpoint(): readonly SourceLineIndex[] {
    return [...this.sources.values()];
  }

  inherit(sources: readonly SourceLineIndex[]): void {
    for (const source of sources)
      this.sources.set(JSON.stringify([source.path, source.revision]), source);
  }

  async indexSource(
    path: string,
    revision: "base" | "head",
    source: { readonly path: string; readonly sizeBytes: number },
    signal?: AbortSignal,
  ): Promise<void> {
    const key = JSON.stringify([path, revision]);
    if (this.indexed === undefined || this.sources.has(key)) return;
    const lines = await indexSourceLines(
      source.path,
      changedSourceLines(this.indexed, path, revision),
      signal,
    );
    this.sources.set(key, { path, revision, size: source.sizeBytes, lines });
  }

  inspection(
    inspection: ReviewInspection,
    delivered: readonly SourceDelivery[],
    references: readonly ReviewEvidenceReference[],
  ): ReviewInspection {
    if (this.indexed === undefined || this.indexed.some((file) => file.changedLines === undefined))
      return inspection;
    return {
      ...inspection,
      lineCoverage: collectLineCoverage(
        this.files,
        this.indexed,
        delivered,
        this.checkpoint(),
        references,
      ),
    };
  }
}
