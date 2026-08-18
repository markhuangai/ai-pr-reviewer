import { createHash } from "node:crypto";

import type {
  AggregatedFinding,
  AggregatedModelUsage,
  AggregatedReview,
  AggregatedTokenUsage,
  ChangedFile,
  GoalResult,
  HttpMcpServer,
  ModelPricingConfig,
  PullRequestContext,
  PullRequestReviewRequest,
  ReviewConfig,
  ReviewFinding,
  ReviewModelUsage,
  Severity,
  TokenCounts,
} from "./types.js";
import { markdownFenceLength, MAX_INLINE_REVIEW_COMMENT_LENGTH } from "./types.js";

const MAX_REVIEW_BODY_LENGTH = 60_000;
const MAX_MERGED_FINDING_BODY_LENGTH = 16_000;
const MAX_FINDING_RANGE_LENGTH = 1_000;
const MAX_INLINE_COMMENTS = 25;
const MAX_RUN_SUMMARY_BYTES = 1_000_000;
const MAX_TOKEN_USAGE_DETAILS_LENGTH = 20_000;
const MAX_DISPLAY_MODEL_LENGTH = 500;
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

const EMPTY_CONVERSATION_DIGEST = createHash("sha256").update("[]").digest("hex");

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

function stableModelPricing(pricing: ModelPricingConfig | undefined): unknown {
  if (pricing === undefined) return undefined;
  return {
    currency: pricing.currency,
    models: Object.fromEntries(
      Object.entries(pricing.models)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([model, rates]) => [
          model,
          {
            input: rates.input,
            output: rates.output,
            cacheHit: rates.cacheHit,
            cacheCreation: rates.cacheCreation,
          },
        ]),
    ),
  };
}

export function reviewMarker(
  context: PullRequestContext,
  config: ReviewConfig,
  conversationDigest = EMPTY_CONVERSATION_DIGEST,
): string {
  const fingerprint = JSON.stringify({
    baseSha: context.baseSha,
    model: config.model,
    aiBaseUrl: config.aiBaseUrl,
    usesAuthToken: config.aiAuthMode === "auth-token",
    prompts: config.reviewPrompts,
    parallelCount: config.parallelCount,
    maxTurns: config.maxTurns,
    autoApprove: config.autoApprove,
    modelPricing: stableModelPricing(config.modelPricing),
    buildId: process.env.AI_PR_REVIEWER_BUILD_ID?.trim() || "source",
    mcpServers: stableMcpShape(config.mcpServers),
    conversationDigest,
  });
  const digest = createHash("sha256").update(fingerprint).digest("hex");
  return `<!-- ai-pr-reviewer:v3:${context.headSha}:${digest} -->`;
}

function emptyTokenCounts(): TokenCounts {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  };
}

function addTokenCounts(left: TokenCounts, right: TokenCounts): TokenCounts {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
  };
}

function modelUsageKey(usage: ReviewModelUsage): string {
  return JSON.stringify([usage.model, usage.canonicalModel ?? null]);
}

function configuredRates(
  pricing: ModelPricingConfig,
  usage: ReviewModelUsage,
): { readonly model: string; readonly rates: ModelPricingConfig["models"][string] } | undefined {
  if (Object.hasOwn(pricing.models, usage.model)) {
    const rates = pricing.models[usage.model];
    if (rates !== undefined) return { model: usage.model, rates };
  }
  if (usage.canonicalModel !== undefined && Object.hasOwn(pricing.models, usage.canonicalModel)) {
    const rates = pricing.models[usage.canonicalModel];
    if (rates !== undefined) return { model: usage.canonicalModel, rates };
  }
  return undefined;
}

