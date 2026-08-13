export type Severity = "CRITICAL" | "HIGH" | "MODERATE" | "LOW";

export type AuthMode = "api-key" | "auth-token";

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

export interface ReviewConfig {
  readonly githubToken: string;
  readonly aiBaseUrl: string;
  readonly aiSecret: string;
  readonly aiAuthMode: AuthMode;
  readonly model: string;
  readonly reviewPrompts: readonly string[];
  readonly parallelCount: number;
  readonly maxTurns: number;
  readonly autoApprove: boolean;
  readonly mcpServers: Readonly<Record<string, HttpMcpServer>>;
}

export interface PullRequestContext {
  readonly repository: string;
  readonly owner: string;
  readonly name: string;
  readonly number: number;
  readonly headSha: string;
  readonly baseSha: string;
  readonly changedFiles?: number;
  readonly title: string;
  readonly htmlUrl: string;
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
  readonly path?: string;
  readonly line?: number;
  readonly endLine?: number;
  readonly confidence?: "high" | "medium" | "low";
}

export interface GoalSubmission {
  readonly summary: string;
  readonly findings: readonly ReviewFinding[];
}

export interface GoalResult {
  readonly prompt: string;
  readonly status: "completed" | "failed";
  readonly submission?: GoalSubmission;
  readonly error?: string;
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
  readonly bodyFindings: readonly AggregatedFinding[];
  readonly event: ReviewEvent;
  readonly partial: boolean;
  readonly allGoalsFailed: boolean;
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
