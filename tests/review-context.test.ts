import { strict as assert } from "node:assert";
import test from "node:test";

import type {
  ExistingReview,
  GitHubCommentAuthor,
  PullRequestIssueCommentRecord,
  PullRequestReviewCommentRecord,
} from "../src/lib/github-api.js";
import {
  buildReviewConversation,
  mapConversationBodies,
  reviewContextInternals,
  type ReviewConversationEntry,
} from "../src/lib/review-context.js";
import {
  actionReader,
  cleanWorkspace,
  emptyConversationApi,
  readReviewConfig,
  reviewMarker,
  runAction,
  useWorkspace,
} from "./index-test-helpers.js";
import type { GitHubApi } from "../src/lib/github-api.js";
import type {
  ReviewLifecycleReviewRecord,
  ReviewLifecycleSnapshot,
  ReviewLifecycleThreadRecord,
} from "../src/lib/github-review-lifecycle.js";
import { fixedCommentBody } from "../src/lib/review-lifecycle.js";

const timestamp = "2026-08-17T00:00:00Z";

function author(login: string, type = "User"): GitHubCommentAuthor {
  return { login, type };
}

function review(
  id: number,
  authorLogin: string | undefined,
  body: string,
  submittedAt: string | undefined = timestamp,
): ExistingReview {
  return {
    id,
    ...(authorLogin === undefined ? {} : { author: author(authorLogin) }),
    body,
    commitId: `commit-${id}`,
    state: "COMMENTED",
    ...(submittedAt === undefined ? {} : { submittedAt }),
  };
}

function reviewComment(
  id: number,
  reviewId: number | undefined,
  authorLogin: string | undefined,
  body: string,
  overrides: Partial<PullRequestReviewCommentRecord> = {},
  includeLocation = true,
): PullRequestReviewCommentRecord {
  return {
    id,
    ...(reviewId === undefined ? {} : { reviewId }),
    ...(authorLogin === undefined ? {} : { author: author(authorLogin) }),
    body,
    commitId: `commit-${id}`,
    originalCommitId: `original-${id}`,
    path: "src/change.ts",
    ...(includeLocation ? { line: id, originalLine: id - 1 } : {}),
    createdAt: `2026-08-17T00:00:${String(id).padStart(2, "0")}Z`,
    updatedAt: `2026-08-17T00:01:${String(id).padStart(2, "0")}Z`,
    ...overrides,
  };
}

function issueComment(
  id: number,
  authorLogin: string | undefined,
  body: string,
  overrides: Partial<PullRequestIssueCommentRecord> = {},
): PullRequestIssueCommentRecord {
  return {
    id,
    ...(authorLogin === undefined ? {} : { author: author(authorLogin) }),
    body,
    createdAt: `2026-08-17T00:02:${String(id).padStart(2, "0")}Z`,
    updatedAt: `2026-08-17T00:03:${String(id).padStart(2, "0")}Z`,
    performedViaGitHubApp: false,
    ...overrides,
  };
}

function buildConversation(
  authenticatedLogin: string,
  reviews: readonly ExistingReview[],
  comments: readonly PullRequestReviewCommentRecord[],
  issueComments: readonly PullRequestIssueCommentRecord[],
) {
  const lifecycleReviews: ReviewLifecycleReviewRecord[] = reviews.map((item) => ({
    nodeId: `review-node-${item.id}`,
    databaseId: item.id,
    ...(item.author === undefined ? {} : { author: item.author }),
    body: item.body,
    commitId: item.commitId,
    state: item.state,
    ...(item.submittedAt === undefined ? {} : { submittedAt: item.submittedAt }),
    isMinimized: false,
  }));
  const grouped = new Map<number, PullRequestReviewCommentRecord[]>();
  for (const comment of comments) {
    const rootId = comment.inReplyToId ?? comment.id;
    const thread = grouped.get(rootId) ?? [];
    thread.push(comment);
    grouped.set(rootId, thread);
  }
  const threads: ReviewLifecycleThreadRecord[] = [...grouped].map(([rootId, threadComments]) => {
    const root = threadComments.find((comment) => comment.id === rootId);
    const location = root ?? threadComments[0];
    assert.ok(location);
    return {
      nodeId: `thread-node-${rootId}`,
      isResolved: false,
      isOutdated: false,
      path: location.path,
      ...(location.line === undefined ? {} : { line: location.line }),
      ...(location.originalLine === undefined ? {} : { originalLine: location.originalLine }),
      ...(root?.reviewId === undefined ? {} : { reviewId: root.reviewId }),
      ...(root?.reviewId === undefined ? {} : { reviewNodeId: `review-node-${root.reviewId}` }),
      comments: threadComments.map((comment) => ({
        nodeId: `comment-node-${comment.id}`,
        databaseId: comment.id,
        ...(comment.reviewId === undefined ? {} : { reviewId: comment.reviewId }),
        ...(comment.reviewId === undefined
          ? {}
          : { reviewNodeId: `review-node-${comment.reviewId}` }),
        ...(comment.inReplyToId === undefined ? {} : { replyToId: comment.inReplyToId }),
        ...(comment.author === undefined ? {} : { author: comment.author }),
        body: comment.body,
        commitId: comment.commitId,
        originalCommitId: comment.originalCommitId,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      })),
    };
  });
  return buildReviewConversation(
    authenticatedLogin,
    { reviews: lifecycleReviews, threads },
    issueComments,
  );
}

