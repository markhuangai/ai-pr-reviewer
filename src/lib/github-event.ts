import { readFile } from "node:fs/promises";

import type { PullRequestContext } from "./types.js";

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

export async function readPullRequestContext(
  eventPath: string | undefined = process.env.GITHUB_EVENT_PATH,
  repository: string | undefined = process.env.GITHUB_REPOSITORY,
): Promise<PullRequestContext> {
  if (!eventPath)
    throw new Error("GITHUB_EVENT_PATH is not set; run this action from a pull_request event.");
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be in owner/name form.");
  }
  const parsed: unknown = JSON.parse(await readFile(eventPath, "utf8"));
  if (!isRecord(parsed) || !isRecord(parsed.pull_request)) {
    throw new Error("This action only supports pull request events.");
  }
  const pullRequest = parsed.pull_request;
  const head = isRecord(pullRequest.head) ? pullRequest.head : undefined;
  const base = isRecord(pullRequest.base) ? pullRequest.base : undefined;
  const [owner, name] = repository.split("/");
  if (!owner || !name) throw new Error("GITHUB_REPOSITORY is invalid.");
  return {
    repository,
    owner,
    name,
    number: numberAt(parsed.number ?? pullRequest.number, "number"),
    headSha: stringAt(head?.sha, "pull_request.head.sha"),
    baseSha: stringAt(base?.sha, "pull_request.base.sha"),
    title: stringAt(pullRequest.title, "pull_request.title"),
    htmlUrl: stringAt(pullRequest.html_url, "pull_request.html_url"),
  };
}
