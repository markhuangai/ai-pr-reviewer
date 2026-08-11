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
const MAX_INLINE_COMMENT_LENGTH = 60_000;
const MAX_MERGED_FINDING_BODY_LENGTH = 16_000;
const MAX_INLINE_COMMENTS = 25;
const MAX_GOAL_STATUS_LENGTH = 8_000;
const MERGED_FINDING_TRUNCATION_NOTICE = "> Additional duplicate evidence omitted after 16 KB.";
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
  const body = goals
    .map((goal, index) => {
      const status =
        goal.status === "completed" ? "completed" : `failed: ${goal.error ?? "unknown error"}`;
      return `${index + 1}. ${status} — ${goal.prompt}`;
    })
    .join("\n");
  if (body.length <= MAX_GOAL_STATUS_LENGTH) return body;
  return `${body.slice(0, MAX_GOAL_STATUS_LENGTH - 80)}\n\n> Goal status truncated; findings are listed above.`;
}

export function buildReviewBody(review: AggregatedReview, goals: readonly GoalResult[]): string {
  const sections = [
    ...(review.partial ? [] : [review.marker]),
    "## AI pull request review",
    `\n${review.summary}`,
    "",
    "### Findings",
  ];
  if (review.bodyFindings.length > 0) {
    sections.push(review.bodyFindings.map(formatFinding).join("\n\n"));
  } else if (review.findings.length === 0) {
    sections.push("No actionable findings were reported.");
  } else {
    sections.push("All findings are attached to changed lines above.");
  }
  sections.push("", "### Goals", goalStatusMarkdown(goals));
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
  const body = `**[${finding.severity}] ${finding.title}**\n\n${finding.body}\n\n_Found by ${goals}._`;
  if (body.length <= MAX_INLINE_COMMENT_LENGTH) return body;
  return `${body.slice(0, MAX_INLINE_COMMENT_LENGTH - 120)}\n\n> Inline finding truncated at 60 KB.`;
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