test("reconciles prepared lifecycle candidates before skipping an identical review", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const reader = actionReader();
  const oldSha = "a".repeat(40);
  const oldReview = {
    id: 10,
    author: { login: "review-action", type: "User" },
    body: `<!-- ai-pr-reviewer:v3:${oldSha}:${"d".repeat(64)} -->\n## 🔎 AI review`,
    commitId: oldSha,
    state: "COMMENTED",
    submittedAt: "2026-08-31T00:00:00Z",
  };
  const duplicateReview = {
    id: 11,
    author: { login: "review-action", type: "User" },
    body: reviewMarker(context, readReviewConfig(reader)),
    commitId: context.headSha,
    state: "COMMENTED",
    submittedAt: "2026-08-31T00:01:00Z",
  };
  const oldLifecycleReview: ReviewLifecycleReviewRecord = {
    nodeId: "old-review-node",
    databaseId: oldReview.id,
    author: oldReview.author,
    body: oldReview.body,
    commitId: oldReview.commitId,
    state: oldReview.state,
    submittedAt: oldReview.submittedAt,
    isMinimized: false,
  };
  const duplicateLifecycleReview: ReviewLifecycleReviewRecord = {
    nodeId: "duplicate-review-node",
    databaseId: duplicateReview.id,
    author: duplicateReview.author,
    body: duplicateReview.body,
    commitId: duplicateReview.commitId,
    state: duplicateReview.state,
    submittedAt: duplicateReview.submittedAt,
    isMinimized: false,
  };
  const rootComment = {
    nodeId: "old-finding-node",
    databaseId: 100,
    reviewId: oldReview.id,
    reviewNodeId: oldLifecycleReview.nodeId,
    author: oldReview.author,
    body: "Old finding",
    commitId: oldSha,
    createdAt: "2026-08-31T00:00:00Z",
    updatedAt: "2026-08-31T00:00:00Z",
  };
  const oldThread: ReviewLifecycleThreadRecord = {
    nodeId: "old-thread-node",
    isResolved: false,
    isOutdated: true,
    path: "review.txt",
    line: 1,
    originalLine: 1,
    reviewId: oldReview.id,
    reviewNodeId: oldLifecycleReview.nodeId,
    comments: [rootComment],
  };
  let snapshot: ReviewLifecycleSnapshot = {
    reviews: [oldLifecycleReview, duplicateLifecycleReview],
    threads: [oldThread],
  };
  const calls: string[] = [];
  let verifierRuns = 0;
  let goalRuns = 0;
  let postedReviews = 0;
  const api = {
    ...emptyConversationApi("review-action"),
    listReviews: () => Promise.resolve([oldReview, duplicateReview]),
    listReviewComments: () => Promise.resolve([]),
    getReviewLifecycleSnapshot: () => Promise.resolve(snapshot),
    getPullRequestHeadSha: () => Promise.resolve(context.headSha),
    updateSubmittedReview: () => Promise.resolve(),
    dismissSubmittedReview: () => Promise.resolve(),
    updateReviewComment: (_context: unknown, commentId: number, body: string) => {
      calls.push(`comment:${commentId}`);
      snapshot = {
        ...snapshot,
        threads: snapshot.threads.map((item) =>
          item.comments.some((comment) => comment.databaseId === commentId)
            ? {
                ...item,
                comments: item.comments.map((comment) =>
                  comment.databaseId === commentId
                    ? { ...comment, body, updatedAt: "2026-08-31T00:02:00Z" }
                    : comment,
                ),
              }
            : item,
        ),
      };
      return Promise.resolve();
    },
    resolveReviewThread: (nodeId: string) => {
      calls.push(`resolve:${nodeId}`);
      snapshot = {
        ...snapshot,
        threads: snapshot.threads.map((item) =>
          item.nodeId === nodeId ? { ...item, isResolved: true } : item,
        ),
      };
      return Promise.resolve();
    },
    minimizeComment: () => Promise.resolve(),
    createReview: () => {
      postedReviews += 1;
      return Promise.resolve();
    },
  } as unknown as GitHubApi;
  const result = await runAction(reader, [], {
    createApi: () => api,
    readEventContext: () => Promise.resolve(context),
    createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
    readFiles: () => {
      throw new Error("duplicate review should skip before reading files");
    },
    runResolutionVerifiers: () => {
      verifierRuns += 1;
      return Promise.resolve([
        { status: "completed", verdict: "fixed", confidence: "high", rationale: "gone" },
      ]);
    },
    runGoals: () => {
      goalRuns += 1;
      return Promise.resolve([]);
    },
    writeSummary: () => Promise.resolve(),
  });
  assert.deepEqual(result, { skipped: true });
  assert.equal(verifierRuns, 1);
  assert.equal(goalRuns, 0);
  assert.equal(postedReviews, 0);
  assert.deepEqual(calls, ["comment:100", "resolve:old-thread-node"]);
});

