/* eslint-disable max-lines */

import type {
  ChangedFile,
  LinkedIssueSnapshot,
  PullRequestContext,
  PullRequestLocator,
  PullRequestReviewRequest,
  ReviewBriefing,
} from "./types.js";
import { throwIfAborted } from "./bootstrap/cancellation.js";
import {
  decodeGitPath,
  diffPath,
  parseGitNameStatus,
  parseGitNumstat,
  readGitAddedLines,
  readGitMergeBase,
  readGitMetadata,
} from "./git-changed-files.js";
import { discoverLinkedIssueNumbers, issueSnapshot } from "./review-evidence.js";
import {
  DISMISS_REVIEW_MUTATION,
  MINIMIZE_COMMENT_MUTATION,
  RESOLVE_THREAD_MUTATION,
  REVIEW_LIFECYCLE_REVIEWS_QUERY,
  REVIEW_LIFECYCLE_THREAD_COMMENTS_QUERY,
  REVIEW_LIFECYCLE_THREADS_QUERY,
  graphqlUrlFor,
  pullRequestConnection,
  requiredRecord,
  readGraphqlComment,
  readGraphqlConnection,
  readGraphqlReview,
  readGraphqlThread,
  readGraphqlThreadComments,
  UPDATE_REVIEW_MUTATION,
  type ReviewLifecycleSnapshot,
  type ReviewLifecycleReviewRecord,
  type ReviewLifecycleThreadRecord,
} from "./github-review-lifecycle.js";
import { DiagnosticLogger, type DiagnosticDescriptor } from "./diagnostics.js";

export type {
  ReviewLifecycleCommentRecord,
  ReviewLifecycleReviewRecord,
  ReviewLifecycleSnapshot,
  ReviewLifecycleThreadRecord,
} from "./github-review-lifecycle.js";

export { readPullRequestFilesFromCheckout } from "./git-changed-files.js";

interface PullRequestFilePayload {
  readonly filename?: unknown;
  readonly previous_filename?: unknown;
  readonly status?: unknown;
  readonly additions?: unknown;
  readonly deletions?: unknown;
  readonly changes?: unknown;
  readonly patch?: unknown;
}

interface ReviewPayload {
  readonly id?: unknown;
  readonly body?: unknown;
  readonly commit_id?: unknown;
  readonly state?: unknown;
  readonly submitted_at?: unknown;
  readonly user?: unknown;
}

interface ReviewCommentPayload {
  readonly id?: unknown;
  readonly pull_request_review_id?: unknown;
  readonly in_reply_to_id?: unknown;
  readonly body?: unknown;
  readonly commit_id?: unknown;
  readonly original_commit_id?: unknown;
  readonly path?: unknown;
  readonly line?: unknown;
  readonly original_line?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
  readonly user?: unknown;
}

interface IssueCommentPayload {
  readonly id?: unknown;
  readonly body?: unknown;
  readonly created_at?: unknown;
  readonly updated_at?: unknown;
  readonly performed_via_github_app?: unknown;
  readonly user?: unknown;
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly operation?: string;
  readonly requestId?: string;
  readonly requiredPermission?: string;
  readonly graphqlErrors?: readonly unknown[];
  readonly diagnosticMessage: string;

  constructor(
    status: number,
    message: string,
    metadata: {
      readonly operation?: string;
      readonly requestId?: string;
      readonly requiredPermission?: string;
      readonly graphqlErrors?: readonly unknown[];
    } = {},
  ) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    if (metadata.operation !== undefined) this.operation = metadata.operation;
    if (metadata.requestId !== undefined) this.requestId = metadata.requestId;
    if (metadata.requiredPermission !== undefined)
      this.requiredPermission = metadata.requiredPermission;
    if (metadata.graphqlErrors !== undefined) this.graphqlErrors = metadata.graphqlErrors;
    this.diagnosticMessage = `GitHub API request failed (${status}).`;
  }
}

interface GitHubOperation extends DiagnosticDescriptor {
  readonly method: string;
  readonly requiredPermission?: string;
  readonly expectedStatuses?: readonly number[];
}

function githubOperation(
  phase: string,
  operation: string,
  purpose: string,
  method = "GET",
  requiredPermission?: string,
  expectedStatuses?: readonly number[],
): GitHubOperation {
  return {
    component: "github",
    phase,
    operation,
    purpose,
    method,
    ...(requiredPermission === undefined ? {} : { requiredPermission }),
    ...(expectedStatuses === undefined ? {} : { expectedStatuses }),
  };
}

function decodeOperation(operation: GitHubOperation, purpose: string): GitHubOperation {
  return githubOperation(
    `${operation.phase}.decode`,
    `${operation.operation}.decode`,
    purpose,
    operation.method,
    operation.requiredPermission,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerOrZero(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function readLogin(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.login !== "string" || value.login.length === 0) {
    return undefined;
  }
  return value.login;
}

function readUser(value: unknown): GitHubCommentAuthor | undefined {
  const login = readLogin(value);
  if (login === undefined || !isRecord(value) || typeof value.type !== "string") return undefined;
  return { login, type: value.type };
}

function positiveId(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`GitHub returned an invalid ${path}.`);
  }
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`GitHub returned an invalid ${path}.`);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return requiredString(value, path);
}

function errorDetails(payload: unknown, statusText: string): string {
  if (!isRecord(payload)) return statusText;
  const details: string[] = [];
  if (typeof payload.message === "string") details.push(payload.message);
  if (Array.isArray(payload.errors)) {
    for (const error of payload.errors) {
      if (typeof error === "string") details.push(error);
      else if (isRecord(error) && typeof error.message === "string") details.push(error.message);
    }
  }
  return details.join("; ") || statusText;
}

