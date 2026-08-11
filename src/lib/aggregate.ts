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

const MAX_REVIEW_BODY_LENGTH = 60_000;
const MAX_INLINE_COMMENTS = 25;
const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  INFO: 1,
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
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenSet(value: string): ReadonlySet<string> {
  return new Set(
    normalizeText(value)
      .split(" ")
      .filter((token) => token.length > 2),
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
          tools: server.tools?.map((tool) => tool.name).sort(),
          timeout: server.timeout,
          alwaysLoad: server.alwaysLoad,
          headerNames:
            server.headers === undefined ? undefined : Object.keys(server.headers).sort(),
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
    mcpServers: stableMcpShape(config.mcpServers),
  });
  const digest = stableDigest(fingerprint);
  return `<!-- ai-pr-reviewer:v1:${context.headSha}:${digest} -->`;
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
  if (endLine < finding.line) return false;
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
  const body =
    finding.path === undefined && finding.line === undefined
      ? finding.body
      : `**Location could not be verified against the pull request diff.**\n\n${finding.body}`;
  return {
    title: finding.title,
    severity: finding.severity,
    body,
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
  }
  if (leftLocated || rightLocated) return false;
  return (
    normalizeText(left.title) === normalizeText(right.title) &&
    overlap(left.body, right.body) >= 0.65
  );
}

function mergeFindings(findings: readonly AggregatedFinding[]): readonly AggregatedFinding[] {
  const merged: AggregatedFinding[] = [];
  for (const finding of findings) {
    const duplicate = merged.findIndex((existing) => sameFinding(existing, finding));
    if (duplicate < 0) {
      merged.push(finding);
      continue;
    }
    const existing = merged[duplicate];
    if (!existing) continue;
    const severity =
      SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[existing.severity]
        ? finding.severity
        : existing.severity;
    const body =
      normalizeText(existing.body) === normalizeText(finding.body)
        ? existing.body
        : `${existing.body}\n\n${finding.body}`;
    merged[duplicate] = {
      ...existing,
      severity,
      body,
      goals: [...new Set([...existing.goals, ...finding.goals])].sort(
        (left, right) => left - right,
      ),
      locationVerified: existing.locationVerified || finding.locationVerified,
      ...(existing.path === undefined && finding.path !== undefined && finding.locationVerified
        ? { path: finding.path, line: finding.line, endLine: finding.endLine }
        : {}),
    };
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

function countBySeverity(findings: readonly AggregatedFinding[]): string {
  return (["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const)
    .map(
      (severity) =>
        `${severity.toLowerCase()}=${findings.filter((finding) => finding.severity === severity).length}`,
    )
    .join(", ");
}

function formatFinding(finding: AggregatedFinding, index: number): string {
  const location =
    finding.locationVerified && finding.path && finding.line
      ? ` (${finding.path}:${finding.line})`
      : "";
  const goals = finding.goals.map((goal) => `goal ${goal + 1}`).join(", ");
  return `### ${index + 1}. [${finding.severity}] ${finding.title}${location}\n\n${finding.body}\n\n_Found by ${goals}._`;
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
    (finding) => SEVERITY_ORDER[finding.severity] >= SEVERITY_ORDER.MEDIUM,
  );
  const event = config.autoApprove && !partial && !hasBlockingFinding ? "APPROVE" : "COMMENT";
  const completed = goals.filter((goal) => goal.status === "completed").length;
  const summary = `Reviewed ${goals.length} goal${goals.length === 1 ? "" : "s"}; ${completed} completed, ${goals.length - completed} failed. ${findings.length} finding${findings.length === 1 ? "" : "s"} (${countBySeverity(findings)}).`;
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

function goalStatusMarkdown(goals: readonly GoalResult[]): string {
  return goals
    .map((goal, index) => {
      const status =
        goal.status === "completed" ? "completed" : `failed: ${goal.error ?? "unknown error"}`;
      return `${index + 1}. ${status} — ${goal.prompt}`;
    })
    .join("\n");
}

export function buildReviewBody(review: AggregatedReview, goals: readonly GoalResult[]): string {
  const sections = [
    ...(review.partial ? [] : [review.marker]),
    "## AI pull request review",
    `\n${review.summary}`,
    "",
    "### Goals",
    goalStatusMarkdown(goals),
  ];
  if (review.bodyFindings.length > 0) {
    sections.push("", "### Findings", review.bodyFindings.map(formatFinding).join("\n\n"));
  } else if (review.findings.length === 0) {
    sections.push("", "### Findings", "No actionable findings were reported.");
  } else {
    sections.push("", "### Findings", "All findings are attached to changed lines above.");
  }
  if (review.partial)
    sections.push(
      "",
      "> **Partial review:** one or more goals failed. This review is informational and the action will fail.",
    );
  const body = sections.join("\n");
  if (body.length <= MAX_REVIEW_BODY_LENGTH) return body;
  return `${body.slice(0, MAX_REVIEW_BODY_LENGTH - 120)}\n\n> Review body truncated at 60 KB; see inline comments for the highest-severity findings.`;
}

function inlineCommentBody(finding: AggregatedFinding): string {
  const goals = finding.goals.map((goal) => `goal ${goal + 1}`).join(", ");
  return `**[${finding.severity}] ${finding.title}**\n\n${finding.body}\n\n_Found by ${goals}._`;
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
  normalizeFinding,
  verifyLocation,
  sameFinding,
};