test("finalizes resolved lifecycle reviews before skipping an identical review", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const reader = actionReader();
  const oldSha = "a".repeat(40);
  const oldReview = {
    id: 30,
    author: { login: "review-action", type: "User" },
    body: `<!-- ai-pr-reviewer:v3:${oldSha}:${"d".repeat(64)} -->\n## 🔎 AI review`,
    commitId: oldSha,
    state: "COMMENTED",
    submittedAt: "2026-08-31T00:00:00Z",
  };
  const duplicateReview = {
    id: 31,
    author: { login: "review-action", type: "User" },
    body: reviewMarker(context, readReviewConfig(reader)),
    commitId: context.headSha,
    state: "COMMENTED",
    submittedAt: "2026-08-31T00:01:00Z",
  };
  const oldLifecycleReview: ReviewLifecycleReviewRecord = {
    nodeId: "old-review-node-finalize",
    databaseId: oldReview.id,
    author: oldReview.author,
    body: oldReview.body,
    commitId: oldReview.commitId,
    state: oldReview.state,
    submittedAt: oldReview.submittedAt,
    isMinimized: false,
  };
  const duplicateLifecycleReview: ReviewLifecycleReviewRecord = {
    nodeId: "duplicate-review-node-finalize",
    databaseId: duplicateReview.id,
    author: duplicateReview.author,
    body: duplicateReview.body,
    commitId: duplicateReview.commitId,
    state: duplicateReview.state,
    submittedAt: duplicateReview.submittedAt,
    isMinimized: false,
  };
  const resolvedThread: ReviewLifecycleThreadRecord = {
    nodeId: "resolved-thread-finalize",
    isResolved: true,
    isOutdated: true,
    path: "review.txt",
    line: 1,
    originalLine: 1,
    reviewId: oldReview.id,
    reviewNodeId: oldLifecycleReview.nodeId,
    comments: [
      {
        nodeId: "resolved-comment-finalize",
        databaseId: 300,
        reviewId: oldReview.id,
        reviewNodeId: oldLifecycleReview.nodeId,
        author: oldReview.author,
        body: "Old finding",
        commitId: oldSha,
        createdAt: "2026-08-31T00:00:00Z",
        updatedAt: "2026-08-31T00:00:00Z",
      },
    ],
  };
  const snapshot: ReviewLifecycleSnapshot = {
    reviews: [oldLifecycleReview, duplicateLifecycleReview],
    threads: [resolvedThread],
  };
  const calls: string[] = [];
  let goalRuns = 0;
  let postedReviews = 0;
  const api = {
    ...emptyConversationApi("review-action"),
    listReviews: () => Promise.resolve([oldReview, duplicateReview]),
    listReviewComments: () => Promise.resolve([]),
    getReviewLifecycleSnapshot: () => Promise.resolve(snapshot),
    getPullRequestHeadSha: () => Promise.resolve(context.headSha),
    updateSubmittedReview: () => Promise.resolve(),
    dismissSubmittedReview: () => Promise.resolve(),
    updateReviewComment: () => Promise.resolve(),
    resolveReviewThread: () => Promise.resolve(),
    minimizeComment: (nodeId: string) => {
      calls.push(`minimize:${nodeId}`);
      return Promise.resolve();
    },
    createReview: () => {
      postedReviews += 1;
      return Promise.resolve();
    },
  } as unknown as GitHubApi;
  const result = await runAction(reader, [], {
    createApi: () => api,
    readEventContext: () => Promise.resolve(context),
    createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
    readFiles: () => {
      throw new Error("duplicate review should skip before reading files");
    },
    runGoals: () => {
      goalRuns += 1;
      return Promise.resolve([]);
    },
    writeSummary: () => Promise.resolve(),
  });
  assert.deepEqual(result, { skipped: true });
  assert.equal(goalRuns, 0);
  assert.equal(postedReviews, 0);
  assert.deepEqual(calls, ["minimize:old-review-node-finalize"]);
});