function responseStatusText(response: Response): string {
  const value = (response as Response & { readonly statusText?: unknown }).statusText;
  return typeof value === "string" ? value : "";
}

function responseRequestId(response: Response): string | undefined {
  const value = response.headers.get("x-github-request-id");
  return value === null ? undefined : value;
}

function responseDetails(
  response: Response,
  bodyLength?: number,
): Readonly<Record<string, unknown>> {
  const requestId = response.headers.get("x-github-request-id");
  const statusText = responseStatusText(response);
  return {
    status: response.status,
    ...(statusText.length === 0 ? {} : { status_text: statusText }),
    ...(bodyLength === undefined ? {} : { response_bytes: bodyLength }),
    ...(requestId === null ? {} : { request_id: requestId }),
    response_headers: Object.fromEntries(response.headers.entries()),
  };
}

function graphqlErrorMetadata(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((entry) => {
    if (!isRecord(entry)) return { type: typeof entry };
    const metadata: Record<string, unknown> = {};
    if (typeof entry.message === "string") metadata.message = entry.message;
    if (typeof entry.type === "string") metadata.type = entry.type;
    if (Array.isArray(entry.path))
      metadata.path = entry.path
        .slice(0, 20)
        .filter(
          (part): part is string | number => typeof part === "string" || typeof part === "number",
        );
    if (Array.isArray(entry.locations))
      metadata.locations = entry.locations.slice(0, 20).flatMap((location) => {
        if (!isRecord(location)) return [];
        const line = typeof location.line === "number" ? location.line : undefined;
        const column = typeof location.column === "number" ? location.column : undefined;
        return line === undefined && column === undefined ? [] : [{ line, column }];
      });
    if (isRecord(entry.extensions) && typeof entry.extensions.code === "string")
      metadata.code = entry.extensions.code;
    return metadata;
  });
}

function readHeadSha(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.head) || typeof value.head.sha !== "string") {
    return undefined;
  }
  return value.head.sha.length > 0 ? value.head.sha : undefined;
}

function readBaseSha(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.base) || typeof value.base.sha !== "string") {
    return undefined;
  }
  return value.base.sha.length > 0 ? value.base.sha : undefined;
}

function readBaseRef(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.base) || typeof value.base.ref !== "string") {
    return undefined;
  }
  return value.base.ref.length > 0 ? value.base.ref : undefined;
}

function readPullRequestContext(value: unknown, locator: PullRequestLocator): PullRequestContext {
  if (!isRecord(value)) throw new Error("GitHub returned invalid pull request metadata.");
  const headSha = readHeadSha(value);
  const baseSha = readBaseSha(value);
  const baseRef = readBaseRef(value);
  if (headSha === undefined || baseSha === undefined || baseRef === undefined) {
    throw new Error("GitHub returned incomplete pull request ref metadata.");
  }
  if (typeof value.title !== "string" || value.title.length === 0) {
    throw new Error("GitHub returned a pull request without a title.");
  }
  const changedFiles =
    typeof value.changed_files === "number" &&
    Number.isInteger(value.changed_files) &&
    value.changed_files >= 0
      ? value.changed_files
      : undefined;
  return {
    ...locator,
    headSha,
    baseSha,
    baseRef,
    ...(changedFiles === undefined ? {} : { changedFiles }),
    title: value.title,
    body:
      value.body === null || value.body === undefined
        ? ""
        : requiredString(value.body, "pull request body"),
  };
}

function parseAddedLines(patch: string | undefined): ReadonlySet<number> {
  const addedLines = new Set<number>();
  if (!patch) return addedLines;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      newLine = Number(header[1]);
      continue;
    }
    if (newLine < 1 || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      addedLines.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      continue;
    } else {
      newLine += 1;
    }
  }
  return addedLines;
}

function parsePatchCounts(patch: string | undefined): {
  readonly additions: number;
  readonly deletions: number;
  readonly complete: boolean;
} {
  if (!patch) return { additions: 0, deletions: 0, complete: false };
  let remainingOld = 0;
  let remainingNew = 0;
  let hasHunk = false;
  let complete = true;
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      if (hasHunk && (remainingOld !== 0 || remainingNew !== 0)) complete = false;
      remainingOld = Number(header[2] ?? 1);
      remainingNew = Number(header[4] ?? 1);
      hasHunk = true;
      continue;
    }
    if (!hasHunk || line.length === 0 || line.startsWith("\\")) continue;
    if (line.startsWith("+")) {
      additions += 1;
      if (remainingNew === 0) complete = false;
      else remainingNew -= 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
      if (remainingOld === 0) complete = false;
      else remainingOld -= 1;
    } else if (line.startsWith(" ")) {
      if (remainingOld === 0 || remainingNew === 0) complete = false;
      else {
        remainingOld -= 1;
        remainingNew -= 1;
      }
    } else complete = false;
  }
  if (!hasHunk || remainingOld !== 0 || remainingNew !== 0) complete = false;
  return { additions, deletions, complete };
}

export function isPatchComplete(file: ChangedFile): boolean {
  if (file.patch === undefined) {
    return (
      (file.status === "added" || file.status === "removed" || file.status === "renamed") &&
      file.additions === 0 &&
      file.deletions === 0
    );
  }
  const counts = parsePatchCounts(file.patch);
  return (
    counts.complete && counts.additions === file.additions && counts.deletions === file.deletions
  );
}

