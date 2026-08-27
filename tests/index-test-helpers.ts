import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

import { indexInternals, main, runAction } from "../src/index.js";
import { buildRunSummary, reviewMarker } from "../src/lib/aggregate.js";
import { CancellationError } from "../src/lib/bootstrap/cancellation.js";
import { GitHubApi, GitHubApiError } from "../src/lib/github-api.js";
import { readReviewConfig, type InputReader } from "../src/lib/input.js";
import type {
  GoalResult,
  PullRequestContext,
  PullRequestReviewRequest,
  ReviewBriefing,
  ReviewConfig,
} from "../src/lib/types.js";

export {
  CancellationError,
  GitHubApi,
  GitHubApiError,
  access,
  assert,
  buildRunSummary,
  createServer,
  indexInternals,
  join,
  main,
  mkdir,
  mkdtemp,
  readFile,
  readReviewConfig,
  reviewMarker,
  rm,
  runAction,
  test,
  tmpdir,
  writeFile,
};
export type {
  GoalResult,
  InputReader,
  PullRequestContext,
  PullRequestReviewRequest,
  ReviewBriefing,
  ReviewConfig,
  TestContext,
};

export const execFileAsync = promisify(execFile);

export function actionReader(overrides: Readonly<Record<string, string>> = {}): InputReader {
  const values: Readonly<Record<string, string>> = {
    "github-pat": "test-token",
    "ai-base-url": "https://ai.example.test",
    "ai-secret": "test-ai-secret",
    model: "review-model",
    "review-prompts": JSON.stringify([{ prompt: "correctness" }]),
    ...overrides,
  };
  return { get: (name) => values[name] ?? "" };
}

export async function cleanWorkspace(t: TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-index-clean-"));
  t.after(() => rm(workspace, { force: true, recursive: true }));
  await execFileAsync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: workspace });
  await writeFile(join(workspace, "review.txt"), "head\n");
  await execFileAsync("git", ["add", "review.txt"], { cwd: workspace });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Test User",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "--message=head",
    ],
    { cwd: workspace },
  );
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: workspace,
    encoding: "utf8",
  });
  const headSha = stdout.trim();
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 9,
    headSha,
    baseSha: headSha,
    baseRef: "main",
    title: "Action flow",
    htmlUrl: "https://github.com/owner/repository/pull/9",
  };
  return { context, workspace };
}

export function useWorkspace(t: TestContext, path: string): void {
  const previous = process.env.GITHUB_WORKSPACE;
  process.env.GITHUB_WORKSPACE = path;
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previous;
  });
}

export const config: ReviewConfig = {
  githubToken: "github-secret",
  aiBaseUrl:
    "https://ai.example.test/signed?api-version=2023-06-01&token=ai-url%2Fsecret&subscription-key=subscription-secret&apiKey=camel-api-secret&accessToken=camel-access-secret",
  aiSecret: "ai-secret",
  model: "review-model",
  reviewPrompts: [{ prompt: "security", files: [] }],
  parallelCount: 1,
  maxTurns: 2,
  autoApprove: false,
  interactWithPullRequest: true,
  mcpServers: {
    security: {
      type: "http",
      url: "https://mcp.example.test/review?tenant=public-tenant&monkey=public-monkey&signature=mcp-url%2Fsecret&key=bare-key-secret&clientSecret=camel-client-secret",
      headers: {
        Authorization: "Bearer mcp-header-secret",
        "Proxy-Authorization": "Basic proxy-credentials",
        "X-Label": "public value",
      },
    },
  },
};

export function emptyConversationApi(login = "review-owner") {
  return {
    getAuthenticatedUserLogin: () => Promise.resolve(login),
    listReviews: () => Promise.resolve([]),
    listReviewComments: () => Promise.resolve([]),
    listIssueComments: () => Promise.resolve([]),
  };
}