test("refreshes the conversation digest after lifecycle comment edits before duplicate detection", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const reader = actionReader();
  const oldSha = "a".repeat(40);
  const oldReview = {
    id: 20,
    author: { login: "review-action", type: "User" },
    body: `<!-- ai-pr-reviewer:v3:${oldSha}:${"d".repeat(64)} -->\n## 🔎 AI review`,
    commitId: oldSha,
    state: "COMMENTED",
    submittedAt: "2026-08-31T00:00:00Z",
  };
  const duplicateReviewBase = {
    id: 21,
    author: { login: "review-action", type: "User" },
    body: "placeholder",
    commitId: context.headSha,
    state: "COMMENTED",
    submittedAt: "2026-08-31T00:01:00Z",
  };
  const rootConversationComment = {
    id: 200,
    reviewId: oldReview.id,
    author: oldReview.author,
    body: "Old finding",
    commitId: oldSha,
    originalCommitId: oldSha,
    path: "review.txt",
    line: 1,
    originalLine: 1,
    createdAt: "2026-08-31T00:00:00Z",
    updatedAt: "2026-08-31T00:00:00Z",
  };
  const humanConversationReply = {
    ...rootConversationComment,
    id: 201,
    inReplyToId: rootConversationComment.id,
    author: { login: "reviewer", type: "User" },
    body: "Please fix this finding.",
    createdAt: "2026-08-31T00:00:01Z",
    updatedAt: "2026-08-31T00:00:01Z",
  };
  const fixedConversationRoot = {
    ...rootConversationComment,
    body: fixedCommentBody(rootConversationComment.body, context.headSha),
    updatedAt: "2026-08-31T00:00:02Z",
  };
  const conversationBefore = [rootConversationComment, humanConversationReply];
  const conversationAfter = [fixedConversationRoot, humanConversationReply];
  const duplicateReview = {
    ...duplicateReviewBase,
    body: reviewMarker(
      context,
      readReviewConfig(reader),
      buildConversation("review-action", [oldReview, duplicateReviewBase], conversationAfter, [])
        .digest,
      [[]],
    ),
  };
  const oldLifecycleReview: ReviewLifecycleReviewRecord = {
    nodeId: "old-review-node-digest",
    databaseId: oldReview.id,
    author: oldReview.author,
    body: oldReview.body,
    commitId: oldReview.commitId,
    state: oldReview.state,
    submittedAt: oldReview.submittedAt,
    isMinimized: false,
  };
  const duplicateLifecycleReview: ReviewLifecycleReviewRecord = {
    nodeId: "duplicate-review-node-digest",
    databaseId: duplicateReview.id,
    author: duplicateReview.author,
    body: duplicateReview.body,
    commitId: duplicateReview.commitId,
    state: duplicateReview.state,
    submittedAt: duplicateReview.submittedAt,
    isMinimized: false,
  };
  const rootLifecycleComment = {
    nodeId: "old-finding-node-digest",
    databaseId: rootConversationComment.id,
    reviewId: oldReview.id,
    reviewNodeId: oldLifecycleReview.nodeId,
    author: oldReview.author,
    body: rootConversationComment.body,
    commitId: oldSha,
    originalCommitId: oldSha,
    createdAt: rootConversationComment.createdAt,
    updatedAt: rootConversationComment.updatedAt,
  };
  const humanLifecycleReply = {
    ...rootLifecycleComment,
    nodeId: "human-reply-node-digest",
    databaseId: humanConversationReply.id,
    replyToId: rootLifecycleComment.databaseId,
    author: humanConversationReply.author,
    body: humanConversationReply.body,
    createdAt: humanConversationReply.createdAt,
    updatedAt: humanConversationReply.updatedAt,
  };
  const fixedLifecycleRoot = {
    ...rootLifecycleComment,
    body: fixedConversationRoot.body,
    updatedAt: fixedConversationRoot.updatedAt,
  };
  const initialThread: ReviewLifecycleThreadRecord = {
    nodeId: "old-thread-node-digest",
    isResolved: false,
    isOutdated: true,
    path: "review.txt",
    line: 1,
    originalLine: 1,
    reviewId: oldReview.id,
    reviewNodeId: oldLifecycleReview.nodeId,
    comments: [rootLifecycleComment, humanLifecycleReply],
  };
  let snapshot: ReviewLifecycleSnapshot = {
    reviews: [oldLifecycleReview, duplicateLifecycleReview],
    threads: [initialThread],
  };
  let goalRuns = 0;
  const calls: string[] = [];
  const api = {
    ...emptyConversationApi("review-action"),
    listReviews: () => Promise.resolve([oldReview, duplicateReview]),
    listReviewComments: () => Promise.resolve(conversationBefore),
    getReviewLifecycleSnapshot: () => Promise.resolve(snapshot),
    getPullRequestHeadSha: () => Promise.resolve(context.headSha),
    updateSubmittedReview: () => Promise.resolve(),
    dismissSubmittedReview: () => Promise.resolve(),
    updateReviewComment: (_context: unknown, commentId: number) => {
      calls.push(`comment:${commentId}`);
      snapshot = {
        ...snapshot,
        threads: snapshot.threads.map((item) =>
          item.comments.some((comment) => comment.databaseId === commentId)
            ? { ...item, comments: [fixedLifecycleRoot, humanLifecycleReply] }
            : item,
        ),
      };
      return Promise.resolve();
    },
    resolveReviewThread: (nodeId: string) => {
      calls.push(`resolve:${nodeId}`);
      snapshot = {
        ...snapshot,
        threads: snapshot.threads.map((item) =>
          item.nodeId === nodeId ? { ...item, isResolved: true } : item,
        ),
      };
      return Promise.resolve();
    },
    minimizeComment: () => Promise.resolve(),
    createReview: () => Promise.resolve(),
  } as unknown as GitHubApi;
  const result = await runAction(reader, [], {
    createApi: () => api,
    readEventContext: () => Promise.resolve(context),
    createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
    readFiles: () => {
      throw new Error("duplicate review should skip before reading files");
    },
    runResolutionVerifiers: () =>
      Promise.resolve([
        { status: "completed", verdict: "fixed", confidence: "high", rationale: "gone" },
      ]),
    runGoals: () => {
      goalRuns += 1;
      return Promise.resolve([]);
    },
    writeSummary: () => Promise.resolve(),
  });
  assert.deepEqual(result, { skipped: true });
  assert.equal(goalRuns, 0);
  assert.deepEqual(calls, ["comment:200", "resolve:old-thread-node-digest"]);
});

