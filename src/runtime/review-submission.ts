import { z } from "zod";
import type { SDKMessage, SDKActiveGoalMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ReviewConversationSnapshot } from "../lib/review-context.js";
import type {
  ChangedFile,
  GoalSubmission,
  GoalResult,
  ReviewFinding,
  ReviewEvidenceReference,
} from "../lib/types.js";
import { isRecord } from "./agent-logging.js";
import { jsonToolResult } from "./agent-review-tools.js";
import {
  type ReviewEvidenceLedger,
  findingEvidenceShape,
  reviewLimitationSchema,
  reviewFindingGaps,
  reviewInspection,
  type ReviewValidationGap,
} from "./review-assessment.js";
const MAX_FINDING_TITLE_LENGTH = 120;
const MAX_FINDING_PROSE_LENGTH = 500;
export const SEVERITY_VALUES = ["CRITICAL", "HIGH", "MODERATE", "LOW"] as const;

export const MAX_REPAIR_ATTEMPTS = 5;

export class ReviewSubmissionRecovery {
  private readonly uses = new Map<string, { allowed: boolean; input: unknown }>();
  private readonly rejections = new Set<string>();
  private emptyTurns = 0;
  private activitySinceResult = false;
  readonly rejectionCounts: Record<string, number> = {};
  latestInput: unknown;

  get submissionAttempts(): number {
    return this.uses.size;
  }
  get repairAttempts(): number {
    return Math.min(MAX_REPAIR_ATTEMPTS, Math.max(0, this.uses.size + this.emptyTurns - 1));
  }
  get remainingCorrections(): number {
    return Math.min(
      MAX_REPAIR_ATTEMPTS,
      Math.max(0, MAX_REPAIR_ATTEMPTS + 1 - this.uses.size - this.emptyTurns),
    );
  }
  get exhausted(): boolean {
    return this.uses.size + this.emptyTurns >= MAX_REPAIR_ATTEMPTS + 1;
  }
  get allRejected(): boolean {
    return this.rejections.size === this.uses.size;
  }

  hasUse(id: string): boolean {
    return this.uses.has(id);
  }
  allows(id: string): boolean {
    return this.uses.get(id)?.allowed === true;
  }
  inputFor(id: string): unknown {
    return this.uses.get(id)?.input;
  }

  observeUse(id: string, input: unknown): void {
    if (this.uses.has(id)) return;
    this.uses.set(id, { allowed: !this.exhausted, input });
    this.activitySinceResult = true;
    if (this.allows(id)) this.latestInput = input;
  }

  reject(id: string, categories: readonly string[]): void {
    if (!this.uses.has(id) || this.rejections.has(id)) return;
    this.rejections.add(id);
    for (const category of new Set(categories))
      this.rejectionCounts[category] = (this.rejectionCounts[category] ?? 0) + 1;
  }

  observeMessage(
    message: SDKMessage | SDKActiveGoalMessage,
    observeRejection: (id: string) => void,
  ): void {
    if (message.type === "assistant" || message.type === "user") {
      const content = isRecord(message.message) ? message.message.content : undefined;
      if (Array.isArray(content))
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (
            message.type === "assistant" &&
            typeof block.id === "string" &&
            ((block.type === "tool_use" && block.name === "mcp__review_output__submit_review") ||
              (block.type === "mcp_tool_use" &&
                block.server_name === "review_output" &&
                block.name === "submit_review"))
          )
            this.observeUse(block.id, block.input);
          if (
            message.type === "user" &&
            (block.type === "tool_result" || block.type === "mcp_tool_result") &&
            typeof block.tool_use_id === "string"
          )
            observeRejection(block.tool_use_id);
        }
      if (
        message.type === "user" &&
        typeof message.parent_tool_use_id === "string" &&
        message.tool_use_result !== undefined
      )
        observeRejection(message.parent_tool_use_id);
    }
  }
  finishTurn(): void {
    if (!this.activitySinceResult) {
      this.emptyTurns += 1;
      this.rejectionCounts.empty_turn = (this.rejectionCounts.empty_turn ?? 0) + 1;
    }
    this.activitySinceResult = false;
  }

  diagnostics(
    evidenceReferences: number,
    termination: string,
  ): NonNullable<GoalResult["diagnostics"]> {
    return {
      submissionAttempts: this.submissionAttempts,
      repairAttempts: this.repairAttempts,
      evidenceReferences,
      rejectionCounts: { ...this.rejectionCounts },
      termination,
    };
  }
}

const findingShape = {
  ...findingEvidenceShape,
  title: z.string().trim().min(1).max(MAX_FINDING_TITLE_LENGTH),
  severity: z
    .enum(SEVERITY_VALUES)
    .describe(
      "Finding severity. Informational observations and style-only suggestions are omitted.",
    ),
  why: z
    .string()
    .trim()
    .min(1)
    .max(MAX_FINDING_PROSE_LENGTH)
    .describe("One or two direct sentences explaining the concrete impact."),
  fix: z
    .string()
    .trim()
    .min(1)
    .max(MAX_FINDING_PROSE_LENGTH)
    .describe("One or two direct sentences explaining how to fix the defect."),
  endLine: z.number().int().min(1).max(1_000_000).optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
} as const;

