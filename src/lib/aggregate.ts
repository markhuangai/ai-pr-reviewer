import type {
  AggregatedFinding,
  AggregatedReview,
  ChangedFile,
  GoalResult,
  HttpMcpServer,
  PullRequestContext,
  PullRequestReviewRequest,
  ReviewConfig,
  ReviewFinding,
  Severity,
} from "./types.js";
import { markdownFenceLength, MAX_INLINE_REVIEW_COMMENT_LENGTH } from "./types.js";

const MAX_REVIEW_BODY_LENGTH = 60_000;
const MAX_MERGED_FINDING_BODY_LENGTH = 16_000;
const MAX_FINDING_RANGE_LENGTH = 1_000;
const MAX_INLINE_COMMENTS = 25;
const MAX_RUN_SUMMARY_BYTES = 1_000_000;
const MERGED_FINDING_TRUNCATION_NOTICE = "> Additional duplicate evidence omitted after 16 KB.";
const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MODERATE: 2,
  LOW: 1,
};
const SEVERITIES = ["CRITICAL", "HIGH", "MODERATE", "LOW"] as const;
const SEVERITY_ICON: Record<Severity, string> = {
  CRITICAL: "🚨",
  HIGH: "🔴",
  MODERATE: "🟠",
  LOW: "🟡",
};

function stableDigest(value: string): string {
  let hash = 14_695_981_039_346_656_037n;
  for (const character of value) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return hash.toString(16).padStart(16, "0");
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function hasNonAscii(value: string): boolean {
  return Array.from(value).some((character) => (character.codePointAt(0) ?? 0) > 0x7f);
}

function tokenSet(value: string): ReadonlySet<string> {
  return new Set(
    normalizeText(value)
      .split(" ")
      .filter((token) => token.length > 2 || hasNonAscii(token)),
  );
}

function overlap(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return a.size === b.size ? 1 : 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function stableMcpShape(servers: Readonly<Record<string, HttpMcpServer>>): unknown {
  return Object.fromEntries(
    Object.entries(servers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, server]) => [
        name,
        {
          type: server.type,
          url: server.url,
          tools: server.tools
            ?.map((tool) => ({
              name: tool.name,
              permission_policy: tool.permission_policy,
              org_max_permission: tool.org_max_permission,
            }))
            .sort((left, right) => left.name.localeCompare(right.name)),
          timeout: server.timeout,
          alwaysLoad: server.alwaysLoad,
          headerNames:
            server.headers === undefined
              ? undefined
              : Object.entries(server.headers)
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([name]) => name),
        },
      ]),
  );
}

export function reviewMarker(context: PullRequestContext, config: ReviewConfig): string {
  const fingerprint = JSON.stringify({
    baseSha: context.baseSha,
    model: config.model,
    aiBaseUrl: config.aiBaseUrl,
    aiAuthMode: config.aiAuthMode,
    prompts: config.reviewPrompts,
    parallelCount: config.parallelCount,
    maxTurns: config.maxTurns,
    autoApprove: config.autoApprove,
    buildId: process.env.AI_PR_REVIEWER_BUILD_ID?.trim() || "source",
    mcpServers: stableMcpShape(config.mcpServers),
  });
  const digest = stableDigest(fingerprint);
  return `<!-- ai-pr-reviewer:v2:${context.headSha}:${digest} -->`;
}

function changedFileFor(
  path: string | undefined,
  files: readonly ChangedFile[],
): ChangedFile | undefined {
  if (!path) return undefined;
  return files.find((file) => file.path === path);
}

function verifyLocation(finding: ReviewFinding, files: readonly ChangedFile[]): boolean {
  if (finding.path === undefined || finding.line === undefined) return false;
  const file = changedFileFor(finding.path, files);
  if (!file || file.addedLines.size === 0) return false;
  const endLine = finding.endLine ?? finding.line;
  if (endLine < finding.line || endLine - finding.line + 1 > MAX_FINDING_RANGE_LENGTH) return false;
  for (let line = finding.line; line <= endLine; line += 1) {
    if (!file.addedLines.has(line)) return false;
  }
  return true;
}

