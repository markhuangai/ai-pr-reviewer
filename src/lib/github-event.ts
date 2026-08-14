import { readFile } from "node:fs/promises";

import type { PullRequestContext, PullRequestLocator } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`GitHub event field '${path}' is missing.`);
  return value;
}

function numberAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`GitHub event field '${path}' is invalid.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export async function readPullRequestContext(
  eventPath: string | undefined = process.env.GITHUB_EVENT_PATH,
  repository: string | undefined = process.env.GITHUB_REPOSITORY,
): Promise<PullRequestContext> {
  const context = await readPullRequestEventContext(eventPath, repository);
  if (context === undefined) {
    throw new Error(
      "No pull request target was provided; run this action from a pull_request event or set 'pull-request-url'.",
    );
  }
  return context;
}

export async function readPullRequestEventContext(
  eventPath: string | undefined = process.env.GITHUB_EVENT_PATH,
  repository: string | undefined = process.env.GITHUB_REPOSITORY,
): Promise<PullRequestContext | undefined> {
  if (!eventPath) return undefined;
  const parsed: unknown = JSON.parse(await readFile(eventPath, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.pull_request)) return undefined;
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be in owner/name form.");
  }
  const pullRequest = parsed.pull_request;
  const head = isRecord(pullRequest.head) ? pullRequest.head : undefined;
  const base = isRecord(pullRequest.base) ? pullRequest.base : undefined;
  const changedFiles = optionalNonNegativeInteger(pullRequest.changed_files);
  const [owner, name] = repository.split("/");
  if (!owner || !name) throw new Error("GITHUB_REPOSITORY is invalid.");
  return {
    repository,
    owner,
    name,
    number: numberAt(parsed.number ?? pullRequest.number, "number"),
    headSha: stringAt(head?.sha, "pull_request.head.sha"),
    baseSha: stringAt(base?.sha, "pull_request.base.sha"),
    baseRef: stringAt(base?.ref, "pull_request.base.ref"),
    ...(changedFiles === undefined ? {} : { changedFiles }),
    title: stringAt(pullRequest.title, "pull_request.title"),
    htmlUrl: stringAt(pullRequest.html_url, "pull_request.html_url"),
  };
}

function normalizedOrigin(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute HTTP(S) URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must use http:// or https://.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${name} must not contain URL credentials.`);
  }
  return url;
}

export function parsePullRequestUrl(
  value: string,
  serverUrl: string | undefined = process.env.GITHUB_SERVER_URL,
): PullRequestLocator {
  if (!serverUrl) throw new Error("GITHUB_SERVER_URL is not set.");
  const target = normalizedOrigin(value, "Input 'pull-request-url'");
  const server = normalizedOrigin(serverUrl, "GITHUB_SERVER_URL");
  if (target.origin !== server.origin) {
    throw new Error("Input 'pull-request-url' must use the same origin as GITHUB_SERVER_URL.");
  }
  const segments = target.pathname.split("/").filter((segment) => segment.length > 0);
  const [owner, name, pullSegment, rawNumber] = segments;
  if (
    owner === undefined ||
    name === undefined ||
    pullSegment !== "pull" ||
    rawNumber === undefined ||
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(name) ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".." ||
    !/^[1-9][0-9]*$/.test(rawNumber)
  ) {
    throw new Error(
      "Input 'pull-request-url' must identify a pull request as /owner/repository/pull/number.",
    );
  }
  const number = Number(rawNumber);
  if (!Number.isSafeInteger(number)) {
    throw new Error("Input 'pull-request-url' contains an invalid pull request number.");
  }
  const repository = `${owner}/${name}`;
  return {
    repository,
    owner,
    name,
    number,
    htmlUrl: `${server.origin}/${owner}/${name}/pull/${number}`,
  };
}

export function samePullRequest(
  context: Pick<PullRequestContext, "repository" | "number">,
  locator: Pick<PullRequestLocator, "repository" | "number">,
): boolean {
  return (
    context.number === locator.number &&
    context.repository.toLowerCase() === locator.repository.toLowerCase()
  );
}
