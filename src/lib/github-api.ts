import type { ChangedFile, PullRequestContext, PullRequestReviewRequest } from "./types.js";

interface PullRequestFilePayload {
  readonly filename?: unknown;
  readonly status?: unknown;
  readonly additions?: unknown;
  readonly deletions?: unknown;
  readonly changes?: unknown;
  readonly patch?: unknown;
}

interface ReviewPayload {
  readonly body?: unknown;
  readonly commit_id?: unknown;
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
    status: typeof payload.status === "string" ? payload.status : "modified",
    additions: integerOrZero(payload.additions),
    deletions: integerOrZero(payload.deletions),
    changes: integerOrZero(payload.changes),
    ...(patch === undefined ? {} : { patch }),
    addedLines: parseAddedLines(patch),
  };
}

export interface ExistingReview {
  readonly body: string;
  readonly commitId: string;
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
          if (typeof review.body !== "string" || typeof review.commit_id !== "string") return [];
          return [{ body: review.body, commitId: review.commit_id }];
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
  nextPagePath,
};