function aggregateTokenUsage(
  goals: readonly GoalResult[],
  pricing: ModelPricingConfig | undefined,
): AggregatedTokenUsage {
  const modelsByKey = new Map<string, ReviewModelUsage>();
  for (const goal of goals) {
    for (const usage of goal.tokenUsage?.models ?? []) {
      const key = modelUsageKey(usage);
      const existing = modelsByKey.get(key);
      modelsByKey.set(
        key,
        existing === undefined
          ? usage
          : {
              ...existing,
              ...addTokenCounts(existing, usage),
            },
      );
    }
  }

  let estimatedCost = 0;
  let totals = emptyTokenCounts();
  const models: AggregatedModelUsage[] = [...modelsByKey.values()]
    .sort(
      (left, right) =>
        left.model.localeCompare(right.model) ||
        (left.canonicalModel ?? "").localeCompare(right.canonicalModel ?? ""),
    )
    .map((usage) => {
      totals = addTokenCounts(totals, usage);
      if (pricing === undefined) return usage;
      const configured = configuredRates(pricing, usage);
      if (configured === undefined) return usage;
      estimatedCost +=
        (usage.inputTokens * configured.rates.input +
          usage.outputTokens * configured.rates.output +
          usage.cacheReadInputTokens * configured.rates.cacheHit +
          usage.cacheCreationInputTokens * configured.rates.cacheCreation) /
        1_000_000;
      return { ...usage, pricingModel: configured.model, pricing: configured.rates };
    });

  const complete = goals.length > 0 && goals.every((goal) => goal.tokenUsage?.complete === true);
  return {
    models,
    totals,
    complete,
    ...(pricing === undefined ? {} : { currency: pricing.currency, estimatedCost }),
  };
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
  conversationDigest = EMPTY_CONVERSATION_DIGEST,
): AggregatedReview {
  const marker = reviewMarker(context, config, conversationDigest);
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
    tokenUsage: aggregateTokenUsage(goals, config.modelPricing),
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

const TOKEN_FORMATTER = new Intl.NumberFormat("en-US");
const COST_FORMATTER = new Intl.NumberFormat("en-US", {
  useGrouping: false,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function totalTokens(counts: TokenCounts): number {
  return (
    counts.inputTokens +
    counts.outputTokens +
    counts.cacheReadInputTokens +
    counts.cacheCreationInputTokens
  );
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/\r/gu, "&#13;")
    .replace(/\n/gu, "&#10;");
}

function escapeMarkdownText(value: string): string {
  return escapeHtmlText(value.replace(/[-\\`*_[\]{}()#+.!|]/gu, "\\$&"));
}

function modelCode(value: string): string {
  const display =
    value.length <= MAX_DISPLAY_MODEL_LENGTH
      ? value
      : `${value.slice(0, MAX_DISPLAY_MODEL_LENGTH - 1)}…`;
  return `<code>${escapeHtmlText(display)}</code>`;
}

function tokenLine(label: string, tokens: number): string {
  return `  - ${label}: ${TOKEN_FORMATTER.format(tokens)}`;
}

function rateLine(currency: string, label: string, rate: number): string {
  return `${label} ${escapeMarkdownText(currency)}${String(rate)}`;
}

function modelUsageBlock(usage: AggregatedModelUsage, currency: string | undefined): string {
  const lines = [
    `- ${modelCode(usage.model)}: ${TOKEN_FORMATTER.format(totalTokens(usage))} tokens`,
    tokenLine("Input", usage.inputTokens),
    tokenLine("Output", usage.outputTokens),
    tokenLine("Cache hit", usage.cacheReadInputTokens),
    tokenLine("Cache creation", usage.cacheCreationInputTokens),
  ];
  if (usage.canonicalModel !== undefined && usage.canonicalModel !== usage.model) {
    lines.push(`  - Canonical model: ${modelCode(usage.canonicalModel)}`);
  }
  if (currency !== undefined) {
    if (usage.pricing === undefined) {
      lines.push("  - Pricing: **unpriced**");
    } else {
      if (usage.pricingModel !== usage.model && usage.pricingModel !== undefined) {
        lines.push(`  - Pricing match: ${modelCode(usage.pricingModel)}`);
      }
      lines.push(
        `  - Rates per 1M tokens: ${[
          rateLine(currency, "input", usage.pricing.input),
          rateLine(currency, "output", usage.pricing.output),
          rateLine(currency, "cache hit", usage.pricing.cacheHit),
          rateLine(currency, "cache creation", usage.pricing.cacheCreation),
        ].join("; ")}`,
      );
    }
  }
  return lines.join("\n");
}

function buildTokenUsageDetails(usage: AggregatedTokenUsage): string {
  const hasPricing = usage.currency !== undefined && usage.estimatedCost !== undefined;
  const hasUnpricedModels = hasPricing && usage.models.some((model) => model.pricing === undefined);
  const isLowerBound = hasUnpricedModels || !usage.complete;
  const lines = [
    "<details>",
    `<summary>${hasPricing ? "Token usage and estimated cost" : "Token usage"}</summary>`,
    "",
  ];
  if (hasPricing) {
    lines.push(
      `- Estimated cost: **${isLowerBound ? "at least " : ""}${escapeMarkdownText(usage.currency ?? "")}${COST_FORMATTER.format(usage.estimatedCost ?? 0)}**`,
    );
  }
  lines.push(
    `- Total tokens: **${TOKEN_FORMATTER.format(totalTokens(usage.totals))}**`,
    tokenLine("Input", usage.totals.inputTokens),
    tokenLine("Output", usage.totals.outputTokens),
    tokenLine("Cache hit", usage.totals.cacheReadInputTokens),
    tokenLine("Cache creation", usage.totals.cacheCreationInputTokens),
    usage.complete
      ? "- SDK accounting: complete"
      : "- SDK accounting: incomplete; totals include only the last valid cumulative snapshot available from each goal.",
    "- Scope: Claude Agent SDK model usage; external MCP service usage is excluded.",
    "",
    "#### Models",
    "",
  );

  const modelBlocks = usage.models.map((model) => modelUsageBlock(model, usage.currency));
  if (modelBlocks.length === 0) modelBlocks.push("- No SDK model usage was reported.");
  let included = 0;
  for (const block of modelBlocks) {
    const omittedAfter = modelBlocks.length - included - 1;
    const omission =
      omittedAfter === 0 ? "" : `\n\n- ${omittedAfter} additional model rows omitted.`;
    const candidate = `${lines.join("\n")}${included === 0 ? "" : "\n\n"}${block}${omission}\n\n</details>`;
    if (candidate.length > MAX_TOKEN_USAGE_DETAILS_LENGTH) break;
    lines.push(...(included === 0 ? [] : [""]), block);
    included += 1;
  }
  const omitted = modelBlocks.length - included;
  if (omitted > 0) lines.push("", `- ${omitted} additional model rows omitted.`);
  lines.push("", "</details>");
  return lines.join("\n");
}

export function buildReviewBody(review: AggregatedReview, goals: readonly GoalResult[]): string {
  const completed = goals.filter((goal) => goal.status === "completed").length;
  const tokenUsage = buildTokenUsageDetails(review.tokenUsage);
  if (!review.partial && review.findings.length === 0)
    return [review.marker, "## ✨ Good job!", "", review.summary, "", tokenUsage].join("\n");

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
  sections.push("", tokenUsage);
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
  const tokenUsage = buildTokenUsageDetails(review.tokenUsage);
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
    "",
    tokenUsage,
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
  aggregateTokenUsage,
  buildTokenUsageDetails,
  inlineCommentBody,
  normalizeFinding,
  verifyLocation,
  sameFinding,
};
