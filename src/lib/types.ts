export type Severity = "CRITICAL" | "HIGH" | "MODERATE" | "LOW";

export const MAX_INLINE_REVIEW_COMMENT_LENGTH = 60_000;

export function markdownFenceLength(value: string): number {
  let longestBacktickRun = 0;
  for (const match of value.matchAll(/`+/gu)) {
    longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
  }
  return Math.max(3, longestBacktickRun + 1);
}

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

export type ReviewEvent = "APPROVE" | "COMMENT";

export interface McpToolPolicy {
  readonly name: string;
  readonly permission_policy?: "always_allow" | "always_ask" | "always_deny";
  readonly org_max_permission?: "allow" | "ask" | "blocked";
}

export interface HttpMcpServer {
  readonly type: "http";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly tools?: readonly McpToolPolicy[];
  readonly timeout?: number;
  readonly alwaysLoad?: boolean;
}

export interface ModelPricingRates {
  readonly input: number;
  readonly output: number;
  readonly cacheHit: number;
  readonly cacheCreation: number;
}

export interface ModelPricingConfig {
  readonly currency: string;
  readonly models: Readonly<Record<string, ModelPricingRates>>;
}

export interface ReviewModelUsage {
  readonly model: string;
  readonly canonicalModel?: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

export interface GoalTokenUsage {
  readonly models: readonly ReviewModelUsage[];
  readonly complete: boolean;
}

export interface ReviewGoal {
  readonly prompt: string;
  readonly files: readonly string[];
}

export interface ReviewConfig {
  readonly githubToken: string;
  readonly aiBaseUrl: string;
  readonly aiSecret: string;
  readonly model: string;
  readonly effort?: EffortLevel;
  readonly systemPrompt?: string;
  readonly modelPricing?: ModelPricingConfig;
  readonly reviewPrompts: readonly ReviewGoal[];
  readonly parallelCount: number;
  readonly maxTurns: number;
  readonly autoApprove: boolean;
  readonly interactWithPullRequest: boolean;
  readonly pullRequestUrl?: string;
  readonly mcpServers: Readonly<Record<string, HttpMcpServer>>;
}

export interface PullRequestLocator {
  readonly repository: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  readonly htmlUrl: string;
}

export interface PullRequestContext {
  readonly repository: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseRef: string;
  readonly changedFiles?: number;
  readonly title: string;
  readonly body?: string;
  readonly htmlUrl: string;
}

export interface LinkedIssueSnapshot {
  readonly number: number;
  readonly title: string;
  readonly state: string;
  readonly body: string;
  readonly htmlUrl: string;
}

export interface ReviewBriefing {
  readonly linkedIssues: readonly LinkedIssueSnapshot[];
  readonly linkedIssueReferencesTruncated: boolean;
  readonly repositoryGuidance?: readonly RepositoryGuidanceSnapshot[];
}

export interface RepositoryGuidanceSnapshot {
  readonly path: string;
  readonly revision: "base" | "head";
  readonly content: string;
}

export interface ChangedFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch?: string;
  readonly addedLines: ReadonlySet<number>;
}

export interface ReviewFinding {
  readonly title: string;
  readonly severity: Severity;
  readonly body: string;
  readonly agentPrompt?: string;
  readonly path?: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly confidence?: "high" | "medium" | "low";
}

export type ReviewCoverageDisposition = "reviewed" | "not_applicable" | "incomplete";

export interface ReviewCoverageEntry {
  readonly paths: readonly string[];
  readonly disposition: ReviewCoverageDisposition;
  readonly rationale: string;
  readonly evidenceRefs: readonly string[];
}

export type ReviewCandidateVerdict = "supported" | "disproved" | "unresolved";

export interface ReviewCandidateAssessment {
  readonly paths: readonly string[];
  readonly trigger: string;
  readonly impact: string;
  readonly evidenceRefs: readonly string[];
  readonly countercheck: string;
  readonly counterevidenceRefs: readonly string[];
  readonly verdict: ReviewCandidateVerdict;
  readonly findingIndex?: number;
}

export interface ReviewAssessment {
  readonly coverage: readonly ReviewCoverageEntry[];
  readonly candidates: readonly ReviewCandidateAssessment[];
}

export type ReviewEvidenceKind =
  | "repository_diff"
  | "repository_file"
  | "repository_read"
  | "repository_search"
  | "repository_glob"
  | "context_file"
  | "conversation"
  | "briefing"
  | "external_tool";

export type ReviewEvidenceStatus = "complete" | "partial" | "failed";

export interface ReviewEvidenceBounds {
  readonly offset?: number;
  readonly limit?: number;
  readonly headLimit?: number;
  readonly pages?: string;
  readonly truncated?: boolean;
}

export interface ReviewEvidenceReference {
  readonly id: string;
  readonly kind: ReviewEvidenceKind;
  readonly status: ReviewEvidenceStatus;
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly revision?: "base" | "head";
  readonly mergeBaseSha?: string;
  readonly headSha?: string;
  readonly changedPaths?: boolean;
  readonly contentKind?: "text" | "binary" | "non_regular" | "missing";
  readonly bounds?: ReviewEvidenceBounds;
}

export interface GoalSubmission {
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
  readonly assessment: ReviewAssessment;
}

export interface GoalResult {
  readonly prompt: string;
  readonly status: "completed" | "incomplete" | "failed";
  readonly submission?: GoalSubmission;
  readonly error?: string;
  readonly tokenUsage?: GoalTokenUsage;
}

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
}

export interface AggregatedModelUsage extends ReviewModelUsage {
  readonly pricingModel?: string;
  readonly pricing?: ModelPricingRates;
}

export interface AggregatedTokenUsage {
  readonly models: readonly AggregatedModelUsage[];
  readonly totals: TokenCounts;
  readonly complete: boolean;
  readonly currency?: string;
  readonly estimatedCost?: number;
}

export interface AggregatedFinding extends ReviewFinding {
  readonly goals: readonly number[];
  readonly locationVerified: boolean;
}

export interface AggregatedReview {
  readonly marker: string;
  readonly summary: string;
  readonly findings: readonly AggregatedFinding[];
  readonly inlineFindings: readonly AggregatedFinding[];
  readonly omittedFindings: readonly AggregatedFinding[];
  readonly event: ReviewEvent;
  readonly partial: boolean;
  readonly allGoalsFailed: boolean;
  readonly tokenUsage: AggregatedTokenUsage;
}

export interface PullRequestReviewComment {
  readonly path: string;
  readonly line: number;
  readonly side: "RIGHT";
  readonly start_line?: number;
  readonly start_side?: "RIGHT";
  readonly body: string;
}

export interface PullRequestReviewRequest {
  readonly commit_id: string;
  readonly body: string;
  readonly event: ReviewEvent;
  readonly comments: readonly PullRequestReviewComment[];
}

export interface ReviewRunResult {
  readonly skipped: boolean;
  readonly review?: AggregatedReview;
}
