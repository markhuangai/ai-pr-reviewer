import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type {
  ChangedFile,
  GoalResult,
  GoalSubmission,
  ReviewAssessment,
  ReviewEvidenceBounds,
  ReviewEvidenceReference,
  ReviewFinding,
  ReviewModelUsage,
} from "../lib/types.js";
import { isGitMetadataPath, isWithinRepository } from "./agent-review-tools.js";
import { withTokenUsage, type AcceptedSubmissionMcpStatus } from "./agent-logging.js";

const MAX_ASSESSMENT_PATHS_PER_ENTRY = 100;
const MAX_ASSESSMENT_REFERENCES = 200;
const MAX_EVIDENCE_CURSORS = 32;
const evidenceRefSchema = z.string().regex(/^ev-[1-9][0-9]{0,8}$/u);
const pathSchema = z
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
  const incompletePaths = [
    ...new Set(
      submission.assessment.coverage
        .filter((entry) => entry.disposition === "incomplete")
        .flatMap((entry) => entry.paths),
    ),
  ];
  const error =
    configuredMcpError ??
    (incompletePaths.length === 0
      ? undefined
      : `Required review investigation is incomplete for: ${incompletePaths
          .slice(0, 20)
          .map((path) => JSON.stringify(path))
          .join(
            ", ",
          )}${incompletePaths.length > 20 ? ` and ${incompletePaths.length - 20} more path(s)` : ""}.`);
  return withTokenUsage(
    {
      prompt: goal,
      status:
        configuredMcpError !== undefined
          ? "failed"
          : incompletePaths.length > 0
            ? "incomplete"
            : "completed",
      submission,
      ...(error === undefined ? {} : { error }),
    },
    models,
    tokenAccountingComplete,
  );
}

const reviewCoverageSchema = z
  .object({
    paths: z.array(pathSchema).min(1).max(MAX_ASSESSMENT_PATHS_PER_ENTRY),
    disposition: z.enum(["reviewed", "not_applicable", "incomplete"]),
    rationale: z.string().trim().min(1).max(1_000),
    evidenceRefs: z.array(evidenceRefSchema).max(MAX_ASSESSMENT_REFERENCES),
  })
  .strict();

const reviewCandidateSchema = z
  .object({
    paths: z.array(pathSchema).min(1).max(MAX_ASSESSMENT_PATHS_PER_ENTRY),
    trigger: z.string().trim().min(1).max(1_000),
    impact: z.string().trim().min(1).max(1_000),
    evidenceRefs: z.array(evidenceRefSchema).max(MAX_ASSESSMENT_REFERENCES),
    countercheck: z.string().trim().min(1).max(1_000),
    counterevidenceRefs: z.array(evidenceRefSchema).max(MAX_ASSESSMENT_REFERENCES),
    verdict: z.enum(["supported", "disproved", "unresolved"]),
    findingIndex: z
      .number()
      .int()
      .min(0)
      .max(99)
      .optional()
      .describe("Zero-based index of the finding supported by this candidate."),
  })
  .strict();

export const reviewAssessmentSchema = z
  .object({
    coverage: z
      .array(reviewCoverageSchema)
      .max(1_000)
      .describe(
        "Classify every changed path exactly once; reviewed and not_applicable require completed repository evidence.",
      ),
    candidates: z
      .array(reviewCandidateSchema)
      .max(100)
      .describe("Assess material defect hypotheses and link supported ones to findings."),
  })
  .strict();

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
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().nonnegative().optional(),
        headLimit: z.number().int().nonnegative().optional(),
        pages: z.string().min(1).max(100).optional(),
        truncated: z.boolean().optional(),
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

