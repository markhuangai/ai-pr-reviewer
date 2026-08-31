import {
  actionReader,
  assert,
  cleanWorkspace,
  emptyConversationApi,
  runAction,
  test,
  useWorkspace,
  type PullRequestContext,
} from "./index-test-helpers.js";
import {
  finalizeReviewLifecycle,
  fixedReplyBody,
  isActionOwnedReview,
  isCleanActionReview,
  isFindingActionReview,
  isReviewLifecycleApi,
  logLifecycleResult,
  parseActionReviewIdentity,
  prepareReviewLifecycle,
  resolveReviewLifecycle,
  reviewLifecycleInternals,
  selectUnresolvedActionThreads,
  type ReviewLifecycleApi,
} from "../src/lib/review-lifecycle.js";
import type {
  ReviewLifecycleReviewRecord,
  ReviewLifecycleSnapshot,
  ReviewLifecycleThreadRecord,
} from "../src/lib/github-review-lifecycle.js";
import type { GitHubApi } from "../src/lib/github-api.js";
import type { ReviewConfig } from "../src/lib/types.js";

const headSha = "b".repeat(40);
const oldSha = "a".repeat(40);
const context: PullRequestContext = {
  repository: "owner/repository",
  owner: "owner",
  name: "repository",
  number: 1,
  headSha,
  baseSha: "c".repeat(40),
  baseRef: "main",
  title: "Lifecycle",
  htmlUrl: "https://github.com/owner/repository/pull/1",
};
const config: ReviewConfig = {
  githubToken: "token",
  aiBaseUrl: "https://ai.example.test",
  aiSecret: "secret",
  model: "review-model",
  reviewPrompts: [{ prompt: "correctness", files: [] }],
  parallelCount: 1,
  maxTurns: 2,
  autoApprove: false,
  interactWithPullRequest: true,
  mcpServers: {},
};

function review(
  databaseId: number,
  body: string,
  commitId = oldSha,
  isMinimized = false,
): ReviewLifecycleReviewRecord {
  return {
    nodeId: `review-node-${databaseId}`,
    databaseId,
    author: { login: "review-action", type: "User" },
    body,
    commitId,
    state: "COMMENTED",
    submittedAt: "2026-08-31T00:00:00Z",
    isMinimized,
  };
}

function findingBody(extra = ""): string {
  return `<!-- ai-pr-reviewer:v3:${oldSha}:${"d".repeat(64)} -->\n## 🔎 AI review\n\nSee the inline comments for details.${extra}`;
}

function cleanBody(): string {
  return `<!-- ai-pr-reviewer:v3:${oldSha}:${"e".repeat(64)} -->\n## ✨ Good job!\n\nNo actionable issues found.`;
}

function thread(
  nodeId: string,
  reviewId: number,
  isResolved: boolean,
  body = "Original finding",
): ReviewLifecycleThreadRecord {
  return {
    nodeId,
    isResolved,
    isOutdated: true,
    path: "src/change.ts",
    line: 4,
    originalLine: 4,
    reviewId,
    reviewNodeId: `review-node-${reviewId}`,
    comments: [
      {
        nodeId: `${nodeId}-comment`,
        databaseId: Number(nodeId.replace(/\D/gu, "")) || 1,
        reviewId,
        reviewNodeId: `review-node-${reviewId}`,
        author: { login: "review-action", type: "User" },
        body,
        commitId: oldSha,
        createdAt: "2026-08-31T00:01:00Z",
        updatedAt: "2026-08-31T00:01:00Z",
      },
    ],
  };
}

function apiFor(snapshot: ReviewLifecycleSnapshot, calls: string[]): ReviewLifecycleApi {
  return {
    getReviewLifecycleSnapshot: () => Promise.resolve(snapshot),
    deleteSubmittedReview: (nodeId) => {
      calls.push(`delete:${nodeId}`);
      return Promise.resolve();
    },
    addReviewThreadReply: (nodeId, body) => {
      calls.push(`reply:${nodeId}:${body}`);
      return Promise.resolve();
    },
    resolveReviewThread: (nodeId) => {
      calls.push(`resolve:${nodeId}`);
      return Promise.resolve();
    },
    minimizeComment: (nodeId) => {
      calls.push(`minimize:${nodeId}`);
      return Promise.resolve();
    },
  };
}