const findingSchema = z
  .object({
    ...findingShape,
    path: z.string().min(1).max(500).optional(),
    line: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();

const inlineFindingSchema = z
  .object({
    ...findingShape,
    path: z.string().min(1).max(500),
    line: z.number().int().min(1).max(1_000_000),
  })
  .strict();

export const submissionSchema = z
  .object({
    summary: z.string().max(10_000),
    findings: z.array(findingSchema).max(100),
    limitations: z.array(reviewLimitationSchema).max(100),
  })
  .strict();

export const interactiveSubmissionSchema = z
  .object({
    summary: z.string().max(10_000),
    findings: z.array(inlineFindingSchema).max(100),
    limitations: z.array(reviewLimitationSchema).max(100),
  })
  .strict();

type SubmissionInput = z.infer<typeof submissionSchema>;

export function toSubmission(input: SubmissionInput): GoalSubmission {
  const findings: ReviewFinding[] = input.findings.map((finding) => {
    const title = finding.title.replace(/\s+/gu, " ").trim();
    const why = finding.why.replace(/\s+/gu, " ").trim();
    const fix = finding.fix.replace(/\s+/gu, " ").trim();
    const target =
      finding.path !== undefined && finding.line !== undefined
        ? `@${finding.path}:${finding.line}${
            finding.endLine !== undefined && finding.endLine > finding.line
              ? `-${finding.endLine}`
              : ""
          }`
        : undefined;
    const agentPrompt =
      target === undefined
        ? undefined
        : [
            "Verify this finding against the current code. Fix it only if it is still valid,",
            "keep the change minimal, and run the relevant tests.",
            "",
            `Target: \`${target}\``,
            `Finding: ${title}`,
            `Impact: ${why}`,
            `Requested fix: ${fix}`,
          ].join("\n");
    return {
      title,
      severity: finding.severity,
      body: `**Why it matters:** ${why}\n\n**Fix:** ${fix}`,
      ...(agentPrompt === undefined ? {} : { agentPrompt }),
      ...(finding.path === undefined ? {} : { path: finding.path }),
      ...(finding.line === undefined ? {} : { line: finding.line }),
      ...(finding.endLine === undefined ? {} : { endLine: finding.endLine }),
      ...(finding.confidence === undefined ? {} : { confidence: finding.confidence }),
    };
  });
  return { summary: input.summary, findings, limitations: input.limitations };
}

function validAddedLineLocation(finding: ReviewFinding, files: readonly ChangedFile[]): boolean {
  if (finding.path === undefined || finding.line === undefined) return false;
  const file = files.find((candidate) => candidate.path === finding.path);
  if (file === undefined) return false;
  const endLine = finding.endLine ?? finding.line;
  if (endLine < finding.line || endLine - finding.line + 1 > 1_000) return false;
  for (let line = finding.line; line <= endLine; line += 1) {
    if (!file.addedLines.has(line)) return false;
  }
  return true;
}

export function invalidInteractiveFindingLocations(
  submission: GoalSubmission,
  files: readonly ChangedFile[],
): readonly string[] {
  return submission.findings.flatMap((finding, index) => {
    if (validAddedLineLocation(finding, files)) return [];
    const location =
      finding.path === undefined
        ? "missing path"
        : finding.line === undefined
          ? `${finding.path}:missing line`
          : `${finding.path}:${finding.line}${finding.endLine === undefined ? "" : `-${finding.endLine}`}`;
    return [`${index + 1}. ${finding.title} (${location})`];
  });
}

function findingLocationValid(
  finding: ReviewFinding,
  files: readonly ChangedFile[],
  interactive: boolean,
): boolean {
  if (interactive || finding.line !== undefined || finding.endLine !== undefined)
    return validAddedLineLocation(finding, files);
  return finding.path === undefined || files.some((file) => file.path === finding.path);
}

export function retainValidReviewFindings(
  input: unknown,
  files: readonly ChangedFile[],
  references: ReadonlyMap<string, ReviewEvidenceReference>,
  canReport: (finding: ReviewFinding) => boolean,
  interactive = false,
): GoalSubmission | undefined {
  if (!isRecord(input) || !Array.isArray(input.findings) || input.findings.length > 100)
    return undefined;
  const findings: ReviewFinding[] = [];
  for (const raw of input.findings) {
    const parsed = findingSchema.safeParse(raw);
    if (!parsed.success) continue;
    const { evidenceRefs, countercheck, counterevidenceRefs } = parsed.data;
    const finding = toSubmission({ summary: "", findings: [parsed.data], limitations: [] })
      .findings[0];
    if (
      finding === undefined ||
      !canReport(finding) ||
      !findingLocationValid(finding, files, interactive) ||
      reviewFindingGaps(
        { ...finding, evidenceRefs, countercheck, counterevidenceRefs },
        files,
        references,
      ).length > 0
    )
      continue;
    findings.push(finding);
  }
  if (findings.length === 0) return undefined;
  return {
    summary: "Review incomplete; retained independently validated findings.",
    findings,
    limitations: [
      {
        paths: [],
        reason: "The latest review submission could not be finalized within the configured limit.",
      },
    ],
  };
}

export const unreadReviewFindingPaths = (
  findings: readonly unknown[],
  conversation: ReviewConversationSnapshot,
  discussionPathScope: (path: string) => string,
  discussionReadPaths: ReadonlySet<string>,
  discussionReadThreadIds: ReadonlySet<number>,
): readonly string[] => [
  ...new Set(
    findings
      .filter(isRecord)
      .filter((finding) => {
        if (typeof finding.path !== "string") return false;
        const scope = discussionPathScope(finding.path);
        if (discussionReadPaths.has(scope)) return false;
        const threads = conversation.entries.filter(
          (entry) => entry.kind === "inline_thread" && discussionPathScope(entry.path) === scope,
        );
        if (threads.length === 0) return false;
        const matching = threads.filter(
          (entry) => entry.kind === "inline_thread" && entry.line === finding.line,
        );
        return (
          typeof finding.line !== "number" ||
          matching.length === 0 ||
          matching.some((entry) => !discussionReadThreadIds.has(entry.id))
        );
      })
      .map((finding) => finding.path as string),
  ),
];

export function reviewSubmissionGaps(
  input: unknown,
  files: readonly ChangedFile[],
  evidenceLedger: ReviewEvidenceLedger,
  interactive: boolean,
  briefingComplete: boolean,
  unreadFindingPaths: (findings: readonly unknown[]) => readonly string[],
): readonly ReviewValidationGap[] {
  const parsed = (interactive ? interactiveSubmissionSchema : submissionSchema).safeParse(input);
  if (!parsed.success)
    return [
      {
        category: "schema",
        message: "The submission does not match the required schema.",
        paths: [],
      },
    ];
  const candidate = toSubmission(parsed.data);
  const gaps: ReviewValidationGap[] = parsed.data.findings.flatMap(
    ({ evidenceRefs, countercheck, counterevidenceRefs }, index) =>
      reviewFindingGaps(
        {
          ...(candidate.findings[index] as ReviewFinding),
          evidenceRefs,
          countercheck,
          counterevidenceRefs,
        },
        files,
        evidenceLedger.issued,
      ),
  );
  const validPaths = new Set(
    files.flatMap((file) => [
      file.path,
      ...(file.previousPath === undefined ? [] : [file.previousPath]),
    ]),
  );
  for (const limitation of candidate.limitations)
    if (limitation.paths.some((path) => !validPaths.has(path)))
      gaps.push({
        category: "schema",
        message:
          "Limitation paths must belong to the captured change, or be empty for a goal-wide limitation.",
        paths: limitation.paths,
      });
  const missing = reviewInspection(files, evidenceLedger.issued).missingPaths;
  if (missing.length > 0 && candidate.limitations.length === 0)
    for (const path of missing)
      gaps.push({
        category: "inspection",
        message:
          "Changed code has not been delivered; read its selected diff or declare the required investigation incomplete.",
        paths: [path],
      });
  if (!briefingComplete)
    gaps.unshift({
      category: "briefing",
      message: "Read the review briefing until done=true first.",
      paths: [],
    });
  const unread = unreadFindingPaths(candidate.findings);
  if (unread.length > 0)
    gaps.push({
      category: "discussion",
      message: "Read prior discussion threads for these finding paths first.",
      paths: unread,
    });
  if (candidate.findings.some((finding) => !findingLocationValid(finding, files, interactive)))
    gaps.push({
      category: "location",
      message:
        "Every supplied finding location must match the captured change; interactive findings require a participating added line.",
      paths: candidate.findings.flatMap((finding) =>
        finding.path === undefined ? [] : [finding.path],
      ),
    });
  return gaps;
}

export function reviewSubmissionRejectionResult(
  validationGaps: readonly ReviewValidationGap[],
  evidenceLedger: ReviewEvidenceLedger,
  files: readonly ChangedFile[],
  remainingCorrections: number,
): CallToolResult {
  const gaps: unknown[] = [];
  for (const gap of validationGaps) {
    const record = {
      ...gap,
      evidence: gap.paths.map((path) => ({
        path,
        evidenceRefs: evidenceLedger.eligibleReferences(path, files).slice(-5),
      })),
    };
    if (gaps.length >= 12 || Buffer.byteLength(JSON.stringify([...gaps, record])) > 8_000) break;
    gaps.push(record);
  }
  return {
    ...jsonToolResult({
      message:
        "Review submission rejected. Call read_review_state for inspection progress, existing evidence, and exact next calls; correct only the reported gaps.",
      gaps,
      omittedGaps: validationGaps.length - gaps.length,
      remainingCorrections,
    }),
    isError: true,
  };
}
