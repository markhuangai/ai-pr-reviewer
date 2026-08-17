import type {
  ChangedFile,
  PullRequestContext,
  PullRequestLocator,
  PullRequestReviewRequest,
} from "./types.js";

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

  constructor(status: number, message: string) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
  }
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
  private readonly token: string;

  constructor(token: string, apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com") {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.token = token;
  }

  async getAuthenticatedUserLogin(): Promise<string> {
    const login = readLogin(await this.request<unknown>("/user"));
    if (login === undefined) throw new Error("GitHub returned no authenticated user login.");
    return login;
  }

  async getPullRequestContext(locator: PullRequestLocator): Promise<PullRequestContext> {
    const payload = await this.request<unknown>(
      `/repos/${encodeURIComponent(locator.owner)}/${encodeURIComponent(locator.name)}/pulls/${locator.number}`,
    );
    return readPullRequestContext(payload, locator);
  }

  async getPullRequestRefs(
    context: PullRequestContext,
  ): Promise<{ readonly headSha: string; readonly baseSha: string }> {
    const payload = await this.request<unknown>(
      `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}`,
    );
    const headSha = readHeadSha(payload);
    const baseSha = readBaseSha(payload);
    if (headSha === undefined || baseSha === undefined) {
      throw new Error("GitHub returned incomplete pull request ref metadata.");
    }
    return { headSha, baseSha };
  }

  async getPullRequestHeadSha(context: PullRequestContext): Promise<string> {
    return (await this.getPullRequestRefs(context)).headSha;
  }

  private async requestPage<T>(path: string, init: RequestInit = {}): Promise<RequestPage<T>> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/vnd.github+json");
    headers.set("Authorization", `Bearer ${this.token}`);
    headers.set("X-GitHub-Api-Version", "2022-11-28");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(`${this.apiUrl}${path}`, { ...init, headers });
    const text = await response.text();
    let payload: unknown = undefined;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = undefined;
      }
    }
    if (!response.ok) {
      throw new GitHubApiError(
        response.status,
        `GitHub API request failed (${response.status}): ${errorDetails(payload, response.statusText)}`,
      );
    }
    return { payload: payload as T, headers: response.headers };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.requestPage<T>(path, init)).payload;
  }

  private async listRecords<T>(
    pathForPage: (page: number) => string,
    responseName: string,
    read: (value: unknown, index: number) => T,
  ): Promise<readonly T[]> {
    const records: T[] = [];
    let page = 1;
    let path = pathForPage(page);
    let hasNext = true;
    while (hasNext) {
      const response: RequestPage<unknown> = await this.requestPage<unknown>(path);
      if (!Array.isArray(response.payload)) {
        throw new Error(`GitHub returned an invalid ${responseName} response.`);
      }
      records.push(...response.payload.map((item, index) => read(item, records.length + index)));
      const nextPath = nextPagePath(response.headers.get("link"), this.apiUrl);
      hasNext = nextPath !== undefined || response.payload.length === 100;
      if (!hasNext) continue;
      page += 1;
      path = nextPath ?? pathForPage(page);
    }
    return records;
  }

  async getPullRequestFiles(context: PullRequestContext): Promise<readonly ChangedFile[]> {
    const files: ChangedFile[] = [];
    let page = 1;
    let path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/files?per_page=100&page=${page}`;
    let hasNext = true;
    while (hasNext) {
      const response: RequestPage<unknown> = await this.requestPage<unknown>(path);
      const payload = response.payload;
      if (!Array.isArray(payload))
        throw new Error("GitHub returned an invalid pull request files response.");
      files.push(...payload.map((item, index) => readFilePayload(item, files.length + index)));
      if (files.length > 3_000) {
        throw new Error("GitHub returned more than the pull request file API limit.");
      }
      if (context.changedFiles !== undefined && files.length > context.changedFiles) {
        throw new Error("GitHub returned more files than the pull request metadata reports.");
      }
      if (payload.length < 100) {
        hasNext = false;
        continue;
      }
      page += 1;
      path =
        nextPagePath(response.headers.get("link"), this.apiUrl) ??
        `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/files?per_page=100&page=${page}`;
    }
    if (context.changedFiles !== undefined && context.changedFiles > files.length) {
      throw new Error("GitHub returned an incomplete pull request file list.");
    }
    return files;
  }

  async listReviews(context: PullRequestContext): Promise<readonly ExistingReview[]> {
    return this.listRecords(
      (page) =>
        `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/reviews?per_page=100&page=${page}`,
      "pull request reviews",
      readReviewPayload,
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
    );
  }

  async createReview(
    context: PullRequestContext,
    request: PullRequestReviewRequest,
  ): Promise<void> {
    await this.request<unknown>(
      `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/reviews`,
      { method: "POST", body: JSON.stringify(request) },
    );
  }
}

export const githubApiInternals = {
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
};
