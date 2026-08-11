import type { ChangedFile, PullRequestContext, PullRequestReviewRequest } from "./types.js";

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
  readonly body?: unknown;
  readonly commit_id?: unknown;
  readonly state?: unknown;
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

export interface ExistingReview {
  readonly authorLogin: string;
  readonly body: string;
  readonly commitId: string;
  readonly state: string;
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
      const message =
        isRecord(payload) && typeof payload.message === "string"
          ? payload.message
          : response.statusText;
      throw new GitHubApiError(
        response.status,
        `GitHub API request failed (${response.status}): ${message}`,
      );
    }
    return { payload: payload as T, headers: response.headers };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.requestPage<T>(path, init)).payload;
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
    const reviews: ExistingReview[] = [];
    let page = 1;
    let path = `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/reviews?per_page=100&page=${page}`;
    let hasNext = true;
    while (hasNext) {
      const response: RequestPage<unknown> = await this.requestPage<unknown>(path);
      const payload = response.payload;
      if (!Array.isArray(payload))
        throw new Error("GitHub returned an invalid pull request reviews response.");
      reviews.push(
        ...payload.flatMap((item): ExistingReview[] => {
          if (!isRecord(item)) return [];
          const review = item as ReviewPayload;
          const authorLogin = readLogin(review.user);
          if (
            authorLogin === undefined ||
            typeof review.body !== "string" ||
            typeof review.commit_id !== "string"
          )
            return [];
          return [
            {
              authorLogin,
              body: review.body,
              commitId: review.commit_id,
              state: typeof review.state === "string" ? review.state : "UNKNOWN",
            },
          ];
        }),
      );
      if (payload.length < 100) {
        hasNext = false;
        continue;
      }
      page += 1;
      path =
        nextPagePath(response.headers.get("link"), this.apiUrl) ??
        `/repos/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.name)}/pulls/${context.number}/reviews?per_page=100&page=${page}`;
    }
    return reviews;
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
  readHeadSha,
  readLogin,
};
