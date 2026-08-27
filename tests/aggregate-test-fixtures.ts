import type { ChangedFile, PullRequestContext, ReviewConfig } from "../src/lib/types.js";

export const context: PullRequestContext = {
  repository: "owner/repository",
  owner: "owner",
  name: "repository",
  number: 42,
  headSha: "0123456789abcdef0123456789abcdef01234567",
  baseSha: "fedcba9876543210fedcba9876543210fedcba98",
  baseRef: "main",
  title: "Change",
  htmlUrl: "https://github.com/owner/repository/pull/42",
};

export const config: ReviewConfig = {
  githubToken: "github-secret",
  aiBaseUrl: "https://ai.example.test",
  aiSecret: "ai-secret",
  model: "review-model",
  reviewPrompts: [
    { prompt: "correctness", files: [] },
    { prompt: "security", files: [] },
  ],
  parallelCount: 2,
  maxTurns: 50,
  autoApprove: true,
  interactWithPullRequest: true,
  mcpServers: {},
};

export const files: readonly ChangedFile[] = [
  {
    path: "src/change.ts",
    status: "modified",
    additions: 2,
    deletions: 0,
    changes: 2,
    patch: "@@ -1,0 +1,2 @@\n+one\n+two",
    addedLines: new Set([1, 2]),
  },
];