function readFilePayload(value: unknown, index: number): ChangedFile {
  if (!isRecord(value))
    throw new Error(`GitHub returned an invalid changed-file record at index ${index}.`);
  const payload = value as PullRequestFilePayload;
  if (typeof payload.filename !== "string" || payload.filename.length === 0) {
    throw new Error(`GitHub returned a changed file without a filename at index ${index}.`);
  }
  const patch = typeof payload.patch === "string" ? payload.patch : undefined;
  return {
    path: payload.filename,
    ...(typeof payload.previous_filename === "string" && payload.previous_filename.length > 0
      ? { previousPath: payload.previous_filename }
      : {}),
    status: typeof payload.status === "string" ? payload.status : "modified",
    additions: integerOrZero(payload.additions),
    deletions: integerOrZero(payload.deletions),
    changes: integerOrZero(payload.changes),
    ...(patch === undefined ? {} : { patch }),
    addedLines: parseAddedLines(patch),
  };
}

export interface GitHubCommentAuthor {
  readonly login: string;
  readonly type: string;
}

export interface ExistingReview {
  readonly id: number;
  readonly author?: GitHubCommentAuthor;
  readonly body: string;
  readonly commitId: string | null;
  readonly state: string;
  readonly submittedAt?: string;
}

export interface PullRequestReviewCommentRecord {
  readonly id: number;
  readonly reviewId?: number;
  readonly inReplyToId?: number;
  readonly author?: GitHubCommentAuthor;
  readonly body: string;
  readonly commitId: string;
  readonly originalCommitId: string;
  readonly path: string;
  readonly line?: number;
  readonly originalLine?: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PullRequestIssueCommentRecord {
  readonly id: number;
  readonly author?: GitHubCommentAuthor;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly performedViaGitHubApp: boolean;
}

function optionalUser(value: unknown, path: string): GitHubCommentAuthor | undefined {
  if (value === null) return undefined;
  const user = readUser(value);
  if (user === undefined) throw new Error(`GitHub returned an invalid ${path}.`);
  return user;
}

function optionalId(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return positiveId(value, path);
}

function nullableId(value: unknown, path: string): number | undefined {
  if (value === null) return undefined;
  return positiveId(value, path);
}

function readReviewPayload(value: unknown, index: number): ExistingReview {
  if (!isRecord(value)) throw new Error(`GitHub returned an invalid review at index ${index}.`);
  const review = value as ReviewPayload;
  const submittedAt =
    review.submitted_at === undefined || review.submitted_at === null
      ? undefined
      : requiredString(review.submitted_at, `review submitted_at at index ${index}`);
  const author = optionalUser(review.user, `review user at index ${index}`);
  return {
    id: positiveId(review.id, `review id at index ${index}`),
    ...(author === undefined ? {} : { author }),
    body: requiredString(review.body, `review body at index ${index}`),
    commitId: nullableString(review.commit_id, `review commit_id at index ${index}`),
    state: requiredString(review.state, `review state at index ${index}`),
    ...(submittedAt === undefined ? {} : { submittedAt }),
  };
}

function readReviewCommentPayload(value: unknown, index: number): PullRequestReviewCommentRecord {
  if (!isRecord(value)) {
    throw new Error(`GitHub returned an invalid pull request review comment at index ${index}.`);
  }
  const comment = value as ReviewCommentPayload;
  const inReplyToId = optionalId(
    comment.in_reply_to_id,
    `pull request review comment in_reply_to_id at index ${index}`,
  );
  const line = optionalId(comment.line, `pull request review comment line at index ${index}`);
  const originalLine = optionalId(
    comment.original_line,
    `pull request review comment original_line at index ${index}`,
  );
  const reviewId = nullableId(
    comment.pull_request_review_id,
    `pull request review comment review id at index ${index}`,
  );
  const author = optionalUser(comment.user, `pull request review comment user at index ${index}`);
  return {
    id: positiveId(comment.id, `pull request review comment id at index ${index}`),
    ...(reviewId === undefined ? {} : { reviewId }),
    ...(inReplyToId === undefined ? {} : { inReplyToId }),
    ...(author === undefined ? {} : { author }),
    body: requiredString(comment.body, `pull request review comment body at index ${index}`),
    commitId: requiredString(
      comment.commit_id,
      `pull request review comment commit_id at index ${index}`,
    ),
    originalCommitId: requiredString(
      comment.original_commit_id,
      `pull request review comment original_commit_id at index ${index}`,
    ),
    path: requiredString(comment.path, `pull request review comment path at index ${index}`),
    ...(line === undefined ? {} : { line }),
    ...(originalLine === undefined ? {} : { originalLine }),
    createdAt: requiredString(
      comment.created_at,
      `pull request review comment created_at at index ${index}`,
    ),
    updatedAt: requiredString(
      comment.updated_at,
      `pull request review comment updated_at at index ${index}`,
    ),
  };
}

function readIssueCommentPayload(value: unknown, index: number): PullRequestIssueCommentRecord {
  if (!isRecord(value)) {
    throw new Error(
      `GitHub returned an invalid pull request conversation comment at index ${index}.`,
    );
  }
  const comment = value as IssueCommentPayload;
  const body =
    comment.body === undefined || comment.body === null
      ? ""
      : requiredString(comment.body, `pull request conversation comment body at index ${index}`);
  const author = optionalUser(
    comment.user,
    `pull request conversation comment user at index ${index}`,
  );
  return {
    id: positiveId(comment.id, `pull request conversation comment id at index ${index}`),
    ...(author === undefined ? {} : { author }),
    body,
    createdAt: requiredString(
      comment.created_at,
      `pull request conversation comment created_at at index ${index}`,
    ),
    updatedAt: requiredString(
      comment.updated_at,
      `pull request conversation comment updated_at at index ${index}`,
    ),
    performedViaGitHubApp:
      comment.performed_via_github_app !== undefined && comment.performed_via_github_app !== null,
  };
}

interface RequestPage<T> {
  readonly payload: T;
  readonly headers: Headers;
}

function nextPagePath(link: string | null, apiUrl: string): string | undefined {
  if (!link) return undefined;
  const next = link
    .split(",")
    .map((part) => /<([^>]+)>;\s*rel="next"/.exec(part)?.[1])
    .find((value): value is string => value !== undefined);
  if (!next) return undefined;
  const absolute = new URL(next);
  const base = new URL(apiUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  const path = absolute.pathname.startsWith(basePath)
    ? absolute.pathname.slice(basePath.length) || "/"
    : absolute.pathname;
  return `${path}${absolute.search}`;
}

export class GitHubApi {
  private readonly apiUrl: string;
  private readonly graphqlUrl: string;
  private readonly token: string;
  private readonly signal: AbortSignal | undefined;
  private readonly diagnostics: DiagnosticLogger;

  constructor(
    token: string,
    apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    signal?: AbortSignal,
    graphqlUrl?: string,
    diagnostics = new DiagnosticLogger({ component: "github" }),
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.graphqlUrl = graphqlUrl?.replace(/\/$/, "") ?? graphqlUrlFor(this.apiUrl);
    this.token = token;
    this.signal = signal;
    this.diagnostics = diagnostics;
    this.diagnostics.addSecrets([token]);
  }

  private decode<T>(operation: GitHubOperation, action: () => T, details?: unknown): T {
    const span = this.diagnostics.start(
      decodeOperation(operation, "validate the GitHub response shape"),
      details,
    );
    try {
      const result = action();
      span.success();
      return result;
    } catch (error) {
      span.failure(error);
      throw error;
    }
  }

  async getAuthenticatedUserLogin(): Promise<string> {
    const operation = githubOperation(
      "identity.capture",
      "rest.user.current",
      "identify the GitHub account that owns lifecycle content",
      "GET",
      "metadata:read",
    );
    const payload = await this.request<unknown>("/user", operation);
    return this.decode(
      operation,
      () => {
        const login = readLogin(payload);
        if (login === undefined) throw new Error("GitHub returned no authenticated user login.");
        return login;
      },
      { stage: "login" },
    );
  }

  async getPullRequestContext(locator: PullRequestLocator): Promise<PullRequestContext> {
    const operation = githubOperation(
      "target.capture",
      "rest.pull-request.context",
      "capture immutable pull request metadata and refs",
      "GET",
      "pull_requests:read",
    );
    const payload = await this.request<unknown>(
      `/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}/pulls/${locator.number}`,
      operation,
    );
    return this.decode(operation, () => readPullRequestContext(payload, locator), {
      repository: locator.repository,
      pull_request: locator.number,
    });
  }

  async getLinkedIssues(context: PullRequestContext): Promise<ReviewBriefing> {
    const references = discoverLinkedIssueNumbers(context);
    const linkedIssues: LinkedIssueSnapshot[] = [];
    for (const number of references.numbers) {
      if (number === context.number) continue;
      const operation = githubOperation(
        "briefing.linked-issues",
        "rest.issue.lookup",
        "load a same-repository issue referenced by the pull request",
        "GET",
        "issues:read",
        [404],
      );
      let payload: unknown;
      try {
        payload = await this.request<unknown>(
          `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/issues/${number}`,
          operation,
          {},
          { issue_number: number },
        );
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) continue;
        throw error;
      }
      if (!isRecord(payload) || Object.hasOwn(payload, "pull_request")) continue;
      linkedIssues.push(
        this.decode(operation, () => issueSnapshot(number, payload), { issue_number: number }),
      );
    }
    return {
      linkedIssues,
      linkedIssueReferencesTruncated: references.truncated,
    };
  }

  async getPullRequestRefs(
    context: PullRequestContext,
  ): Promise<{ readonly headSha: string; readonly baseSha: string }> {
    const operation = githubOperation(
      "publication.head-fence",
      "rest.pull-request.refs",
      "verify the live pull request refs before a write",
      "GET",
      "pull_requests:read",
    );
    const payload = await this.request<unknown>(
      `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}`,
      operation,
    );
    return this.decode(
      operation,
      () => {
        const headSha = readHeadSha(payload);
        const baseSha = readBaseSha(payload);
        if (headSha === undefined || baseSha === undefined) {
          throw new Error("GitHub returned incomplete pull request ref metadata.");
        }
        return { headSha, baseSha };
      },
      { stage: "refs" },
    );
  }

  async getPullRequestHeadSha(context: PullRequestContext): Promise<string> {
    return (await this.getPullRequestRefs(context)).headSha;
  }

  private async requestPage<T>(
    path: string,
    operation: GitHubOperation,
    init: RequestInit = {},
    details?: unknown,
  ): Promise<RequestPage<T>> {
    const signal = init.signal ?? this.signal;
    const span = this.diagnostics.start(operation, {
      method: init.method ?? operation.method,
      route: path,
      ...(operation.requiredPermission === undefined
        ? {}
        : { required_permission: operation.requiredPermission }),
      ...(details === undefined ? {} : { request: details }),
    });
    let responseMetadata: Readonly<Record<string, unknown>> | undefined;
    let bodyRead = false;
    try {
      throwIfAborted(signal ?? undefined);
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/vnd.github+json");
      headers.set("Authorization", `Bearer ${this.token}`);
      headers.set("X-GitHub-Api-Version", "2022-11-28");
      if (init.body !== undefined) headers.set("Content-Type", "application/json");
      const response = await fetch(`${this.apiUrl}${path}`, {
        ...init,
        headers,
        ...(signal === undefined ? {} : { signal }),
      });
      responseMetadata = {
        ...responseDetails(response),
        ...(operation.requiredPermission === undefined
          ? {}
          : { required_permission: operation.requiredPermission }),
      };
      const text = await response.text();
      bodyRead = true;
      throwIfAborted(signal ?? undefined);
      let payload: unknown = undefined;
      if (text.length > 0) {
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          payload = undefined;
        }
      }
      responseMetadata = {
        ...responseMetadata,
        response_bytes: Buffer.byteLength(text),
      };
      if (!response.ok) {
        const requestId = responseRequestId(response);
        const error = new GitHubApiError(
          response.status,
          `GitHub API request failed (${response.status}): ${errorDetails(payload, responseStatusText(response))}`,
          {
            operation: operation.operation,
            ...(requestId === undefined ? {} : { requestId }),
            ...(operation.requiredPermission === undefined
              ? {}
              : { requiredPermission: operation.requiredPermission }),
          },
        );
        if (operation.expectedStatuses?.includes(response.status))
          span.skipped({ ...responseMetadata, reason: "expected non-success response" });
        else span.failure(error, responseMetadata);
        throw error;
      }
      span.success(responseMetadata);
      return { payload: payload as T, headers: response.headers };
    } catch (error) {
      const bodyReadFailure = responseMetadata !== undefined && !bodyRead;
      if (bodyReadFailure)
        this.diagnostics.registerSafeDiagnosticError(
          error,
          "GitHub REST response body read failed.",
        );
      const diagnosticError = bodyReadFailure
        ? new Error("GitHub REST response body read failed.")
        : error;
      if (signal?.aborted) span.cancelled(diagnosticError, responseMetadata);
      else if (error instanceof GitHubApiError && error.operation === operation.operation) {
        // The HTTP failure was already recorded with response metadata above.
      } else {
        span.failure(diagnosticError, responseMetadata);
      }
      throw error;
    }
  }