function normalizeFinding(
  finding: ReviewFinding,
  goalIndex: number,
  files: readonly ChangedFile[],
): AggregatedFinding {
  const locationVerified = verifyLocation(finding, files);
  if (locationVerified) return { ...finding, goals: [goalIndex], locationVerified: true };
  const claimedLocation =
    finding.path === undefined
      ? finding.line === undefined
        ? "the submitted location"
        : `line ${finding.line}`
      : finding.line === undefined
        ? finding.path
        : `${finding.path}:${finding.line}${finding.endLine === undefined ? "" : `-${finding.endLine}`}`;
  const body =
    finding.path === undefined && finding.line === undefined
      ? finding.body
      : `**Location could not be verified against the pull request diff (claimed: ${claimedLocation}).**\n\n${finding.body}`;
  return {
    title: finding.title,
    severity: finding.severity,
    body,
    ...(finding.path === undefined ? {} : { path: finding.path }),
    ...(finding.line === undefined ? {} : { line: finding.line }),
    ...(finding.endLine === undefined ? {} : { endLine: finding.endLine }),
    ...(finding.confidence === undefined ? {} : { confidence: finding.confidence }),
    goals: [goalIndex],
    locationVerified: false,
  };
}

function sameFinding(left: AggregatedFinding, right: AggregatedFinding): boolean {
  const leftLocated = left.locationVerified && left.path !== undefined && left.line !== undefined;
  const rightLocated =
    right.locationVerified && right.path !== undefined && right.line !== undefined;
  if (left.path && right.path && left.path === right.path) {
    const leftLine = left.line ?? -1;
    const rightLine = right.line ?? -1;
    if (leftLine >= 0 && rightLine >= 0 && Math.abs(leftLine - rightLine) <= 2) {
      return overlap(`${left.title} ${left.body}`, `${right.title} ${right.body}`) >= 0.55;
    }
    return false;
  }
  if ((left.path !== undefined || right.path !== undefined) && left.path !== right.path)
    return false;
  if (leftLocated || rightLocated) return false;
  return (
    normalizeText(left.title) === normalizeText(right.title) &&
    overlap(left.body, right.body) >= 0.65
  );
}

function mergeFindingBodies(existing: string, incoming: string): string {
  if (normalizeText(existing) === normalizeText(incoming)) return existing;
  if (existing.endsWith(MERGED_FINDING_TRUNCATION_NOTICE)) return existing;
  const separator = "\n\n";
  const available = MAX_MERGED_FINDING_BODY_LENGTH - existing.length - separator.length;
  if (incoming.length <= available) return `${existing}${separator}${incoming}`;
  const notice = `${separator}${MERGED_FINDING_TRUNCATION_NOTICE}`;
  const excerptLength =
    MAX_MERGED_FINDING_BODY_LENGTH - existing.length - separator.length - notice.length;
  if (excerptLength > 0) {
    return `${existing}${separator}${incoming.slice(0, excerptLength)}${notice}`;
  }
  return `${existing.slice(0, MAX_MERGED_FINDING_BODY_LENGTH - notice.length)}${notice}`;
}

function findingKeys(finding: AggregatedFinding): readonly string[] {
  if (finding.locationVerified && finding.path !== undefined && finding.line !== undefined) {
    const line = finding.line;
    return Array.from({ length: 5 }, (_, index) => {
      return `${finding.path}:${line + index - 2}`;
    });
  }
  return [`body:${normalizeText(finding.title)}`];
}