test("recognizes only stale, marker-owned clean reviews", () => {
  const stale = review(1, cleanBody());
  assert.equal(isCleanActionReview(stale, context, "REVIEW-ACTION"), true);
  assert.equal(
    isCleanActionReview(
      { ...stale, author: { login: "another-user", type: "User" } },
      context,
      "review-action",
    ),
    false,
  );
  assert.equal(
    isCleanActionReview({ ...stale, commitId: headSha }, context, "review-action"),
    false,
  );
  assert.equal(
    isCleanActionReview(
      { ...stale, body: `${cleanBody()}\n### Findings` },
      context,
      "review-action",
    ),
    false,
  );
});

test("deletes stale clean reviews and selects only unresolved owned finding threads", async () => {
  const otherThread = thread("thread-other", 2, false);
  const otherRoot = otherThread.comments[0];
  assert.ok(otherRoot);
  const snapshot: ReviewLifecycleSnapshot = {
    reviews: [review(1, cleanBody()), review(2, findingBody())],
    threads: [
      thread("thread-2", 2, false),
      thread("thread-resolved", 2, true),
      {
        ...otherThread,
        comments: [
          {
            ...otherRoot,
            author: { login: "human", type: "User" },
          },
        ],
      },
    ],
  };
  const calls: string[] = [];
  const preparation = await prepareReviewLifecycle(
    apiFor(snapshot, calls),
    context,
    "review-action",
  );
  assert.deepEqual(calls, ["delete:review-node-1"]);
  assert.deepEqual(preparation.deletedCleanReviewIds, [1]);
  assert.deepEqual(
    preparation.candidates.map((candidate) => candidate.thread.nodeId),
    ["thread-2"],
  );
  assert.equal(selectUnresolvedActionThreads(snapshot, context, "review-action").length, 1);
});

test("adds the fixed reply before resolving an unchanged high-confidence thread", async () => {
  const original = thread("thread-2", 2, false);
  const snapshot: ReviewLifecycleSnapshot = {
    reviews: [review(2, findingBody())],
    threads: [original],
  };
  const calls: string[] = [];
  const preparation = await prepareReviewLifecycle(
    apiFor(snapshot, calls),
    context,
    "review-action",
  );
  calls.length = 0;
  let currentSnapshot = snapshot;
  const api: ReviewLifecycleApi = {
    ...apiFor(snapshot, calls),
    getReviewLifecycleSnapshot: () => Promise.resolve(currentSnapshot),
    addReviewThreadReply: (nodeId, body) => {
      calls.push(`reply:${nodeId}:${body}`);
      currentSnapshot = {
        ...currentSnapshot,
        threads: [
          {
            ...original,
            comments: [
              ...original.comments,
              {
                nodeId: "fixed-comment",
                databaseId: 12,
                reviewId: 2,
                reviewNodeId: "review-node-2",
                replyToId: original.comments[0]?.databaseId ?? 1,
                author: { login: "review-action", type: "User" },
                body: fixedReplyBody(headSha),
                commitId: headSha,
                createdAt: "2026-08-31T00:02:00Z",
                updatedAt: "2026-08-31T00:02:00Z",
              },
            ],
          },
        ],
      };
      return Promise.resolve();
    },
  };
  const resolved = await resolveReviewLifecycle(
    api,
    preparation,
    context,
    "review-action",
    config,
    "/workspace",
    undefined,
    undefined,
    () =>
      Promise.resolve([
        { status: "completed", verdict: "fixed", confidence: "high", rationale: "gone" },
      ]),
  );
  assert.deepEqual(resolved, ["thread-2"]);
  assert.equal(calls.length, 2);
  assert.match(calls[0] ?? "", /^reply:thread-2:/u);
  assert.match(calls[0] ?? "", new RegExp("Fixed in `" + headSha + "`"));
  assert.equal(calls[1], "resolve:thread-2");
});