  private async request<T>(
    path: string,
    operation: GitHubOperation,
    init: RequestInit = {},
    details?: unknown,
  ): Promise<T> {
    return (await this.requestPage<T>(path, operation, init, details)).payload;
  }

  private async requestGraphql<T>(
    query: string,
    variables: Readonly<Record<string, unknown>>,
    operation: GitHubOperation,
    details?: unknown,
  ): Promise<T> {
    const signal = this.signal;
    const span = this.diagnostics.start(operation, {
      method: "POST",
      route: this.graphqlUrl,
      ...(operation.requiredPermission === undefined
        ? {}
        : { required_permission: operation.requiredPermission }),
      ...(details === undefined ? {} : { request: details }),
    });
    let responseMetadata: Readonly<Record<string, unknown>> | undefined;
    let bodyRead = false;
    try {
      throwIfAborted(signal);
      const response = await fetch(this.graphqlUrl, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify({ query, variables }),
        ...(signal === undefined ? {} : { signal }),
      });
      responseMetadata = {
        ...responseDetails(response),
        ...(operation.requiredPermission === undefined
          ? {}
          : { required_permission: operation.requiredPermission }),
      };
      const text = await response.text();
      bodyRead = true;
      throwIfAborted(signal);
      let payload: unknown = undefined;
      if (text.length > 0) {
        try {
          payload = JSON.parse(text) as unknown;
        } catch {
          payload = undefined;
        }
      }
      responseMetadata = {
        ...responseMetadata,
        response_bytes: Buffer.byteLength(text),
      };
      if (!response.ok) {
        const requestId = responseRequestId(response);
        const graphqlErrors = isRecord(payload)
          ? graphqlErrorMetadata(payload.errors)
          : ([] as readonly Record<string, unknown>[]);
        const error = new GitHubApiError(
          response.status,
          `GitHub GraphQL request failed (${response.status}): ${errorDetails(payload, responseStatusText(response))}`,
          {
            operation: operation.operation,
            ...(requestId === undefined ? {} : { requestId }),
            ...(operation.requiredPermission === undefined
              ? {}
              : { requiredPermission: operation.requiredPermission }),
            graphqlErrors,
          },
        );
        span.failure(error, {
          ...responseMetadata,
          ...(graphqlErrors.length === 0 ? {} : { graphql_errors: graphqlErrors }),
        });
        throw error;
      }
      if (!isRecord(payload)) {
        const error = new Error("GitHub returned an invalid GraphQL response.");
        span.failure(error, responseMetadata);
        throw error;
      }
      const responsePayload = payload;
      if (Array.isArray(responsePayload.errors) && responsePayload.errors.length > 0) {
        const requestId = responseRequestId(response);
        const errors = graphqlErrorMetadata(responsePayload.errors);
        const messages = errors.flatMap((error) => {
          if (!isRecord(error) || typeof error.message !== "string") return [];
          return [error.message];
        });
        const error = new GitHubApiError(
          200,
          `GitHub GraphQL request returned errors: ${messages.join("; ") || "unknown error"}`,
          {
            operation: operation.operation,
            ...(requestId === undefined ? {} : { requestId }),
            ...(operation.requiredPermission === undefined
              ? {}
              : { requiredPermission: operation.requiredPermission }),
            graphqlErrors: errors,
          },
        );
        span.failure(error, {
          ...responseMetadata,
          graphql_errors: errors,
        });
        throw error;
      }
      span.success(responseMetadata);
      return responsePayload.data as T;
    } catch (error) {
      const bodyReadFailure = responseMetadata !== undefined && !bodyRead;
      if (bodyReadFailure)
        this.diagnostics.registerSafeDiagnosticError(
          error,
          "GitHub GraphQL response body read failed.",
        );
      const diagnosticError = bodyReadFailure
        ? new Error("GitHub GraphQL response body read failed.")
        : error;
      if (signal?.aborted) span.cancelled(diagnosticError, responseMetadata);
      else if (error instanceof GitHubApiError && error.operation === operation.operation) {
        // The GitHub response failure was already recorded with response metadata above.
      } else {
        span.failure(diagnosticError, responseMetadata);
      }
      throw error;
    }
  }

  private async listRecords<T>(
    pathForPage: (page: number) => string,
    responseName: string,
    read: (value: unknown, index: number) => T,
    operation: GitHubOperation,
  ): Promise<readonly T[]> {
    const records: T[] = [];
    let page = 1;
    let path = pathForPage(page);
    let hasNext = true;
    while (hasNext) {
      const response: RequestPage<unknown> = await this.requestPage<unknown>(
        path,
        operation,
        {},
        { page },
      );
      const pageRecords = this.decode(
        operation,
        () => {
          if (!Array.isArray(response.payload)) {
            throw new Error(`GitHub returned an invalid ${responseName} response.`);
          }
          return response.payload.map((item, index) => read(item, records.length + index));
        },
        { page, record_type: responseName },
      );
      records.push(...pageRecords);
      const nextPath = this.decode(
        operation,
        () => nextPagePath(response.headers.get("link"), this.apiUrl),
        { page, stage: "pagination" },
      );
      hasNext = nextPath !== undefined || pageRecords.length === 100;
      if (!hasNext) continue;
      page += 1;
      path = nextPath ?? pathForPage(page);
    }
    return records;
  }

  async getPullRequestFiles(context: PullRequestContext): Promise<readonly ChangedFile[]> {
    const files: ChangedFile[] = [];
    const operation = githubOperation(
      "diff.metadata",
      "rest.pull-request.files",
      "load changed-file metadata and patch boundaries",
      "GET",
      "pull_requests:read",
    );
    let page = 1;
    let path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/files?per_page=100&page=${page}`;
    let hasNext = true;
    while (hasNext) {
      const response: RequestPage<unknown> = await this.requestPage<unknown>(
        path,
        operation,
        {},
        { page },
      );
      const payload = this.decode(
        operation,
        () => {
          if (!Array.isArray(response.payload))
            throw new Error("GitHub returned an invalid pull request files response.");
          const pageFiles = response.payload.map((item, index) =>
            readFilePayload(item, files.length + index),
          );
          if (files.length + pageFiles.length > 3_000) {
            throw new Error("GitHub returned more than the pull request file API limit.");
          }
          if (
            context.changedFiles !== undefined &&
            files.length + pageFiles.length > context.changedFiles
          ) {
            throw new Error("GitHub returned more files than the pull request metadata reports.");
          }
          return pageFiles;
        },
        { page, record_type: "pull request files" },
      );
      files.push(...payload);
      if (payload.length < 100) {
        hasNext = false;
        continue;
      }
      page += 1;
      path =
        this.decode(operation, () => nextPagePath(response.headers.get("link"), this.apiUrl), {
          page,
          stage: "pagination",
        }) ??
        `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/files?per_page=100&page=${page}`;
    }
    this.decode(
      operation,
      () => {
        if (context.changedFiles !== undefined && context.changedFiles > files.length) {
          throw new Error("GitHub returned an incomplete pull request file list.");
        }
      },
      { stage: "complete" },
    );
    return files;
  }

  async listReviews(context: PullRequestContext): Promise<readonly ExistingReview[]> {
    return this.listRecords(
      (page) =>
        `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/reviews?per_page=100&page=${page}`,
      "pull request reviews",
      readReviewPayload,
      githubOperation(
        "conversation.capture",
        "rest.pull-request.reviews",
        "load pull request review summaries and bodies",
        "GET",
        "pull_requests:read",
      ),
    );
  }

  async listReviewComments(
    context: PullRequestContext,
  ): Promise<readonly PullRequestReviewCommentRecord[]> {
    return this.listRecords(
      (page) =>
        `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/comments?per_page=100&page=${page}`,
      "pull request review comments",
      readReviewCommentPayload,
      githubOperation(
        "conversation.capture",
        "rest.pull-request.review-comments",
        "load inline review comments and replies",
        "GET",
        "pull_requests:read",
      ),
    );
  }

  async listIssueComments(
    context: PullRequestContext,
  ): Promise<readonly PullRequestIssueCommentRecord[]> {
    return this.listRecords(
      (page) =>
        `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/issues/${context.number}/comments?per_page=100&page=${page}`,
      "pull request conversation comments",
      readIssueCommentPayload,
      githubOperation(
        "conversation.capture",
        "rest.pull-request.issue-comments",
        "load pull request conversation comments",
        "GET",
        "issues:read",
      ),
    );
  }

  async createReview(
    context: PullRequestContext,
    request: PullRequestReviewRequest,
  ): Promise<void> {
    await this.request<unknown>(
      `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/reviews`,
      githubOperation(
        "publication.review",
        "rest.pull-request.create-review",
        "publish the completed pull request review",
        "POST",
        "pull_requests:write",
      ),
      { method: "POST", body: JSON.stringify(request) },
      {
        event: request.event,
        comment_count: request.comments.length,
        commit_present: request.commit_id.length > 0,
      },
    );
  }

  private async completeLifecycleThread(
    thread: ReviewLifecycleThreadRecord,
  ): Promise<ReviewLifecycleThreadRecord> {
    const comments = [...thread.comments];
    const operation = githubOperation(
      "lifecycle.snapshot",
      "AiPrReviewerThreadComments",
      "load the next page of comments for a lifecycle review thread",
      "POST",
      "pull_requests:read",
    );
    let cursor = thread.commentsCursor;
    let pages = 0;
    while (cursor !== undefined) {
      pages += 1;
      if (pages > 100) {
        this.decode(
          operation,
          () => {
            throw new Error("GitHub returned more than 10,000 comments in a review thread.");
          },
          { page: pages, stage: "pagination" },
        );
      }
      const data = await this.requestGraphql<unknown>(
        REVIEW_LIFECYCLE_THREAD_COMMENTS_QUERY,
        { threadId: thread.nodeId, cursor },
        operation,
        { page: pages, cursor_present: true },
      );
      const page = this.decode(operation, () => readGraphqlThreadComments(data, comments.length), {
        page: pages,
        cursor_present: true,
      });
      comments.push(...page.comments);
      if (!page.hasNextPage) {
        cursor = undefined;
      } else if (page.endCursor === undefined || page.endCursor === cursor) {
        this.decode(
          operation,
          () => {
            throw new Error("GitHub returned a non-advancing review thread comment cursor.");
          },
          { page: pages, stage: "pagination" },
        );
      } else {
        cursor = page.endCursor;
      }
    }
    const { commentsCursor: ignoredCursor, ...threadWithoutCursor } = thread;
    void ignoredCursor;
    const root = comments.find((comment) => comment.replyToId === undefined) ?? comments[0];
    return {
      ...threadWithoutCursor,
      ...(root?.reviewId === undefined ? {} : { reviewId: root.reviewId }),
      ...(root?.reviewNodeId === undefined ? {} : { reviewNodeId: root.reviewNodeId }),
      comments,
    };
  }

  async getReviewLifecycleSnapshot(context: PullRequestContext): Promise<ReviewLifecycleSnapshot> {
    const variables = {
      owner: context.owner,
      name: context.name,
      number: context.number,
    };
    const reviews: ReviewLifecycleReviewRecord[] = [];
    let reviewCursor: string | undefined;
    let reviewPage = 0;
    for (;;) {
      reviewPage += 1;
      const operation = githubOperation(
        "lifecycle.prepare",
        "AiPrReviewerReviews",
        "load pull request reviews for lifecycle reconciliation",
        "POST",
        "pull_requests:read",
      );
      const data = await this.requestGraphql<unknown>(
        REVIEW_LIFECYCLE_REVIEWS_QUERY,
        { ...variables, cursor: reviewCursor ?? null },
        operation,
        { page: reviewPage, cursor_present: reviewCursor !== undefined },
      );
      const connection = this.decode(
        operation,
        () => readGraphqlConnection(pullRequestConnection(data, "reviews"), "pull request reviews"),
        { page: reviewPage, record_type: "pull request reviews" },
      );
      const pageReviews = this.decode(
        operation,
        () =>
          connection.nodes.map((review, index) =>
            readGraphqlReview(review, reviews.length + index),
          ),
        { page: reviewPage, record_type: "review" },
      );
      reviews.push(...pageReviews);
      if (!connection.hasNextPage) break;
      this.decode(
        operation,
        () => {
          if (connection.endCursor === undefined || connection.endCursor === reviewCursor) {
            throw new Error("GitHub returned a non-advancing pull request review cursor.");
          }
        },
        { page: reviewPage, stage: "pagination" },
      );
      reviewCursor = connection.endCursor;
    }

    const threads: ReviewLifecycleThreadRecord[] = [];
    let threadCursor: string | undefined;
    let threadPage = 0;
    for (;;) {
      threadPage += 1;
      const operation = githubOperation(
        "lifecycle.prepare",
        "AiPrReviewerThreads",
        "load pull request review threads for lifecycle reconciliation",
        "POST",
        "pull_requests:read",
      );
      const data = await this.requestGraphql<unknown>(
        REVIEW_LIFECYCLE_THREADS_QUERY,
        { ...variables, cursor: threadCursor ?? null },
        operation,
        { page: threadPage, cursor_present: threadCursor !== undefined },
      );
      const connection = this.decode(
        operation,
        () =>
          readGraphqlConnection(
            pullRequestConnection(data, "reviewThreads"),
            "pull request review threads",
          ),
        { page: threadPage, record_type: "pull request review threads" },
      );
      const pageOffset = threads.length;
      for (const [index, value] of connection.nodes.entries()) {
        const thread = this.decode(operation, () => readGraphqlThread(value, pageOffset + index), {
          page: threadPage,
          record_type: "review thread",
          index: pageOffset + index,
        });
        threads.push(await this.completeLifecycleThread(thread));
      }
      if (!connection.hasNextPage) break;
      this.decode(
        operation,
        () => {
          if (connection.endCursor === undefined || connection.endCursor === threadCursor) {
            throw new Error("GitHub returned a non-advancing pull request review thread cursor.");
          }
        },
        { page: threadPage, stage: "pagination" },
      );
      threadCursor = connection.endCursor;
    }
    return { reviews, threads };
  }

  async updateSubmittedReview(reviewNodeId: string, body: string): Promise<void> {
    const operation = githubOperation(
      "lifecycle.prepare",
      "AiPrReviewerUpdateReview",
      "mark a stale clean action review with the current head",
      "POST",
      "pull_requests:write",
    );
    const data = await this.requestGraphql<unknown>(
      UPDATE_REVIEW_MUTATION,
      { reviewId: reviewNodeId, body },
      operation,
      { review_id: reviewNodeId },
    );
    this.decode(
      operation,
      () => {
        const payload = requiredRecord(
          requiredRecord(data, "GraphQL data").updatePullRequestReview,
          "updated review payload",
        );
        const review = requiredRecord(payload.pullRequestReview, "updated review");
        if (
          requiredString(review.id, "updated review id") !== reviewNodeId ||
          requiredString(review.body, "updated review body") !== body
        ) {
          throw new Error("GitHub did not update the pull request review.");
        }
      },
      { review_id: reviewNodeId },
    );
  }

  async dismissSubmittedReview(reviewNodeId: string, message: string): Promise<void> {
    const operation = githubOperation(
      "lifecycle.prepare",
      "AiPrReviewerDismissReview",
      "dismiss a stale action approval before newer-head analysis",
      "POST",
      "pull_requests:write",
    );
    const data = await this.requestGraphql(
      DISMISS_REVIEW_MUTATION,
      { reviewId: reviewNodeId, message },
      operation,
      { review_id: reviewNodeId },
    );
    this.decode(
      operation,
      () => {
        const payload = requiredRecord(
          requiredRecord(data, "GraphQL data").dismissPullRequestReview,
          "dismiss review payload",
        );
        const review = requiredRecord(payload.pullRequestReview, "dismissed review");
        if (
          requiredString(review.id, "dismissed review id") !== reviewNodeId ||
          requiredString(review.state, "dismissed review state") !== "DISMISSED"
        ) {
          throw new Error("GitHub did not dismiss the pull request review.");
        }
      },
      { review_id: reviewNodeId },
    );
  }

  async resolveReviewThread(threadNodeId: string): Promise<void> {
    const operation = githubOperation(
      "lifecycle.resolve",
      "AiPrReviewerResolveThread",
      "resolve a verified fixed action review thread",
      "POST",
      "contents:write + pull_requests:write",
    );
    const data = await this.requestGraphql(
      RESOLVE_THREAD_MUTATION,
      { threadId: threadNodeId },
      operation,
      { thread_id: threadNodeId },
    );
    this.decode(
      operation,
      () => {
        const payload = requiredRecord(
          requiredRecord(data, "GraphQL data").resolveReviewThread,
          "resolve thread payload",
        );
        const thread = requiredRecord(payload.thread, "resolved thread");
        if (thread.isResolved !== true) {
          throw new Error("GitHub did not resolve the pull request review thread.");
        }
      },
      { thread_id: threadNodeId },
    );
  }

  async minimizeComment(subjectNodeId: string): Promise<void> {
    const operation = githubOperation(
      "lifecycle.finalize",
      "AiPrReviewerMinimizeComment",
      "minimize a superseded action review after all threads resolve",
      "POST",
      "pull_requests:write",
    );
    const data = await this.requestGraphql(
      MINIMIZE_COMMENT_MUTATION,
      { subjectId: subjectNodeId, classifier: "OUTDATED" },
      operation,
      { subject_id: subjectNodeId },
    );
    this.decode(
      operation,
      () => {
        const payload = requiredRecord(
          requiredRecord(data, "GraphQL data").minimizeComment,
          "minimized comment payload",
        );
        const comment = requiredRecord(payload.minimizedComment, "minimized comment");
        if (comment.isMinimized !== true) {
          throw new Error("GitHub did not minimize the pull request review.");
        }
      },
      { subject_id: subjectNodeId },
    );
  }

  async updateReviewComment(
    context: PullRequestContext,
    commentId: number,
    body: string,
  ): Promise<void> {
    await this.request<unknown>(
      `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/comments/${commentId}`,
      githubOperation(
        "lifecycle.resolve",
        "rest.pull-request.update-comment",
        "rewrite an action-owned root finding comment with its fixed disposition",
        "PATCH",
        "pull_requests:write",
      ),
      { method: "PATCH", body: JSON.stringify({ body }) },
      { comment_id: commentId },
    );
  }
}

export const githubApiInternals = {
  decodeGitPath,
  diffPath,
  readGitMergeBase,
  readGitAddedLines,
  readGitMetadata,
  parseGitNameStatus,
  parseGitNumstat,
  parseAddedLines,
  parsePatchCounts,
  isPatchComplete,
  nextPagePath,
  readBaseSha,
  readBaseRef,
  readPullRequestContext,
  errorDetails,
  readHeadSha,
  readLogin,
  readIssueCommentPayload,
  readReviewCommentPayload,
  readReviewPayload,
  readUser,
  graphqlUrlFor,
  readGraphqlConnection,
  readGraphqlReview,
  readGraphqlComment,
  readGraphqlThread,
  graphqlErrorMetadata,
};