function mergeFindings(findings: readonly AggregatedFinding[]): readonly AggregatedFinding[] {
  const merged: AggregatedFinding[] = [];
  const candidatesByKey = new Map<string, number[]>();
  for (const finding of findings) {
    const candidateIndexes = new Set<number>();
    for (const key of findingKeys(finding)) {
      for (const index of candidatesByKey.get(key) ?? []) candidateIndexes.add(index);
    }
    const duplicate =
      [...candidateIndexes].find((index) => {
        const existing = merged[index];
        return existing !== undefined && sameFinding(existing, finding);
      }) ?? -1;
    if (duplicate < 0) {
      const index = merged.length;
      merged.push(finding);
      for (const key of findingKeys(finding)) {
        const indexes = candidatesByKey.get(key) ?? [];
        indexes.push(index);
        candidatesByKey.set(key, indexes);
      }
      continue;
    }
    const existing = merged[duplicate];
    if (!existing) continue;
    const severity =
      SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[existing.severity]
        ? finding.severity
        : existing.severity;
    const body = mergeFindingBodies(existing.body, finding.body);
    const mergedFinding: AggregatedFinding = {
      ...existing,
      severity,
      body,
      goals: [...new Set([...existing.goals, ...finding.goals])].sort(
        (left, right) => left - right,
      ),
      locationVerified: existing.locationVerified || finding.locationVerified,
      ...(existing.path === undefined && finding.path !== undefined && finding.locationVerified
        ? {
            path: finding.path,
            line: finding.line,
            endLine: finding.endLine,
            agentPrompt: finding.agentPrompt,
          }
        : {}),
    };
    merged[duplicate] = mergedFinding;
    for (const key of findingKeys(mergedFinding)) {
      const indexes = candidatesByKey.get(key) ?? [];
      if (!indexes.includes(duplicate)) indexes.push(duplicate);
      candidatesByKey.set(key, indexes);
    }
  }
  return merged;
}

function findingSort(left: AggregatedFinding, right: AggregatedFinding): number {
  return (
    SEVERITY_ORDER[right.severity] - SEVERITY_ORDER[left.severity] ||
    (left.path ?? "").localeCompare(right.path ?? "") ||
    (left.line ?? Number.MAX_SAFE_INTEGER) - (right.line ?? Number.MAX_SAFE_INTEGER) ||
    left.title.localeCompare(right.title)
  );
}

function severityLabel(severity: Severity): string {
  return `${severity.slice(0, 1)}${severity.slice(1).toLowerCase()}`;
}

function severityHeading(severity: Severity): string {
  return `${SEVERITY_ICON[severity]} ${severityLabel(severity)}`;
}