test("does not mutate a stale thread after a concurrent discussion change", async () => {
  const original = thread("thread-2", 2, false);
  const originalComment = original.comments[0];
  assert.ok(originalComment);
  const changed = {
    ...original,
    comments: [{ ...originalComment, body: "Human changed this" }],
  };
  const snapshots = [
    { reviews: [review(2, findingBody())], threads: [original] },
    { reviews: [review(2, findingBody())], threads: [changed] },
  ];
  let reads = 0;
  const calls: string[] = [];
  const firstSnapshot = snapshots[0];
  assert.ok(firstSnapshot);
  const api = {
    ...apiFor(firstSnapshot, calls),
    getReviewLifecycleSnapshot: () => {
      const snapshot = snapshots[Math.min(reads++, 1)];
      assert.ok(snapshot);
      return Promise.resolve(snapshot);
    },
  };
  const preparation = await prepareReviewLifecycle(api, context, "review-action");
  const resolved = await resolveReviewLifecycle(
    api,
    preparation,
    context,
    "review-action",
    config,
    "/workspace",
    undefined,
    undefined,
    () =>
      Promise.resolve([
        { status: "completed", verdict: "fixed", confidence: "high", rationale: "gone" },
      ]),
  );
  assert.deepEqual(resolved, []);
  assert.deepEqual(calls, []);
});

test("minimizes only old finding reviews whose inline threads are all resolved", async () => {
  const snapshot: ReviewLifecycleSnapshot = {
    reviews: [
      review(2, findingBody()),
      review(3, findingBody("\n### Findings\n\nBody finding")),
      review(4, findingBody()),
    ],
    threads: [
      thread("thread-resolved", 2, true),
      thread("thread-body", 3, true),
      thread("thread-open", 4, false),
    ],
  };
  const calls: string[] = [];
  const minimized = await finalizeReviewLifecycle(
    apiFor(snapshot, calls),
    context,
    "review-action",
  );
  assert.deepEqual(minimized, [2]);
  assert.deepEqual(calls, ["minimize:review-node-2"]);
});

test("renders a deterministic fixed reply marker", () => {
  const body = fixedReplyBody(headSha);
  assert.match(body, new RegExp("^Fixed in `" + headSha + "`"));
  assert.match(body, new RegExp(`ai-pr-reviewer:fixed:v1:${headSha}`));
  assert.equal(reviewLifecycleInternals.FIXED_REPLY_MARKER.test(body), true);
});

test("binds lifecycle ownership and finding identity to the authenticated action", () => {
  const clean = review(1, cleanBody());
  const finding = review(2, findingBody());
  assert.deepEqual(parseActionReviewIdentity(clean.body), { headSha: oldSha });
  assert.deepEqual(
    parseActionReviewIdentity(clean.body.replace("<!--", "<!-- malformed")),
    undefined,
  );
  assert.equal(isActionOwnedReview(clean, "REVIEW-ACTION"), true);
  const noAuthor = { body: clean.body };
  assert.equal(isActionOwnedReview(noAuthor, "review-action"), false);
  assert.equal(isFindingActionReview(finding, context, "review-action"), true);
  assert.equal(
    isFindingActionReview({ ...finding, commitId: null }, context, "review-action"),
    false,
  );
  assert.equal(
    isFindingActionReview(
      { ...finding, author: { login: "human", type: "User" } },
      context,
      "review-action",
    ),
    false,
  );
  assert.equal(
    isFindingActionReview({ ...finding, body: "## 🔎 AI review" }, context, "review-action"),
    false,
  );
});

