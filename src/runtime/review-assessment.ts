import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";
import type {
  ChangedFile,
  GoalResult,
  GoalSubmission,
  ReviewFindingEvidence,
  ReviewInspection,
  ReviewEvidenceBounds,
  ReviewEvidenceReference,
  ReviewFinding,
  ReviewModelUsage,
  ReviewSourceRange,
} from "../lib/types.js";
import {
  isGitMetadataPath,
  isWithinRepository,
  mergeDeliveredRanges,
} from "./agent-review-tools.js";
import { withTokenUsage, type AcceptedSubmissionMcpStatus } from "./agent-logging.js";

const MAX_EVIDENCE_CURSORS = 32;
export const evidenceRefSchema = z.string().regex(/^ev-[1-9][0-9]{0,8}$/u);
export const pathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((path) => path.trim().length > 0);

export function acceptedSubmissionResult(
  goal: string,
  submission: GoalSubmission,
  status: AcceptedSubmissionMcpStatus,
  models: readonly ReviewModelUsage[],
  tokenAccountingComplete: boolean,
): GoalResult {
  const configuredMcpError =
    status.error === undefined
      ? status.failures.length === 0
        ? undefined
        : `Configured MCP server failure: ${status.failures}`
      : `Configured MCP server status check failed: ${status.error}`;
  const error =
    configuredMcpError ??
    (submission.limitations.length === 0
      ? undefined
      : `Required review investigation remains incomplete for: ${[...new Set(submission.limitations.flatMap((limit) => limit.paths))].slice(0, 20).join(", ") || "goal-wide requirements"}.`);
  return withTokenUsage(
    {
      prompt: goal,
      status:
        configuredMcpError !== undefined
          ? "failed"
          : submission.limitations.length > 0
            ? "incomplete"
            : "completed",
      submission,
      ...(error === undefined ? {} : { error }),
    },
    models,
    tokenAccountingComplete,
  );
}