function joinNaturalLanguage(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function severitySummary(findings: readonly AggregatedFinding[]): string {
  return joinNaturalLanguage(
    SEVERITIES.flatMap((severity) => {
      const count = findings.filter((finding) => finding.severity === severity).length;
      return count === 0 ? [] : [`${count} ${severity.toLowerCase()}`];
    }),
  );
}

function findingSummary(findings: readonly AggregatedFinding[]): string {
  const count = findings.length;
  return `Found **${count} actionable issue${count === 1 ? "" : "s"}** — ${severitySummary(findings)}.`;
}

function formatFinding(finding: AggregatedFinding, index: number): string {
  const location =
    finding.locationVerified && finding.path && finding.line
      ? ` (${finding.path}:${finding.line})`
      : "";
  return `### ${index + 1}. ${severityHeading(finding.severity)}: ${finding.title}${location}\n\n${finding.body}`;
}

export function aggregateReview(
  context: PullRequestContext,
  config: ReviewConfig,
  files: readonly ChangedFile[],
  goals: readonly GoalResult[],
): AggregatedReview {
  const marker = reviewMarker(context, config);
  const normalized = goals.flatMap(
    (goal, index) =>
      goal.submission?.findings.map((finding) => normalizeFinding(finding, index, files)) ?? [],
  );
  const findings = [...mergeFindings(normalized)].sort(findingSort);
  const inlineFindings = findings
    .filter((finding) => finding.locationVerified)
    .slice(0, MAX_INLINE_COMMENTS);
  const inlineKeys = new Set(inlineFindings);
  const bodyFindings = findings.filter((finding) => !inlineKeys.has(finding));
  const partial = goals.some((goal) => goal.status === "failed");
  const allGoalsFailed = goals.length > 0 && goals.every((goal) => goal.status === "failed");
  const hasBlockingFinding = findings.some(
    (finding) => SEVERITY_ORDER[finding.severity] >= SEVERITY_ORDER.MODERATE,
  );
  const event = config.autoApprove && !partial && !hasBlockingFinding ? "APPROVE" : "COMMENT";
  const summary = findings.length === 0 ? "No actionable issues found." : findingSummary(findings);
  return {
    marker,
    summary,
    findings,
    inlineFindings,
    bodyFindings,
    event,
    partial,
    allGoalsFailed,
  };
}

function findingIndexMarkdown(findings: readonly AggregatedFinding[]): string {
  return findings
    .map((finding, index) => {
      const location =
        finding.path === undefined
          ? ""
          : ` — ${finding.path}${finding.line === undefined ? "" : `:${finding.line}`}`;
      return `${index + 1}. ${severityHeading(finding.severity)}: ${finding.title}${location}`;
    })
    .join("\n");
}

function findingDestination(review: AggregatedReview): string {
  if (review.inlineFindings.length > 0 && review.bodyFindings.length > 0)
    return "See the inline comments and findings below for details.";
  if (review.inlineFindings.length > 0) return "See the inline comments for details.";
  return "See the findings below for details.";
}

export function buildReviewBody(review: AggregatedReview, goals: readonly GoalResult[]): string {
  const completed = goals.filter((goal) => goal.status === "completed").length;
  if (!review.partial && review.findings.length === 0)
    return [review.marker, "## ✨ Good job!", "", review.summary].join("\n");

  const sections = review.partial
    ? [
        "## ⚠️ Review incomplete",
        "",
        `${completed} of ${goals.length} checks completed. Findings may not cover the full change. Rerun the workflow.`,
      ]
    : [review.marker, "## 🔎 AI review"];

  if (review.findings.length > 0) {
    sections.push("", review.summary, "", findingDestination(review));
  }
  if (review.bodyFindings.length > 0) {
    sections.push(
      "",
      "### Findings",
      "",
      "#### Index",
      findingIndexMarkdown(review.bodyFindings),
      "",
      "#### Details",
      review.bodyFindings.map(formatFinding).join("\n\n"),
    );
  }
  const body = sections.join("\n");
  if (body.length <= MAX_REVIEW_BODY_LENGTH) return body;
  return `${body.slice(0, MAX_REVIEW_BODY_LENGTH - 120)}\n\n> Review body truncated at 60 KB; see inline comments for the highest-severity findings.`;
}

function runSummaryHeading(review: AggregatedReview): string {
  if (review.allGoalsFailed) return "## ⚠️ AI review failed";
  if (review.partial) return "## ⚠️ AI review incomplete";
  if (review.findings.length === 0) return "## ✨ AI review complete";
  return "## 🔎 AI review";
}

function runSummaryOmissionNotice(omitted: number): string {
  return omitted === 0
    ? ""
    : `\n\n> ${omitted} additional finding${omitted === 1 ? " was" : "s were"} omitted because the run summary reached its size limit.`;
}

export function buildRunSummary(
  context: PullRequestContext,
  review: AggregatedReview,
  goals: readonly GoalResult[],
): string {
  const completed = goals.filter((goal) => goal.status === "completed").length;
  const lines = [
    runSummaryHeading(review),
    "",
    `- Pull request: [${context.repository}#${context.number}](${context.htmlUrl})`,
    `- Reviewed head: \`${context.headSha}\``,
    `- Checks completed: ${completed} of ${goals.length}`,
    `- Result: ${review.allGoalsFailed ? "failed" : review.partial ? "incomplete" : "complete"}`,
    "",
    review.allGoalsFailed && review.findings.length === 0
      ? "No review goal completed; see the step logs for redacted diagnostics."
      : review.partial && review.findings.length === 0
        ? "No actionable issues were reported by the completed checks."
        : review.summary,
  ];
  if (review.findings.length === 0) return lines.join("\n");

  lines.push("", "### Findings", "");
  const fixed = `${lines.join("\n")}\n`;
  const fixedBytes = Buffer.byteLength(fixed, "utf8");
  const reservedNoticeBytes = Buffer.byteLength(
    runSummaryOmissionNotice(review.findings.length),
    "utf8",
  );
  const findings: string[] = [];
  let findingBytes = 0;
  for (let index = 0; index < review.findings.length; index += 1) {
    const finding = review.findings[index];
    if (finding === undefined) break;
    const block = formatFinding(finding, index);
    const separatorBytes = findings.length === 0 ? 0 : 2;
    const blockBytes = Buffer.byteLength(block, "utf8");
    const omittedAfterBlock = review.findings.length - findings.length - 1;
    const noticeBytes = omittedAfterBlock === 0 ? 0 : reservedNoticeBytes;
    if (
      fixedBytes + findingBytes + separatorBytes + blockBytes + noticeBytes >
      MAX_RUN_SUMMARY_BYTES
    ) {
      break;
    }
    findings.push(block);
    findingBytes += separatorBytes + blockBytes;
  }
  const omitted = review.findings.length - findings.length;
  const notice = runSummaryOmissionNotice(omitted);
  return `${fixed}${findings.join("\n\n")}${notice}`;
}

function inlineCommentBody(finding: AggregatedFinding): string {
  const heading = `${severityHeading(finding.severity)} **${finding.title}**`;
  const body = `${heading}\n\n${finding.body}`;
  if (finding.agentPrompt === undefined) {
    if (body.length <= MAX_INLINE_REVIEW_COMMENT_LENGTH) return body;
    return `${body.slice(0, MAX_INLINE_REVIEW_COMMENT_LENGTH - 120)}\n\n> Inline finding truncated at 60 KB.`;
  }

  const fence = "`".repeat(markdownFenceLength(finding.agentPrompt));
  const trailingNewline = finding.agentPrompt.endsWith("\n") ? "" : "\n";
  const prompt = `\n\n<details>\n<summary>🤖 Prompt for AI Agents</summary>\n\n${fence}text\n${finding.agentPrompt}${trailingNewline}${fence}\n\n</details>`;
  if (body.length + prompt.length <= MAX_INLINE_REVIEW_COMMENT_LENGTH) {
    return `${body}${prompt}`;
  }

  const notice = "\n\n> Additional duplicate evidence omitted to preserve the AI prompt.";
  const available = MAX_INLINE_REVIEW_COMMENT_LENGTH - prompt.length - notice.length;
  if (available < heading.length) {
    throw new Error("The inline AI prompt exceeds GitHub's review comment capacity.");
  }
  return `${body.slice(0, available)}${notice}${prompt}`;
}

export function buildReviewRequest(
  context: PullRequestContext,
  review: AggregatedReview,
  goals: readonly GoalResult[],
): PullRequestReviewRequest {
  return {
    commit_id: context.headSha,
    body: buildReviewBody(review, goals),
    event: review.event,
    comments: review.inlineFindings.flatMap((finding) => {
      if (!finding.path || !finding.line) return [];
      return [
        {
          path: finding.path,
          line: finding.endLine ?? finding.line,
          side: "RIGHT" as const,
          ...(finding.endLine !== undefined && finding.endLine > finding.line
            ? { start_line: finding.line, start_side: "RIGHT" as const }
            : {}),
          body: inlineCommentBody(finding),
        },
      ];
    }),
  };
}

export const aggregateInternals = {
  inlineCommentBody,
  normalizeFinding,
  verifyLocation,
  sameFinding,
};
