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

  const snapshot = buildReviewConversation("review-action", reviews, comments, issueComments);

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

  const forward = buildReviewConversation("review-action", reviews, [orphan, root, reply], issues);
  const reversed = buildReviewConversation(
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

  const changed = buildReviewConversation(
    "review-action",
    reviews,
    [{ ...orphan, body: "Changed owner context" }, root, reply],
    issues,
  );
  assert.notEqual(changed.digest, forward.digest);
});

test("does not let another reviewer spoof the action marker", () => {
  const marker = "<!-- ai-pr-reviewer:v3:head:digest -->";
  const snapshot = buildReviewConversation(
    "review-action",
    [review(80, "other-reviewer", marker)],
    [reviewComment(81, 80, "other-reviewer", "Independent finding")],
    [],
  );
  assert.ok(snapshot.entries.some((entry) => entry.kind === "review_body" && entry.id === 80));
  assert.ok(snapshot.entries.some((entry) => entry.kind === "inline_thread" && entry.id === 81));
});

test("maps every exposed body without changing snapshot identity metadata", () => {
  const snapshot = buildReviewConversation(
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