test("classifies people, bots, apps, and action-authored content", () => {
  const { ACTION_MARKER, authorRole } = reviewContextInternals;

  assert.equal(authorRole(author("review-action"), "REVIEW-ACTION"), "workflow");
  assert.equal(authorRole(author("other-user"), "review-action", false, true), "workflow");
  assert.equal(authorRole(undefined, "review-action"), "unknown");
  assert.equal(authorRole(author("app-user"), "review-action", true), "bot");
  assert.equal(authorRole(author("service", "Bot"), "review-action"), "bot");
  assert.equal(authorRole(author("service[bot]"), "review-action"), "bot");
  assert.equal(authorRole(author("pr-owner"), "review-action"), "human");
  assert.equal(ACTION_MARKER.test("<!-- ai-pr-reviewer:v3:head:digest -->"), true);
  assert.equal(ACTION_MARKER.test("owner explanation"), false);
});

test("includes all reviewer comments and complete non-action inline threads", () => {
  const actionBody = "<!-- ai-pr-reviewer:v3:head:digest -->\nAutomated review";
  const reviews = [
    review(1, "review-action", actionBody, "2026-08-17T00:00:01Z"),
    review(2, "reviewer", "Review overview", "2026-08-17T00:00:02Z"),
    review(3, "reviewer", "No submitted timestamp", undefined),
    { ...review(4, "review-bot", "Bot overview"), author: author("review-bot", "Bot") },
    review(5, "reviewer", "   "),
    review(6, undefined, "Unknown author"),
  ];
  const comments = [
    reviewComment(10, 1, "review-action", "Automated finding"),
    reviewComment(13, 1, "review-action", "Workflow follow-up", { inReplyToId: 10 }),
    {
      ...reviewComment(12, 1, "review-bot", "Bot follow-up", { inReplyToId: 10 }),
      author: author("review-bot", "Bot"),
    },
    reviewComment(11, 1, "pr-owner", "The code now validates this.", { inReplyToId: 10 }),
    reviewComment(20, 2, "reviewer", "Finding without owner context"),
    {
      ...reviewComment(21, 2, "review-bot", "Bot-only reply", { inReplyToId: 20 }),
      author: author("review-bot", "Bot"),
    },
    reviewComment(30, 2, "reviewer", "Finding with self reply"),
    reviewComment(31, 2, "review-action", "Action reply", { inReplyToId: 30 }),
  ];
  const issueComments = [
    issueComment(40, "pr-owner", "PR-level explanation"),
    issueComment(41, "review-action", "Action summary"),
    { ...issueComment(42, "review-bot", "Bot summary"), author: author("review-bot", "Bot") },
    issueComment(43, "app-user", "App summary", { performedViaGitHubApp: true }),
    issueComment(44, undefined, "Unknown summary"),
    issueComment(45, "pr-owner", "   "),
  ];

  const snapshot = buildConversation("review-action", reviews, comments, issueComments);

  assert.equal(snapshot.digest.length, 64);
  assert.deepEqual(
    snapshot.entries.map((entry) => [entry.kind, entry.id]),
    [
      ["review_body", 3],
      ["review_body", 4],
      ["review_body", 6],
      ["review_body", 2],
      ["inline_thread", 10],
      ["inline_thread", 20],
      ["inline_thread", 30],
      ["pr_comment", 40],
      ["pr_comment", 42],
      ["pr_comment", 43],
      ["pr_comment", 44],
    ],
  );
  const thread = snapshot.entries.find(
    (entry) => entry.kind === "inline_thread" && entry.id === 20,
  );
  assert.equal(thread?.kind, "inline_thread");
  if (thread?.kind !== "inline_thread") assert.fail("Expected an inline thread.");
  assert.equal(thread.rootAvailable, true);
  assert.equal(thread.path, "src/change.ts");
  assert.equal(thread.line, 20);
  assert.equal(thread.originalLine, 19);
  assert.deepEqual(
    thread.messages.map((message) => [message.id, message.authorRole, message.body]),
    [
      [20, "human", "Finding without owner context"],
      [21, "bot", "Bot-only reply"],
    ],
  );
  const actionThread = snapshot.entries.find(
    (entry) => entry.kind === "inline_thread" && entry.id === 10,
  );
  assert.equal(actionThread?.kind, "inline_thread");
  if (actionThread?.kind !== "inline_thread") assert.fail("Expected the action thread.");
  assert.equal(actionThread.rootAvailable, true);
  assert.deepEqual(
    actionThread.messages.map((message) => [message.id, message.authorRole]),
    [
      [10, "workflow"],
      [11, "human"],
      [12, "bot"],
      [13, "workflow"],
    ],
  );
});