test("skips lifecycle verification when no candidate is available", async () => {
  let called = false;
  const result = await resolveReviewLifecycle(
    apiFor({ reviews: [], threads: [] }, []),
    { snapshot: { reviews: [], threads: [] }, candidates: [], deletedCleanReviewIds: [] },
    context,
    "review-action",
    config,
    "/workspace",
    undefined,
    undefined,
    () => {
      called = true;
      return Promise.reject(new Error("unexpected verifier"));
    },
  );
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test("resolves an unchanged thread that already has the fixed reply", async () => {
  const original = thread("thread-fixed", 2, false);
  const root = original.comments[0];
  assert.ok(root);
  const withReply: ReviewLifecycleThreadRecord = {
    ...original,
    comments: [
      root,
      {
        ...root,
        nodeId: "fixed-reply",
        databaseId: 99,
        replyToId: root.databaseId,
        body: fixedReplyBody(headSha),
        commitId: headSha,
      },
    ],
  };
  const snapshot: ReviewLifecycleSnapshot = {
    reviews: [review(2, findingBody())],
    threads: [withReply],
  };
  const calls: string[] = [];
  const preparation = await prepareReviewLifecycle(
    apiFor(snapshot, calls),
    context,
    "review-action",
  );
  calls.length = 0;
  const resolved = await resolveReviewLifecycle(
    apiFor(snapshot, calls),
    preparation,
    context,
    "review-action",
    config,
    "/workspace",
    undefined,
    undefined,
    () =>
      Promise.resolve([
        { status: "completed", verdict: "fixed", confidence: "high", rationale: "already replied" },
      ]),
  );
  assert.deepEqual(resolved, ["thread-fixed"]);
  assert.deepEqual(calls, ["resolve:thread-fixed"]);
});

test("ignores failed, uncertain, and incomplete verifier results", async () => {
  const first = thread("thread-not-fixed", 2, false);
  const second = thread("thread-uncertain", 2, false);
  const snapshot: ReviewLifecycleSnapshot = {
    reviews: [review(2, findingBody())],
    threads: [first, second],
  };
  const calls: string[] = [];
  const preparation = await prepareReviewLifecycle(
    apiFor(snapshot, calls),
    context,
    "review-action",
  );
  calls.length = 0;
  const resolved = await resolveReviewLifecycle(
    apiFor(snapshot, calls),
    preparation,
    context,
    "review-action",
    config,
    "/workspace",
    undefined,
    undefined,
    () =>
      Promise.resolve([
        { status: "failed", error: "provider unavailable" },
        { status: "completed", verdict: "fixed", confidence: "medium", rationale: "uncertain" },
      ]),
  );
  assert.deepEqual(resolved, []);
  assert.deepEqual(calls, []);
  const incomplete = await resolveReviewLifecycle(
    apiFor(snapshot, calls),
    preparation,
    context,
    "review-action",
    config,
    "/workspace",
    undefined,
    undefined,
    () => Promise.resolve([]),
  );
  assert.deepEqual(incomplete, []);
});

test("does not resolve when the reply or resolve recheck observes another change", async () => {
  const original = thread("thread-race", 2, false);
  const root = original.comments[0];
  assert.ok(root);
  const changedAfterReply: ReviewLifecycleThreadRecord = {
    ...original,
    comments: [
      root,
      {
        ...root,
        nodeId: "fixed-reply",
        databaseId: 100,
        replyToId: root.databaseId,
        body: fixedReplyBody(headSha),
        commitId: headSha,
      },
      {
        ...root,
        nodeId: "human-reply",
        databaseId: 101,
        replyToId: root.databaseId,
        body: "Human reply after the verifier ran",
      },
    ],
  };
  const stableWithReply: ReviewLifecycleThreadRecord = {
    ...original,
    comments: [
      root,
      {
        ...root,
        nodeId: "fixed-reply",
        databaseId: 100,
        replyToId: root.databaseId,
        body: fixedReplyBody(headSha),
        commitId: headSha,
      },
    ],
  };
  const snapshot: ReviewLifecycleSnapshot = {
    reviews: [review(2, findingBody())],
    threads: [original],
  };
  const calls: string[] = [];
  let reads = 0;
  const raceSnapshots: readonly ReviewLifecycleSnapshot[] = [
    snapshot,
    snapshot,
    { reviews: snapshot.reviews, threads: [changedAfterReply] },
  ];
  const api: ReviewLifecycleApi = {
    ...apiFor(snapshot, calls),
    getReviewLifecycleSnapshot: () => {
      const current = raceSnapshots[Math.min(reads++, 2)];
      assert.ok(current);
      return Promise.resolve(current);
    },
  };
  const preparation = await prepareReviewLifecycle(api, context, "review-action");
  const firstResult = await resolveReviewLifecycle(
    api,
    preparation,
    context,
    "review-action",
    config,
    "/workspace",
    undefined,
    undefined,
    () =>
      Promise.resolve([
        { status: "completed", verdict: "fixed", confidence: "high", rationale: "gone" },
      ]),
  );
  assert.deepEqual(firstResult, []);
  assert.deepEqual(calls, ["reply:thread-race:" + fixedReplyBody(headSha)]);

  const resolvedSnapshot: ReviewLifecycleSnapshot = {
    reviews: [review(2, findingBody())],
    threads: [stableWithReply],
  };
  const resolveCalls: string[] = [];
  let resolveReads = 0;
  const resolveSnapshots: readonly ReviewLifecycleSnapshot[] = [
    resolvedSnapshot,
    resolvedSnapshot,
    { ...resolvedSnapshot, threads: [changedAfterReply] },
  ];
  const resolveApi: ReviewLifecycleApi = {
    ...apiFor(resolvedSnapshot, resolveCalls),
    getReviewLifecycleSnapshot: () => {
      const current = resolveSnapshots[Math.min(resolveReads++, 2)];
      assert.ok(current);
      return Promise.resolve(current);
    },
  };
  const secondPreparation = await prepareReviewLifecycle(resolveApi, context, "review-action");
  const secondResult = await resolveReviewLifecycle(
    resolveApi,
    secondPreparation,
    context,
    "review-action",
    config,
    "/workspace",
    undefined,
    undefined,
    () =>
      Promise.resolve([
        { status: "completed", verdict: "fixed", confidence: "high", rationale: "gone" },
      ]),
  );
  assert.deepEqual(secondResult, []);
  assert.deepEqual(resolveCalls, []);
});

test("guards minimization against current, minimized, unrelated, and threadless reviews", async () => {
  const oldFinding = review(2, findingBody());
  const snapshot: ReviewLifecycleSnapshot = {
    reviews: [
      oldFinding,
      { ...oldFinding, databaseId: 3, nodeId: "review-node-3", isMinimized: true },
      { ...oldFinding, databaseId: 4, nodeId: "review-node-4", commitId: headSha },
      {
        ...oldFinding,
        databaseId: 5,
        nodeId: "review-node-5",
        author: { login: "human", type: "User" },
      },
      { ...oldFinding, databaseId: 6, nodeId: "review-node-6", body: "not an action review" },
      { ...oldFinding, databaseId: 7, nodeId: "review-node-7" },
      {
        ...oldFinding,
        databaseId: 8,
        nodeId: "review-node-8",
        body: findingBody("\n### Findings\nbody"),
      },
    ],
    threads: [thread("thread-resolved", 2, true)],
  };
  const calls: string[] = [];
  assert.deepEqual(
    await finalizeReviewLifecycle(apiFor(snapshot, calls), context, "review-action"),
    [2],
  );
  assert.deepEqual(calls, ["minimize:review-node-2"]);
});

test("identifies complete lifecycle APIs and logs non-empty results", () => {
  assert.equal(
    isReviewLifecycleApi(apiFor({ reviews: [], threads: [] }, []) as unknown as GitHubApi),
    true,
  );
  assert.equal(isReviewLifecycleApi({} as GitHubApi), false);
  logLifecycleResult({ resolvedThreadIds: ["thread"], minimizedReviewIds: [1] });
  logLifecycleResult({ resolvedThreadIds: [], minimizedReviewIds: [] });
});

test("wires the injected resolution verifier through the interactive action", async (t) => {
  const { context, workspace } = await cleanWorkspace(t);
  useWorkspace(t, workspace);
  const oldSha = "a".repeat(40);
  const findingReview: ReviewLifecycleReviewRecord = {
    nodeId: "finding-review-node",
    databaseId: 22,
    author: { login: "review-action", type: "User" },
    body: `<!-- ai-pr-reviewer:v3:${oldSha}:${"d".repeat(64)} -->\n## 🔎 AI review\n\nSee the inline comments for details.`,
    commitId: oldSha,
    state: "COMMENTED",
    submittedAt: "2026-08-31T00:00:00Z",
    isMinimized: false,
  };
  const rootComment = {
    nodeId: "finding-comment-node",
    databaseId: 220,
    reviewId: findingReview.databaseId,
    reviewNodeId: findingReview.nodeId,
    author: { login: "review-action", type: "User" },
    body: "Old finding",
    commitId: oldSha,
    createdAt: "2026-08-31T00:00:00Z",
    updatedAt: "2026-08-31T00:00:00Z",
  };
  const openThread: ReviewLifecycleThreadRecord = {
    nodeId: "finding-thread-node",
    isResolved: false,
    isOutdated: true,
    path: "review.txt",
    line: 1,
    originalLine: 1,
    reviewId: findingReview.databaseId,
    reviewNodeId: findingReview.nodeId,
    comments: [rootComment],
  };
  let snapshot: ReviewLifecycleSnapshot = {
    reviews: [findingReview],
    threads: [openThread],
  };
  const calls: string[] = [];
  let verifiedThreads: readonly string[] = [];
  const api = {
    ...emptyConversationApi("review-action"),
    getReviewLifecycleSnapshot: () => Promise.resolve(snapshot),
    deleteSubmittedReview: (nodeId: string) => {
      calls.push(`delete:${nodeId}`);
      return Promise.resolve();
    },
    addReviewThreadReply: (nodeId: string, body: string) => {
      calls.push(`reply:${nodeId}`);
      snapshot = {
        ...snapshot,
        threads: [
          {
            ...openThread,
            comments: [
              rootComment,
              {
                ...rootComment,
                nodeId: "fixed-reply-node",
                databaseId: 221,
                replyToId: rootComment.databaseId,
                body,
                commitId: context.headSha,
              },
            ],
          },
        ],
      };
      return Promise.resolve();
    },
    resolveReviewThread: (nodeId: string) => {
      calls.push(`resolve:${nodeId}`);
      snapshot = {
        ...snapshot,
        threads: snapshot.threads.map((item) => ({ ...item, isResolved: true })),
      };
      return Promise.resolve();
    },
    minimizeComment: (nodeId: string) => {
      calls.push(`minimize:${nodeId}`);
      return Promise.resolve();
    },
    createReview: () => {
      calls.push("create");
      return Promise.resolve();
    },
  } as unknown as GitHubApi;
  const result = await runAction(actionReader(), [], {
    createApi: () => api,
    readEventContext: () => Promise.resolve(context),
    createWorkspace: () => Promise.reject(new Error("unexpected temporary workspace")),
    runGoals: () =>
      Promise.resolve([
        {
          prompt: "correctness",
          status: "completed",
          submission: { summary: "clean", findings: [] },
        },
      ]),
    runResolutionVerifiers: (_context, threads) => {
      verifiedThreads = threads.map((item) => item.nodeId);
      return Promise.resolve([
        { status: "completed", verdict: "fixed", confidence: "high", rationale: "gone" },
      ]);
    },
    writeSummary: () => Promise.resolve(),
  });
  assert.equal(result.skipped, false);
  assert.deepEqual(verifiedThreads, ["finding-thread-node"]);
  assert.deepEqual(calls, [
    "reply:finding-thread-node",
    "resolve:finding-thread-node",
    "create",
    "minimize:finding-review-node",
  ]);
});