export const reviewLimitationSchema = z
  .object({
    paths: z.array(pathSchema).max(100),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const findingEvidenceShape = {
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(200),
  countercheck: z.string().trim().min(1).max(1_000),
  counterevidenceRefs: z.array(evidenceRefSchema).max(200),
};

export const reviewEvidenceResultSchema = z
  .object({
    id: evidenceRefSchema,
    kind: z.enum([
      "repository_diff",
      "repository_file",
      "repository_read",
      "repository_search",
      "repository_glob",
      "context_file",
      "conversation",
      "briefing",
      "external_tool",
    ]),
    status: z.enum(["complete", "partial", "failed"]),
    completedBy: evidenceRefSchema.optional(),
    path: pathSchema.optional(),
    paths: z.array(pathSchema).max(50).optional(),
    revision: z.enum(["base", "head"]).optional(),
    mergeBaseSha: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu)
      .optional(),
    headSha: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu)
      .optional(),
    changedPaths: z.boolean().optional(),
    contentKind: z.enum(["text", "binary", "non_regular", "missing"]).optional(),
    bounds: z
      .object({
        byteStart: z.number().int().nonnegative().optional(),
        byteEnd: z.number().int().nonnegative().optional(),
        totalBytes: z.number().int().nonnegative().optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().nonnegative().optional(),
        headLimit: z.number().int().nonnegative().optional(),
        pages: z.string().min(1).max(100).optional(),
        truncated: z.boolean().optional(),
        startLine: z.number().int().positive().optional(),
        numLines: z.number().int().nonnegative().optional(),
        totalLines: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface RepositoryReviewToolCall {
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly tool_use_id: string;
  readonly tool_response?: unknown;
}

type EvidenceCursorContext = Pick<
  ReviewEvidenceReference,
  | "kind"
  | "path"
  | "paths"
  | "revision"
  | "mergeBaseSha"
  | "headSha"
  | "changedPaths"
  | "contentKind"
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

export function toolResponseDocument(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (Array.isArray(value)) {
    for (const block of value) {
      const parsed = toolResponseDocument(block);
      if (parsed !== undefined) return parsed;
    }
    return undefined;
  }
  if (isRecord(value)) {
    if (isText(value.text)) {
      try {
        const parsed: unknown = JSON.parse(value.text);
        if (isRecord(parsed)) return parsed;
      } catch {
        return undefined;
      }
    }
    const content = value.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const parsed = toolResponseDocument(block);
        if (parsed !== undefined) return parsed;
      }
    }
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function explicitToolFailure(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.is_error === true || value.isError === true || value.error !== undefined) return true;
  return Array.isArray(value.content) && value.content.some(explicitToolFailure);
}

function expiredCursorFailure(result: Readonly<Record<string, unknown>> | undefined): boolean {
  if (result?.error === "The cursor is unknown, expired, or already complete.") return true;
  return (
    Array.isArray(result?.content) &&
    result.content.some(
      (block) =>
        isRecord(block) &&
        typeof block.text === "string" &&
        block.text.startsWith("The cursor is unknown, expired, or already complete."),
    )
  );
}

function nonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const sourceRangeSchema = z
  .object({
    paths: z.array(pathSchema).min(1).max(2),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict()
  .refine((range) => range.start <= range.end && range.end <= range.totalBytes);
const sourceRangesSchema = z.array(sourceRangeSchema).max(3_000);

function hasTruncationMarker(value: unknown): boolean {
  if (typeof value === "string") return /\[output truncated(?: at [^\]]+)?\]/iu.test(value);
  if (Array.isArray(value)) return value.some(hasTruncationMarker);
  if (!isRecord(value)) return false;
  if (
    value.truncated === true ||
    value.truncatedByTokenCap === true ||
    value.countIsComplete === false
  )
    return true;
  return ["content", "text", "file"].some((key) => hasTruncationMarker(value[key]));
}

function nativeQueryAssessment(
  cwd: string,
  name: string,
  inputValue: unknown,
  result: Readonly<Record<string, unknown>> | undefined,
): { readonly partial: boolean; readonly bounds?: ReviewEvidenceBounds } {
  if (!isRecord(inputValue) || (name !== "Read" && name !== "Grep")) return { partial: false };
  if (name === "Read") {
    const file = result !== undefined && isRecord(result.file) ? result.file : undefined;
    const startLine = nonnegativeInteger(file?.startLine);
    const numLines = nonnegativeInteger(file?.numLines);
    const totalLines = nonnegativeInteger(file?.totalLines);
    const offset = inputValue.offset === undefined ? 1 : nonnegativeInteger(inputValue.offset);
    const limit = inputValue.limit === undefined ? undefined : nonnegativeInteger(inputValue.limit);
    const truncated = hasTruncationMarker(result);
    const verified =
      file !== undefined &&
      result?.type === "text" &&
      typeof file.content === "string" &&
      typeof file.filePath === "string" &&
      typeof inputValue.file_path === "string" &&
      resolve(cwd, file.filePath) === resolve(cwd, inputValue.file_path) &&
      startLine !== undefined &&
      startLine >= 1 &&
      startLine === offset &&
      numLines !== undefined &&
      totalLines !== undefined &&
      (numLines === 0
        ? totalLines === 0 && startLine === 1
        : startLine + numLines - 1 <= totalLines) &&
      (inputValue.limit === undefined || (limit !== undefined && limit > 0 && numLines <= limit)) &&
      inputValue.pages === undefined;
    return {
      partial: !verified || truncated,
      bounds: {
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { limit }),
        ...(verified ? { startLine, numLines, totalLines } : {}),
        ...(truncated ? { truncated: true } : {}),
      },
    };
  }

  const offset = nonnegativeInteger(inputValue.offset) ?? nonnegativeInteger(result?.appliedOffset);
  const limit =
    nonnegativeInteger(inputValue.head_limit) ?? nonnegativeInteger(result?.appliedLimit);
  const count = nonnegativeInteger(result?.mode === "content" ? result.numLines : result?.numFiles);
  const total = nonnegativeInteger(
    result?.mode === "content" ? result.totalLines : result?.totalFiles,
  );
  const truncated =
    hasTruncationMarker(result) ||
    (offset !== undefined && offset > 0) ||
    (total !== undefined && count !== undefined && total > count) ||
    (limit !== undefined &&
      limit > 0 &&
      count !== undefined &&
      count >= limit &&
      total === undefined);
  return {
    partial:
      truncated ||
      offset === undefined ||
      limit === undefined ||
      count === undefined ||
      (typeof inputValue.head_limit === "number" && inputValue.head_limit > 0),
    bounds: {
      ...(offset === undefined ? {} : { offset }),
      ...(limit === undefined ? {} : { headLimit: limit }),
      ...(truncated ? { truncated: true } : {}),
    },
  };
}

function repositoryRelativePath(cwd: string, value: unknown): string | undefined {
  if (!isText(value) || value.length === 0 || value.includes("\0")) return undefined;
  const candidate = isAbsolute(value) ? value : resolve(cwd, value);
  if (!isWithinRepository(cwd, candidate)) return undefined;
  const path = relative(resolve(cwd), resolve(candidate)).split(sep).join("/");
  if (path.length > 4_096 || isGitMetadataPath(path)) return undefined;
  return path.length === 0 ? "." : path;
}

function isRegularRepositoryReadPath(cwd: string, value: unknown): boolean {
  const path = repositoryRelativePath(cwd, value);
  if (path === undefined || path === ".") return false;
  let current: string;
  try {
    current = realpathSync(cwd);
  } catch {
    return false;
  }
  const components = path.split("/");
  for (const [index, component] of components.entries()) {
    current = resolve(current, component);
    try {
      const metadata = lstatSync(current);
      if (metadata.isSymbolicLink()) return false;
      if (index === components.length - 1 ? !metadata.isFile() : !metadata.isDirectory())
        return false;
    } catch {
      return false;
    }
  }
  return true;
}

function lookupReference(
  references: ReadonlyMap<string, ReviewEvidenceReference>,
  value: unknown,
): ReviewEvidenceReference | undefined {
  if (!isText(value)) return undefined;
  const reference = references.get(value);
  if (reference?.status !== "partial" || reference.completedBy === undefined) return reference;
  const completed = references.get(reference.completedBy);
  return completed?.status === "complete" && sameEvidenceScope(reference, completed)
    ? completed
    : reference;
}

function sameEvidenceScope(left: ReviewEvidenceReference, right: ReviewEvidenceReference): boolean {
  return (
    left.kind === right.kind &&
    left.path === right.path &&
    JSON.stringify(left.paths) === JSON.stringify(right.paths) &&
    left.revision === right.revision &&
    left.mergeBaseSha === right.mergeBaseSha &&
    left.headSha === right.headSha &&
    left.changedPaths === right.changedPaths &&
    left.contentKind === right.contentKind
  );
}

export interface ReviewValidationGap {
  readonly category: "inspection" | "evidence" | "schema" | "discussion" | "location" | "briefing";
  readonly message: string;
  readonly paths: readonly string[];
}

export function reviewFindingGaps(
  finding: ReviewFinding & ReviewFindingEvidence,
  changedFiles: readonly ChangedFile[],
  references: ReadonlyMap<string, ReviewEvidenceReference>,
): readonly ReviewValidationGap[] {
  const paths = finding.path === undefined ? [] : [finding.path];
  const gap = (message: string): ReviewValidationGap[] => [
    { category: "evidence", message, paths },
  ];
  const evidence = finding.evidenceRefs.map((id) => lookupReference(references, id));
  const counterevidence = finding.counterevidenceRefs.map((id) => lookupReference(references, id));
  if (
    [...evidence, ...counterevidence].some(
      (ref) => ref === undefined || ref.status !== "complete" || !isRepositoryEvidence(ref),
    )
  )
    return gap("Finding cites unknown, incomplete, or non-repository evidence.");
  const targets = finding.path === undefined ? changedFiles.map((file) => file.path) : paths;
  const supported = evidence.some(
    (reference) =>
      reference !== undefined &&
      targets.some((path) => {
        if (!evidenceCoversChangedPath(reference, path, changedFiles, true)) return false;
        if (reference.kind !== "repository_read" || wholeFileRead(reference)) return true;
        const { startLine, numLines } = reference.bounds ?? {};
        return (
          finding.line !== undefined &&
          startLine !== undefined &&
          numLines !== undefined &&
          finding.line >= startLine &&
          (finding.endLine ?? finding.line) < startLine + numLines
        );
      }),
  );
  return supported ? [] : gap("Finding lacks inspected evidence covering its changed location.");
}

function wholeFileRead(reference: ReviewEvidenceReference): boolean {
  return (
    reference.bounds?.startLine === 1 && reference.bounds.numLines === reference.bounds.totalLines
  );
}

export function reviewInspection(
  changedFiles: readonly ChangedFile[],
  references: ReadonlyMap<string, ReviewEvidenceReference>,
): ReviewInspection {
  const paths = [
    ...new Set(
      changedFiles.flatMap((file) => [
        file.path,
        ...(file.previousPath === undefined ? [] : [file.previousPath]),
      ]),
    ),
  ];
  const completed = [...references.keys()].flatMap((id) => {
    const reference = lookupReference(references, id);
    return reference?.status === "complete" ? [reference] : [];
  });
  const observedPaths = paths.filter((path) =>
    completed.some(
      (reference) =>
        evidenceCoversChangedPath(reference, path, changedFiles, false) &&
        (reference.kind !== "repository_read" || wholeFileRead(reference)),
    ),
  );
  const observed = new Set(observedPaths);
  return { observedPaths, missingPaths: paths.filter((path) => !observed.has(path)) };
}

export class ReviewEvidenceLedger {
  private sequence = 0;
  private readonly references = new Map<string, ReviewEvidenceReference>();
  private readonly cursors = new Map<string, EvidenceCursorContext>();
  private readonly queries = new Map<string, { pages: Map<number, string>; finalPage?: number }>();
  private readonly observedCalls = new Set<string>();
  private readonly delivered = new Map<
    string,
    {
      source: EvidenceCursorContext;
      range: ReviewSourceRange;
      intervals: [number, number][];
      references: string[];
    }
  >();
  private readonly nativeDelivered = new Map<string, [number, number][]>();
  private requiredBytes = 0;
  uniqueSourceBytes = 0;
  repeatedSourceBytes = 0;
  deliveries: Readonly<Record<string, unknown>>[] = [];

  constructor(
    private readonly cwd: string,
    private readonly files: readonly ChangedFile[] = [],
    private readonly snapshot?: { mergeBaseSha: string; headSha: string },
  ) {}

  get inspectionProgress(): number {
    return this.requiredBytes + reviewInspection(this.files, this.references).observedPaths.length;
  }

  hasPrefix(paths: readonly string[], start: number, revision?: "base" | "head"): boolean {
    if (start === 0) return true;
    return [...this.delivered.values()].some(
      (item) =>
        item.source.kind === (revision === undefined ? "repository_diff" : "repository_file") &&
        item.source.revision === revision &&
        JSON.stringify(item.range.paths) === JSON.stringify(paths) &&
        item.intervals[0]?.[0] === 0 &&
        item.intervals[0][1] >= start,
    );
  }

  private observeRanges(
    source: EvidenceCursorContext,
    ranges: readonly ReviewSourceRange[],
    callId: string,
    cursor: string | undefined,
    page: number,
  ): readonly ReviewEvidenceReference[] {
    const observed: ReviewEvidenceReference[] = [];
    const missing = new Set(reviewInspection(this.files, this.references).missingPaths);
    for (const range of ranges) {
      const scope: EvidenceCursorContext =
        source.kind === "repository_diff"
          ? {
              ...source,
              changedPaths: false,
              paths: range.paths,
            }
          : source;
      const key = JSON.stringify([
        scope.kind,
        scope.revision,
        scope.mergeBaseSha,
        scope.headSha,
        range.paths,
      ]);
      const previous = this.delivered.get(key);
      if (previous !== undefined && previous.range.totalBytes !== range.totalBytes)
        throw new Error("Source delivery changed size within an immutable snapshot.");
      const {
        intervals: merged,
        before,
        total,
      } = mergeDeliveredRanges(previous?.intervals ?? [], range.start, range.end);
      const added = total - before;
      const repeated = range.end - range.start - added;
      this.uniqueSourceBytes += added;
      this.repeatedSourceBytes += repeated;
      const complete = merged[0]?.[0] === 0 && merged[0][1] === range.totalBytes;
      const reference: ReviewEvidenceReference = {
        id: `ev-${++this.sequence}`,
        ...scope,
        status: complete ? "complete" : "partial",
        bounds: { byteStart: range.start, byteEnd: range.end, totalBytes: range.totalBytes },
      };
      if (
        range.paths.some(
          (path) =>
            missing.has(path) && evidenceCoversChangedPath(reference, path, this.files, false),
        )
      )
        this.requiredBytes += added;
      this.references.set(reference.id, reference);
      observed.push(reference);
      const ids = [...(previous?.references ?? []), reference.id];
      if (complete && before !== range.totalBytes)
        for (const id of ids) {
          const member = this.references.get(id);
          if (member !== undefined && id !== reference.id && member.status !== "complete")
            this.references.set(id, { ...member, completedBy: reference.id });
        }
      this.delivered.set(key, {
        source: scope,
        range,
        intervals: merged,
        references: complete ? [] : ids,
      });
      this.deliveries.push({
        toolCallId: callId,
        query: cursor ?? callId,
        page,
        ...scope,
        range,
        newBytes: added,
        repeatedBytes: repeated,
        fileComplete: complete,
        newlyCompletedPaths: complete && before !== range.totalBytes ? range.paths : [],
        evidenceRef: reference.id,
      });
    }
    return observed;
  }

  get issued(): ReadonlyMap<string, ReviewEvidenceReference> {
    return this.references;
  }

  observeBatch(calls: readonly RepositoryReviewToolCall[]): readonly ReviewEvidenceReference[] {
    this.deliveries = [];
    const observed: ReviewEvidenceReference[] = [];
    const expired = new Set<string>();
    for (const call of calls) {
      if (this.observedCalls.has(call.tool_use_id)) continue;
      this.observedCalls.add(call.tool_use_id);
      const source = this.source(call);
      if (source === undefined) continue;
      const result = toolResponseDocument(call.tool_response);
      const input = isRecord(call.tool_input) ? call.tool_input : {};
      const inputCursor = typeof input.cursor === "string" ? input.cursor : undefined;
      const nextCursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
      const cursor = inputCursor ?? nextCursor;
      const fixedPage =
        source.kind === "repository_diff" ||
        (source.kind === "repository_file" &&
          (result?.kind === "text" || source.contentKind === "text"));
      const page = nonnegativeInteger(result?.page);
      const nativeAssessment = nativeQueryAssessment(
        this.cwd,
        call.tool_name,
        call.tool_input,
        result,
      );
      const malformedPage =
        fixedPage &&
        (typeof result?.done !== "boolean" ||
          typeof result.content !== "string" ||
          page === undefined ||
          page < 1 ||
          (inputCursor === undefined && page !== 1) ||
          (!result.done && nextCursor === undefined) ||
          (inputCursor !== undefined && nextCursor !== undefined && inputCursor !== nextCursor));
      const status =
        call.tool_response === undefined ||
        malformedPage ||
        explicitToolFailure(call.tool_response) ||
        (result !== undefined && explicitToolFailure(result))
          ? "failed"
          : result?.done === false ||
              nativeAssessment.partial ||
              (fixedPage && cursor !== undefined)
            ? "partial"
            : "complete";
      if (
        fixedPage &&
        status !== "failed" &&
        (result?.ranges !== undefined || result?.byteOffset !== undefined)
      ) {
        const rangeInput =
          source.kind === "repository_diff"
            ? result.ranges
            : [
                {
                  paths: [source.path],
                  start: result.byteOffset,
                  end:
                    typeof result.byteOffset === "number"
                      ? result.byteOffset + Buffer.byteLength(String(result.content), "utf8")
                      : undefined,
                  totalBytes: result.sizeBytes,
                },
              ];
        const parsed = sourceRangesSchema.safeParse(rangeInput);
        const scope = {
          ...source,
          ...(source.kind === "repository_file" ? { contentKind: "text" as const } : {}),
          mergeBaseSha: result.mergeBaseSha as string,
          headSha: result.headSha as string,
        };
        const matchesSnapshot =
          this.snapshot === undefined ||
          (scope.mergeBaseSha === this.snapshot.mergeBaseSha &&
            scope.headSha === this.snapshot.headSha);
        const matchesCursor =
          inputCursor === undefined ||
          ((source.headSha === undefined || source.headSha === scope.headSha) &&
            (source.mergeBaseSha === undefined || source.mergeBaseSha === scope.mergeBaseSha));
        const valid =
          parsed.success &&
          matchesSnapshot &&
          matchesCursor &&
          parsed.data.reduce((sum, range) => sum + range.end - range.start, 0) ===
            Buffer.byteLength(String(result.content), "utf8") &&
          parsed.data.every(
            (range) =>
              source.kind !== "repository_diff" ||
              source.paths === undefined ||
              range.paths.some((path) => source.paths?.includes(path)),
          ) &&
          parsed.data.every(
            (range) =>
              this.files.length === 0 ||
              source.kind !== "repository_diff" ||
              this.files.some(
                (file) =>
                  JSON.stringify(range.paths) ===
                  JSON.stringify([
                    file.path,
                    ...(file.previousPath === undefined ? [] : [file.previousPath]),
                  ]),
              ),
          );
        if (valid) {
          observed.push(
            ...this.observeRanges(scope, parsed.data, call.tool_use_id, cursor, page as number),
          );
          if (nextCursor !== undefined) {
            if (!this.cursors.has(nextCursor) && this.cursors.size >= MAX_EVIDENCE_CURSORS) {
              const oldest = this.cursors.keys().next().value;
              if (oldest !== undefined) {
                this.cursors.delete(oldest);
                this.queries.delete(oldest);
              }
            }
            this.cursors.set(nextCursor, scope);
          }
          if (result.done === true && cursor !== undefined) this.cursors.delete(cursor);
        } else {
          const reference: ReviewEvidenceReference = {
            id: `ev-${++this.sequence}`,
            ...source,
            status: "failed",
          };
          this.references.set(reference.id, reference);
          observed.push(reference);
          this.deliveries.push({
            toolCallId: call.tool_use_id,
            query: cursor ?? call.tool_use_id,
            status: "failed",
            reason: "Invalid source ranges or snapshot identity.",
          });
        }
        continue;
      }
      const reference = reviewEvidenceResultSchema.parse({
        id: `ev-${++this.sequence}`,
        ...source,
        ...(nativeAssessment.bounds === undefined ? {} : { bounds: nativeAssessment.bounds }),
        ...(source.kind === "repository_diff"
          ? {
              ...(typeof result?.mergeBaseSha === "string"
                ? { mergeBaseSha: result.mergeBaseSha }
                : {}),
              ...(typeof result?.headSha === "string" ? { headSha: result.headSha } : {}),
            }
          : {}),
        ...(source.kind === "repository_file" &&
        (result?.kind === "text" ||
          result?.kind === "binary" ||
          result?.kind === "non_regular" ||
          result?.kind === "missing")
          ? { contentKind: result.kind }
          : {}),
        status,
      }) as ReviewEvidenceReference;
      if (isRepositoryEvidence(reference) && reference.kind !== "repository_search") {
        let newLines: number | undefined;
        let repeatedLines: number | undefined;
        const bounds = reference.bounds;
        if (
          reference.kind === "repository_read" &&
          reference.status === "complete" &&
          reference.path !== undefined &&
          bounds?.startLine !== undefined &&
          bounds.numLines !== undefined
        ) {
          const key = JSON.stringify([reference.path, reference.revision, bounds.totalLines]);
          const update = mergeDeliveredRanges(
            this.nativeDelivered.get(key) ?? [],
            bounds.startLine,
            bounds.startLine + bounds.numLines,
          );
          newLines = update.total - update.before;
          repeatedLines = bounds.numLines - newLines;
          if (
            reviewInspection(this.files, this.references).missingPaths.includes(reference.path) &&
            evidenceCoversChangedPath(reference, reference.path, this.files, false)
          )
            this.requiredBytes += newLines;
          this.nativeDelivered.set(key, update.intervals);
        }
        this.deliveries.push({
          toolCallId: call.tool_use_id,
          query: cursor ?? call.tool_use_id,
          page,
          kind: reference.kind,
          path: reference.path,
          paths: reference.paths,
          revision: reference.revision,
          status: reference.status,
          range: reference.bounds,
          newLines,
          repeatedLines,
          ...(reference.status === "failed"
            ? { reason: "Source tool failed or returned an invalid page." }
            : {}),
          evidenceRef: reference.id,
        });
      }
      this.references.set(reference.id, reference);
      observed.push(reference);
      if (nextCursor !== undefined && status !== "failed") {
        const cursorSource: EvidenceCursorContext = {
          kind: reference.kind,
          ...(reference.path === undefined ? {} : { path: reference.path }),
          ...(reference.paths === undefined ? {} : { paths: reference.paths }),
          ...(reference.revision === undefined ? {} : { revision: reference.revision }),
          ...(reference.mergeBaseSha === undefined ? {} : { mergeBaseSha: reference.mergeBaseSha }),
          ...(reference.headSha === undefined ? {} : { headSha: reference.headSha }),
          ...(reference.changedPaths === undefined ? {} : { changedPaths: reference.changedPaths }),
          ...(reference.contentKind === undefined ? {} : { contentKind: reference.contentKind }),
        };
        if (!this.cursors.has(nextCursor) && this.cursors.size >= MAX_EVIDENCE_CURSORS) {
          const oldest = this.cursors.keys().next().value;
          if (oldest !== undefined) {
            this.cursors.delete(oldest);
            this.queries.delete(oldest);
          }
        }
        this.cursors.set(nextCursor, cursorSource);
      }
      if (cursor !== undefined && fixedPage && status !== "failed" && page !== undefined) {
        const query: { pages: Map<number, string>; finalPage?: number } = this.queries.get(
          cursor,
        ) ?? { pages: new Map<number, string>() };
        query.pages.set(page, reference.id);
        if (result?.done === true) query.finalPage = page;
        this.queries.set(cursor, query);
      } else if (
        inputCursor !== undefined &&
        ((!fixedPage && status !== "failed" && nextCursor === undefined) ||
          expiredCursorFailure(result))
      ) {
        expired.add(inputCursor);
      }
    }
    for (const [cursor, query] of this.queries) {
      const finalPage = query.finalPage;
      if (finalPage === undefined || query.pages.size !== finalPage) continue;
      const finalId = query.pages.get(finalPage);
      const last = finalId === undefined ? undefined : this.references.get(finalId);
      if (last === undefined || last.status === "failed") continue;
      const members = Array.from({ length: finalPage }, (_, index) =>
        this.references.get(query.pages.get(index + 1) ?? ""),
      );
      if (
        members.some(
          (reference) =>
            reference === undefined ||
            reference.status === "failed" ||
            !sameEvidenceScope(reference, last),
        )
      )
        continue;
      this.references.set(last.id, { ...last, status: "complete" });
      for (const reference of members) {
        if (reference !== undefined && reference.id !== last.id)
          this.references.set(reference.id, { ...reference, completedBy: last.id });
      }
      expired.add(cursor);
    }
    for (const cursor of expired) {
      this.cursors.delete(cursor);
      this.queries.delete(cursor);
    }
    return observed.map((reference) => this.references.get(reference.id) ?? reference);
  }

  referencesForPaths(paths: readonly string[]): readonly ReviewEvidenceReference[] {
    return [...this.references.values()].filter((reference) =>
      paths.some(
        (path) =>
          reference.changedPaths === true ||
          reference.path === path ||
          reference.paths?.includes(path) === true,
      ),
    );
  }

  eligibleReferences(path: string, changedFiles: readonly ChangedFile[]): readonly string[] {
    return [...this.references.keys()].filter((id) => {
      const reference = lookupReference(this.references, id);
      return (
        reference !== undefined &&
        reference.status === "complete" &&
        evidenceCoversChangedPath(reference, path, changedFiles, true)
      );
    });
  }

  renderReferences(references: readonly ReviewEvidenceReference[], limit = 1_400): string {
    const lines: string[] = [];
    let used = 0;
    for (const reference of references) {
      const location =
        reference.paths === undefined
          ? (reference.path ?? "repository-wide")
          : reference.paths.length > 1
            ? `${reference.paths[0]} (+${reference.paths.length - 1} paths)`
            : (reference.paths[0] ?? "repository-wide");
      const boundedLocation =
        location.length <= 220
          ? location
          : `${location.slice(0, 160)}…${location.slice(-40)} (${location.length} chars)`;
      const line = `${reference.id} ${reference.status} ${reference.kind} ${JSON.stringify(boundedLocation)}${reference.revision === undefined ? "" : ` ${reference.revision}`}${reference.bounds === undefined ? "" : ` ${JSON.stringify(reference.bounds)}`}${reference.completedBy === undefined ? "" : ` completed_query=${reference.completedBy}`}`;
      if (used + line.length + 1 > limit) break;
      lines.push(line);
      used += line.length + 1;
    }
    const omitted = references.length - lines.length;
    return `Host-issued evidence references (status is per observed page):\n${lines.join("\n")}${omitted > 0 ? `\n${omitted} additional references are omitted; call read_review_state to retrieve existing evidence without rereading source.` : ""}`;
  }

  private source(
    call: RepositoryReviewToolCall,
  ): Omit<ReviewEvidenceReference, "id" | "status"> | undefined {
    const internalMcpToolPrefix = "mcp__review_output__";
    if (call.tool_name.startsWith("mcp__") && !call.tool_name.startsWith(internalMcpToolPrefix)) {
      return { kind: "external_tool" };
    }
    const name = call.tool_name.startsWith(internalMcpToolPrefix)
      ? call.tool_name.slice(internalMcpToolPrefix.length)
      : call.tool_name;
    if (name === "submit_review" || name === "read_review_state") return undefined;
    const input = isRecord(call.tool_input) ? call.tool_input : {};
    if (name === "read_pr_diff") {
      const cursor = input.cursor;
      if (typeof cursor === "string") return this.cursors.get(cursor);
      const selected = Array.isArray(input.paths)
        ? input.paths.filter((path): path is string => isText(path))
        : undefined;
      return {
        kind: "repository_diff",
        changedPaths: selected === undefined || selected.length === 0,
        ...(selected === undefined || selected.length === 0 ? {} : { paths: selected }),
      };
    }
    if (name === "read_repository_file") {
      const cursor = input.cursor;
      if (typeof cursor === "string") return this.cursors.get(cursor);
      const path = input.path;
      if (!isText(path) || (input.revision !== "base" && input.revision !== "head"))
        return undefined;
      return { kind: "repository_file", path, revision: input.revision };
    }
    if (name === "Read") {
      const path = repositoryRelativePath(this.cwd, input.file_path);
      return path === undefined || !isRegularRepositoryReadPath(this.cwd, input.file_path)
        ? undefined
        : { kind: "repository_read", path, revision: "head" };
    }
    if (name === "Grep") {
      const path = repositoryRelativePath(this.cwd, input.path ?? ".");
      return path === undefined ? undefined : { kind: "repository_search", path, revision: "head" };
    }
    if (name === "Glob") {
      const path = repositoryRelativePath(this.cwd, input.path ?? ".");
      return path === undefined ? undefined : { kind: "repository_glob", path, revision: "head" };
    }
    if (name === "read_context_file") {
      if (!isText(input.path)) return undefined;
      return { kind: "context_file", path: input.path };
    }
    if (name === "read_pr_conversation") return { kind: "conversation" };
    if (name === "read_review_briefing") return { kind: "briefing" };
    if (name === "read_pr_threads") {
      const cursor = input.cursor;
      if (typeof cursor === "string") return this.cursors.get(cursor);
      const path = isText(input.path) ? input.path : undefined;
      return { kind: "conversation", ...(path === undefined ? {} : { path }) };
    }
    return undefined;
  }
}

export function evidenceCoversPath(reference: ReviewEvidenceReference, path: string): boolean {
  if (!isRepositoryEvidence(reference)) return false;
  if (reference.kind === "repository_file" && reference.contentKind !== "text") return false;
  if (reference.changedPaths === true) return true;
  if (reference.paths?.includes(path) === true) return true;
  return reference.path === path;
}

export function evidenceCoversChangedPath(
  reference: ReviewEvidenceReference,
  path: string,
  changedFiles: readonly ChangedFile[],
  allowSearch = true,
): boolean {
  if (
    (!allowSearch && reference.kind === "repository_search") ||
    !evidenceCoversPath(reference, path)
  )
    return false;
  const file = changedFiles.find((file) => file.path === path || file.previousPath === path);
  if (file === undefined) return false;
  if (reference.kind === "repository_diff") return true;
  const revision =
    file.status === "removed" || (file.previousPath === path && file.path !== path)
      ? "base"
      : "head";
  return reference.revision === revision;
}

function isRepositoryEvidence(reference: ReviewEvidenceReference): boolean {
  return (
    reference.kind === "repository_diff" ||
    reference.kind === "repository_file" ||
    reference.kind === "repository_read" ||
    reference.kind === "repository_search"
  );
}

export const reviewAssessmentInternals = {
  evidenceCoversPath,
  isRepositoryEvidence,
  explicitToolFailure,
  repositoryRelativePath,
  toolResponseDocument,
};