function toolResponseDocument(value: unknown): Readonly<Record<string, unknown>> | undefined {
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
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

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
  name: string,
  inputValue: unknown,
  result: Readonly<Record<string, unknown>> | undefined,
): { readonly partial: boolean; readonly bounds?: ReviewEvidenceBounds } {
  if (!isRecord(inputValue) || (name !== "Read" && name !== "Grep")) return { partial: false };

  const inputOffset = nonnegativeInteger(inputValue.offset);
  const inputLimit = nonnegativeInteger(name === "Read" ? inputValue.limit : inputValue.head_limit);
  const file = result !== undefined && isRecord(result.file) ? result.file : undefined;
  const startLine = nonnegativeInteger(file?.startLine);
  const numLines = nonnegativeInteger(file?.numLines);
  const totalLines = nonnegativeInteger(file?.totalLines);
  const appliedOffset = nonnegativeInteger(result?.appliedOffset);
  const appliedLimit = nonnegativeInteger(result?.appliedLimit);
  const pages = typeof inputValue.pages === "string" ? inputValue.pages : undefined;
  const recordedOffset =
    inputOffset ??
    (name === "Read" && startLine !== undefined ? Math.max(0, startLine - 1) : appliedOffset);
  const recordedLimit = inputLimit ?? (name === "Read" ? numLines : appliedLimit);
  const count =
    result?.mode === "content"
      ? nonnegativeInteger(result.numLines)
      : nonnegativeInteger(result?.numFiles);
  const total =
    result?.mode === "content"
      ? nonnegativeInteger(result.totalLines)
      : nonnegativeInteger(result?.totalFiles);
  const hasTruncation =
    hasTruncationMarker(result) ||
    (name === "Read" &&
      ((startLine !== undefined && startLine > 1) ||
        (numLines !== undefined && totalLines !== undefined && numLines < totalLines))) ||
    (name === "Grep" &&
      ((appliedOffset !== undefined && appliedOffset > 0) ||
        (total !== undefined && count !== undefined && total > count) ||
        (appliedLimit !== undefined &&
          appliedLimit > 0 &&
          count !== undefined &&
          count >= appliedLimit &&
          (total === undefined || total > count))));
  const bounded =
    name === "Read"
      ? (inputOffset !== undefined && inputOffset > 0) ||
        inputValue.limit !== undefined ||
        pages !== undefined
      : (inputOffset !== undefined && inputOffset > 0) ||
        (inputLimit !== undefined && inputLimit > 0);
  const hostCannotVerify =
    name === "Read"
      ? file === undefined ||
        startLine === undefined ||
        numLines === undefined ||
        totalLines === undefined
      : recordedOffset === undefined || recordedLimit === undefined || count === undefined;
  const bounds: ReviewEvidenceBounds = {
    ...(recordedOffset === undefined ? {} : { offset: recordedOffset }),
    ...(recordedLimit === undefined
      ? {}
      : name === "Read"
        ? { limit: recordedLimit }
        : { headLimit: recordedLimit }),
    ...(pages === undefined ? {} : { pages }),
    ...(hasTruncation ? { truncated: true } : {}),
  };
  return {
    partial: bounded || hasTruncation || hostCannotVerify,
    ...(Object.keys(bounds).length === 0 ? {} : { bounds }),
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

function lookupReference(
  references: ReadonlyMap<string, ReviewEvidenceReference>,
  value: unknown,
): ReviewEvidenceReference | undefined {
  return isText(value) ? references.get(value) : undefined;
}

export function findInvalidReviewAssessment(
  assessment: ReviewAssessment,
  findings: readonly ReviewFinding[],
  changedFiles: readonly ChangedFile[],
  references: ReadonlyMap<string, ReviewEvidenceReference>,
): readonly string[] {
  const validPaths = new Set(
    changedFiles.flatMap((file) => [
      file.path,
      ...(file.previousPath === undefined ? [] : [file.previousPath]),
    ]),
  );
  const issues: string[] = [];
  const classifiedPaths = new Set<string>();
  for (let index = 0; index < assessment.coverage.length; index += 1) {
    const coverage = assessment.coverage[index];
    if (coverage === undefined) continue;
    const pathSet = new Set(coverage.paths);
    if (pathSet.size !== coverage.paths.length) issues.push(`coverage ${index + 1} repeats a path`);
    const resolvedRefs = coverage.evidenceRefs.map((id) => lookupReference(references, id));
    if (resolvedRefs.some((reference) => reference === undefined)) {
      issues.push(`coverage ${index + 1} cites unknown evidence`);
      continue;
    }
    for (const path of coverage.paths) {
      if (!validPaths.has(path)) {
        issues.push(`coverage ${index + 1} cites unchanged path ${JSON.stringify(path)}`);
        continue;
      }
      if (classifiedPaths.has(path)) {
        issues.push(`changed path ${JSON.stringify(path)} is classified more than once`);
        continue;
      }
      classifiedPaths.add(path);
      if (
        coverage.disposition !== "incomplete" &&
        !resolvedRefs.some(
          (reference) =>
            reference !== undefined &&
            reference.status === "complete" &&
            isRepositoryEvidence(reference) &&
            evidenceCoversPathForCoverage(reference, path),
        )
      ) {
        issues.push(
          `${coverage.disposition} path ${JSON.stringify(path)} has no completed repository evidence`,
        );
      }
    }
  }
  for (const path of validPaths) {
    if (!classifiedPaths.has(path))
      issues.push(`changed path ${JSON.stringify(path)} has no coverage classification`);
  }

  const findingsByIndex = new Map<number, number>();
  for (let index = 0; index < assessment.candidates.length; index += 1) {
    const candidate = assessment.candidates[index];
    if (candidate === undefined) continue;
    const evidence = candidate.evidenceRefs.map((id) => lookupReference(references, id));
    const counterevidence = candidate.counterevidenceRefs.map((id) =>
      lookupReference(references, id),
    );
    if (evidence.some((reference) => reference === undefined)) {
      issues.push(`candidate ${index + 1} cites unknown evidence`);
      continue;
    }
    if (counterevidence.some((reference) => reference === undefined)) {
      issues.push(`candidate ${index + 1} cites unknown counterevidence`);
      continue;
    }
    if (candidate.evidenceRefs.length === 0) {
      issues.push(`candidate ${index + 1} has no host-issued evidence`);
    }
    if (
      candidate.verdict === "supported" &&
      candidate.paths.some(
        (path) =>
          !evidence.some(
            (reference) =>
              reference !== undefined &&
              reference.status === "complete" &&
              isRepositoryEvidence(reference) &&
              evidenceCoversPath(reference, path),
          ),
      )
    ) {
      issues.push(`supported candidate ${index + 1} lacks evidence for an affected path`);
    }
    if (candidate.verdict === "disproved" && candidate.counterevidenceRefs.length === 0) {
      issues.push(`disproved candidate ${index + 1} has no counterevidence`);
    }
    if (
      candidate.verdict === "disproved" &&
      !counterevidence.some(
        (reference) =>
          reference !== undefined &&
          reference.status === "complete" &&
          isRepositoryEvidence(reference),
      )
    ) {
      issues.push(`disproved candidate ${index + 1} has no completed repository counterevidence`);
    }
    for (const path of candidate.paths) {
      if (!validPaths.has(path))
        issues.push(`candidate ${index + 1} cites unchanged path ${JSON.stringify(path)}`);
    }
    if (candidate.verdict === "supported") {
      if (candidate.findingIndex === undefined || candidate.findingIndex >= findings.length) {
        issues.push(`supported candidate ${index + 1} does not identify its finding`);
      } else {
        findingsByIndex.set(
          candidate.findingIndex,
          (findingsByIndex.get(candidate.findingIndex) ?? 0) + 1,
        );
        const findingPath = findings[candidate.findingIndex]?.path;
        if (findingPath !== undefined && !candidate.paths.includes(findingPath)) {
          issues.push(`finding ${candidate.findingIndex + 1} is not linked to its changed path`);
        }
      }
    } else if (candidate.findingIndex !== undefined) {
      issues.push(`non-supported candidate ${index + 1} identifies a finding`);
    }
  }
  for (let index = 0; index < findings.length; index += 1) {
    if (findingsByIndex.get(index) !== 1)
      issues.push(`finding ${index + 1} needs one supported candidate`);
  }
  return issues;
}

export class ReviewEvidenceLedger {
  private sequence = 0;
  private readonly references = new Map<string, ReviewEvidenceReference>();
  private readonly cursors = new Map<string, EvidenceCursorContext>();

  constructor(private readonly cwd: string) {}

  get issued(): ReadonlyMap<string, ReviewEvidenceReference> {
    return this.references;
  }

  observeBatch(calls: readonly RepositoryReviewToolCall[]): readonly ReviewEvidenceReference[] {
    const observed: ReviewEvidenceReference[] = [];
    for (const call of calls) {
      const source = this.source(call);
      if (source === undefined) continue;
      const result = toolResponseDocument(call.tool_response);
      const nativeAssessment = nativeQueryAssessment(call.tool_name, call.tool_input, result);
      const missingDiffPageMetadata =
        source.kind === "repository_diff" &&
        (typeof result?.done !== "boolean" || typeof result.content !== "string");
      const status =
        call.tool_response === undefined ||
        missingDiffPageMetadata ||
        explicitToolFailure(call.tool_response) ||
        (result !== undefined && explicitToolFailure(result))
          ? "failed"
          : result?.done === false || nativeAssessment.partial
            ? "partial"
            : "complete";
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
      this.references.set(reference.id, reference);
      observed.push(reference);
      const cursor = result?.nextCursor;
      if (typeof cursor === "string") {
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
        if (!this.cursors.has(cursor) && this.cursors.size >= MAX_EVIDENCE_CURSORS) {
          const oldest = this.cursors.keys().next().value;
          if (oldest !== undefined) this.cursors.delete(oldest);
        }
        this.cursors.set(cursor, cursorSource);
      } else if (
        isRecord(call.tool_input) &&
        typeof call.tool_input.cursor === "string" &&
        (status !== "failed" || expiredCursorFailure(result))
      ) {
        this.cursors.delete(call.tool_input.cursor);
      }
    }
    return observed;
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
      const line = `${reference.id} ${reference.status} ${reference.kind} ${JSON.stringify(boundedLocation)}${reference.revision === undefined ? "" : ` ${reference.revision}`}${reference.bounds === undefined ? "" : ` ${JSON.stringify(reference.bounds)}`}`;
      if (used + line.length + 1 > limit) break;
      lines.push(line);
      used += line.length + 1;
    }
    const omitted = references.length - lines.length;
    return `Host-issued evidence references (status is per observed page):\n${lines.join("\n")}${omitted > 0 ? `\n${omitted} additional references are omitted; use a fresh read to receive more references.` : ""}`;
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
    if (name === "submit_review") return undefined;
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
      return path === undefined ? undefined : { kind: "repository_read", path, revision: "head" };
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

function evidenceCoversPathForCoverage(reference: ReviewEvidenceReference, path: string): boolean {
  return reference.kind !== "repository_search" && evidenceCoversPath(reference, path);
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