test("keeps orphaned human reply threads and produces a canonical digest", () => {
  const orphan = reviewComment(
    51,
    undefined,
    "pr-owner",
    "Context for an unavailable root",
    {
      inReplyToId: 50,
    },
    false,
  );
  const root = reviewComment(60, 9, "reviewer", "Root finding", {
    createdAt: "2026-08-17T00:04:00Z",
  });
  const reply = reviewComment(61, 9, "pr-owner", "Owner reply", {
    inReplyToId: 60,
    createdAt: "2026-08-17T00:04:01Z",
  });
  const reviews = [
    { ...review(9, "reviewer", "Human review", "2026-08-17T00:03:00Z"), commitId: null },
  ];
  const issues = [issueComment(70, "pr-owner", "Human comment")];

  const forward = buildConversation("review-action", reviews, [orphan, root, reply], issues);
  const reversed = buildConversation(
    "review-action",
    [...reviews].reverse(),
    [reply, root, orphan],
    [...issues].reverse(),
  );
  assert.deepEqual(forward, reversed);
  const orphanEntry = forward.entries.find(
    (entry): entry is Extract<ReviewConversationEntry, { kind: "inline_thread" }> =>
      entry.kind === "inline_thread" && entry.id === 50,
  );
  assert.ok(orphanEntry);
  assert.equal(orphanEntry.rootAvailable, false);
  assert.equal(orphanEntry.line, undefined);
  assert.equal(orphanEntry.originalLine, undefined);
  assert.equal(orphanEntry.messages[0]?.inReplyToId, 50);

  const changed = buildConversation(
    "review-action",
    reviews,
    [{ ...orphan, body: "Changed owner context" }, root, reply],
    issues,
  );
  assert.notEqual(changed.digest, forward.digest);
});

test("keeps action-only thread lifecycle metadata in future review context", () => {
  const headSha = "a".repeat(40);
  const actionReview: ReviewLifecycleReviewRecord = {
    nodeId: "review-node-action",
    databaseId: 90,
    author: author("review-action"),
    body: `<!-- ai-pr-reviewer:v3:${headSha}:${"b".repeat(64)} -->\n## 🔎 AI review`,
    commitId: headSha,
    state: "COMMENTED",
    submittedAt: timestamp,
    isMinimized: true,
    minimizedReason: "RESOLVED",
  };
  const actionThread: ReviewLifecycleThreadRecord = {
    nodeId: "thread-node-action",
    isResolved: true,
    isOutdated: true,
    resolvedBy: author("pr-owner"),
    path: "src/change.ts",
    line: 20,
    originalLine: 10,
    reviewId: actionReview.databaseId,
    reviewNodeId: actionReview.nodeId,
    comments: [
      {
        nodeId: "comment-node-action",
        databaseId: 91,
        reviewId: actionReview.databaseId,
        reviewNodeId: actionReview.nodeId,
        author: author("review-action"),
        body: "Prior automated finding",
        commitId: headSha,
        originalCommitId: "c".repeat(40),
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };

  const snapshot = buildReviewConversation(
    "review-action",
    { reviews: [actionReview], threads: [actionThread] },
    [],
  );
  assert.equal(snapshot.entries.length, 1);
  const entry = snapshot.entries[0];
  assert.equal(entry?.kind, "inline_thread");
  if (entry?.kind !== "inline_thread") assert.fail("Expected an inline thread.");
  assert.equal(entry.isResolved, true);
  assert.equal(entry.isOutdated, true);
  assert.equal(entry.resolvedByLogin, "pr-owner");
  assert.equal(entry.reviewIsMinimized, true);
  assert.equal(entry.reviewMinimizedReason, "RESOLVED");
  assert.equal(entry.messages[0]?.originalCommitId, "c".repeat(40));
});

test("keeps duplicate identity stable for workflow-only lifecycle changes", () => {
  const headSha = "a".repeat(40);
  const actionReview: ReviewLifecycleReviewRecord = {
    nodeId: "review-node-action",
    databaseId: 100,
    author: author("review-action"),
    body: `<!-- ai-pr-reviewer:v3:${headSha}:${"d".repeat(64)} -->\n## 🔎 AI review`,
    commitId: headSha,
    state: "COMMENTED",
    submittedAt: timestamp,
    isMinimized: false,
  };
  const root = {
    nodeId: "comment-node-action",
    databaseId: 101,
    reviewId: actionReview.databaseId,
    reviewNodeId: actionReview.nodeId,
    author: author("review-action"),
    body: "Automated finding",
    commitId: headSha,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const actionThread: ReviewLifecycleThreadRecord = {
    nodeId: "thread-node-action",
    isResolved: false,
    isOutdated: false,
    path: "src/change.ts",
    line: 20,
    originalLine: 10,
    reviewId: actionReview.databaseId,
    reviewNodeId: actionReview.nodeId,
    comments: [root],
  };
  const original = buildReviewConversation(
    "review-action",
    { reviews: [actionReview], threads: [actionThread] },
    [],
  );
  const workflowUpdated = buildReviewConversation(
    "review-action",
    {
      reviews: [{ ...actionReview, isMinimized: true, minimizedReason: "RESOLVED" }],
      threads: [
        {
          ...actionThread,
          isResolved: true,
          resolvedBy: author("review-action"),
          comments: [{ ...root, body: "Workflow-updated finding", updatedAt: "later" }],
        },
      ],
    },
    [],
  );
  assert.equal(workflowUpdated.digest, original.digest);

  const externallyResolved = buildReviewConversation(
    "review-action",
    {
      reviews: [actionReview],
      threads: [{ ...actionThread, isResolved: true, resolvedBy: author("pr-owner") }],
    },
    [],
  );
  assert.notEqual(externallyResolved.digest, original.digest);

  const humanReply = {
    ...root,
    nodeId: "comment-node-human",
    databaseId: 102,
    replyToId: root.databaseId,
    author: author("pr-owner"),
    body: "This is a false positive.",
  };
  const externallyDiscussed = buildReviewConversation(
    "review-action",
    {
      reviews: [actionReview],
      threads: [{ ...actionThread, comments: [root, humanReply] }],
    },
    [],
  );
  assert.notEqual(externallyDiscussed.digest, original.digest);
});

test("does not let another reviewer spoof the action marker", () => {
  const marker = "<!-- ai-pr-reviewer:v3:head:digest -->";
  const snapshot = buildConversation(
    "review-action",
    [review(80, "other-reviewer", marker)],
    [reviewComment(81, 80, "other-reviewer", "Independent finding")],
    [],
  );
  assert.ok(snapshot.entries.some((entry) => entry.kind === "review_body" && entry.id === 80));
  assert.ok(snapshot.entries.some((entry) => entry.kind === "inline_thread" && entry.id === 81));
});

test("maps every exposed body without changing snapshot identity metadata", () => {
  const snapshot = buildConversation(
    "review-action",
    [review(1, "reviewer", "review secret")],
    [
      reviewComment(10, 1, "reviewer", "root secret"),
      reviewComment(11, 1, "pr-owner", "reply secret", { inReplyToId: 10 }),
    ],
    [issueComment(20, "pr-owner", "comment secret")],
  );

  const mapped = mapConversationBodies(snapshot, (body) => body.replaceAll("secret", "[redacted]"));

  assert.equal(mapped.digest, snapshot.digest);
  assert.notEqual(mapped.entries, snapshot.entries);
  assert.deepEqual(
    mapped.entries.flatMap((entry) =>
      entry.kind === "inline_thread"
        ? entry.messages.map((message) => message.body)
        : [entry.message.body],
    ),
    ["review [redacted]", "root [redacted]", "reply [redacted]", "comment [redacted]"],
  );
  assert.deepEqual(
    snapshot.entries.flatMap((entry) =>
      entry.kind === "inline_thread"
        ? entry.messages.map((message) => message.body)
        : [entry.message.body],
    ),
    ["review secret", "root secret", "reply secret", "comment secret"],
  );
});

test("sorts messages and entries by their canonical tie breakers", () => {
  const root = {
    id: 2,
    authorRole: "human" as const,
    body: "root",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const reply = { ...root, id: 1, inReplyToId: 2, body: "reply" };
  assert.ok(reviewContextInternals.messageSort(root, reply) < 0);
  assert.ok(reviewContextInternals.messageSort({ ...root, id: 3 }, root) > 0);
  assert.ok(
    reviewContextInternals.messageSort(
      { ...reply, id: 3, createdAt: "2026-08-17T00:00:01Z" },
      reply,
    ) > 0,
  );

  const comment: ReviewConversationEntry = {
    kind: "pr_comment",
    id: 2,
    createdAt: timestamp,
    message: root,
  };
  const reviewBody: ReviewConversationEntry = {
    kind: "review_body",
    id: 2,
    createdAt: timestamp,
    state: "COMMENTED",
    commitId: "commit",
    isMinimized: false,
    message: root,
  };
  assert.ok(
    reviewContextInternals.entrySort({ ...comment, createdAt: "2026-08-17T00:00:01Z" }, comment) >
      0,
  );
  assert.ok(reviewContextInternals.entrySort({ ...comment, id: 3 }, comment) > 0);
  assert.ok(reviewContextInternals.entrySort(reviewBody, comment) > 0);
  assert.equal(reviewContextInternals.conversationDigest([]).length, 64);
});
