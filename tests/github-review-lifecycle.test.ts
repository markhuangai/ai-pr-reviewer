import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { promisify } from "node:util";

import { GitHubApi } from "../src/lib/github-api.js";
import {
  pullRequestConnection,
  readGraphqlComment,
  readGraphqlConnection,
  readGraphqlReview,
  readGraphqlThread,
  readGraphqlThreadComments,
  requiredRecord,
} from "../src/lib/github-review-lifecycle.js";
import type { PullRequestContext } from "../src/lib/types.js";

const context: PullRequestContext = {
  repository: "owner/repository",
  owner: "owner",
  name: "repository",
  number: 7,
  headSha: "b".repeat(40),
  baseSha: "a".repeat(40),
  baseRef: "main",
  title: "Lifecycle API",
  htmlUrl: "https://github.com/owner/repository/pull/7",
};

const execFileAsync = promisify(execFile);

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function withFetch(
  responses: readonly (Response | (() => Response))[],
  action: (
    requests: readonly { readonly input: RequestInfo | URL; readonly init?: RequestInit }[],
  ) => Promise<void>,
): Promise<void> {
  const previous = globalThis.fetch;
  const queue = [...responses];
  const requests: Array<{ readonly input: RequestInfo | URL; readonly init?: RequestInit }> = [];
  globalThis.fetch = (input, init) => {
    requests.push({ input, ...(init === undefined ? {} : { init }) });
    const response = queue.shift();
    if (response === undefined) throw new Error("test fetch response queue exhausted");
    return Promise.resolve(typeof response === "function" ? response() : response);
  };
  try {
    await action(requests);
  } finally {
    globalThis.fetch = previous;
  }
}

test("reads paginated lifecycle nodes and applies GraphQL mutations", async (t) => {
  const requests: Array<{ readonly query: string; readonly variables: Record<string, unknown> }> =
    [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.method !== "POST" || request.url !== "/graphql") {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      const payload = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
      requests.push(payload);
      if (payload.query.includes("AiPrReviewerReviews")) {
        response.end(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviews: {
                    nodes: [
                      {
                        id: "review-node-42",
                        databaseId: 42,
                        author: { login: "review-action", __typename: "User" },
                        body: "review body",
                        commit: { oid: "a".repeat(40) },
                        state: "COMMENTED",
                        submittedAt: "2026-08-31T00:00:00Z",
                        isMinimized: false,
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          }),
        );
        return;
      }
      if (payload.query.includes("AiPrReviewerThreads")) {
        response.end(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [
                      {
                        id: "thread-node-1",
                        isResolved: false,
                        isOutdated: true,
                        path: "src/change.ts",
                        line: 4,
                        originalLine: 4,
                        comments: {
                          nodes: [
                            {
                              id: "comment-node-1",
                              databaseId: 100,
                              author: { login: "review-action", __typename: "User" },
                              body: "finding",
                              commit: { oid: "a".repeat(40) },
                              createdAt: "2026-08-31T00:00:01Z",
                              updatedAt: "2026-08-31T00:00:01Z",
                              pullRequestReview: { id: "review-node-42", databaseId: 42 },
                              replyTo: null,
                            },
                          ],
                          pageInfo: { hasNextPage: true, endCursor: "thread-comments-2" },
                        },
                      },
                    ],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          }),
        );
        return;
      }
      if (payload.query.includes("AiPrReviewerThreadComments")) {
        response.end(
          JSON.stringify({
            data: {
              node: {
                comments: {
                  nodes: [
                    {
                      id: "comment-node-2",
                      databaseId: 101,
                      author: { login: "review-action", __typename: "User" },
                      body: "reply",
                      commit: { oid: "b".repeat(40) },
                      createdAt: "2026-08-31T00:00:02Z",
                      updatedAt: "2026-08-31T00:00:02Z",
                      pullRequestReview: { id: "review-node-42", databaseId: 42 },
                      replyTo: { databaseId: 100 },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
        );
        return;
      }
      if (payload.query.includes("AiPrReviewerUpdateReview")) {
        response.end(
          JSON.stringify({
            data: {
              updatePullRequestReview: {
                pullRequestReview: {
                  id: payload.variables.reviewId,
                  body: payload.variables.body,
                  state: "COMMENTED",
                },
              },
            },
          }),
        );
        return;
      }
      if (payload.query.includes("AiPrReviewerDismissReview")) {
        response.end(
          JSON.stringify({
            data: {
              dismissPullRequestReview: {
                pullRequestReview: {
                  id: payload.variables.reviewId,
                  state: "DISMISSED",
                },
              },
            },
          }),
        );
        return;
      }
      if (payload.query.includes("AiPrReviewerResolveThread")) {
        response.end(
          JSON.stringify({
            data: { resolveReviewThread: { thread: { id: "thread-node-1", isResolved: true } } },
          }),
        );
        return;
      }
      if (payload.query.includes("AiPrReviewerMinimizeComment")) {
        response.end(
          JSON.stringify({
            data: { minimizeComment: { minimizedComment: { isMinimized: true } } },
          }),
        );
        return;
      }
      response.statusCode = 400;
      response.end(JSON.stringify({ message: "unknown query" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  const api = new GitHubApi(
    "token",
    "http://127.0.0.1:1",
    undefined,
    `http://127.0.0.1:${address.port}/graphql`,
  );
  const snapshot = await api.getReviewLifecycleSnapshot(context);
  assert.equal(snapshot.reviews[0]?.databaseId, 42);
  assert.equal(snapshot.threads[0]?.comments[0]?.reviewNodeId, "review-node-42");
  await api.updateSubmittedReview("review-node-42", "stale body");
  await api.dismissSubmittedReview("review-node-42", "superseded");
  await api.resolveReviewThread("thread-node-1");
  await api.minimizeComment("review-node-42");
  assert.equal(snapshot.threads[0]?.comments.length, 2);
  assert.equal(requests.length, 7);
  assert.equal(requests[0]?.variables.owner, "owner");
  assert.deepEqual(requests[3]?.variables, {
    reviewId: "review-node-42",
    body: "stale body",
  });
  assert.deepEqual(requests[4]?.variables, {
    reviewId: "review-node-42",
    message: "superseded",
  });
});

test("validates lifecycle GraphQL records and optional fields", () => {
  assert.throws(() => requiredRecord([], "root"), /invalid root/u);
  assert.deepEqual(
    readGraphqlConnection(
      { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      "items",
    ),
    { nodes: [], hasNextPage: false },
  );
  assert.throws(
    () => readGraphqlConnection({ nodes: {}, pageInfo: {} }, "items"),
    /invalid items\.nodes/u,
  );
  assert.throws(
    () => readGraphqlConnection({ nodes: [], pageInfo: { hasNextPage: "no" } }, "items"),
    /invalid items\.pageInfo\.hasNextPage/u,
  );
  assert.throws(
    () =>
      readGraphqlConnection(
        { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
        "items",
      ),
    /incomplete items\.pageInfo page cursor/u,
  );

  const review = readGraphqlReview(
    {
      id: "review-node",
      databaseId: 1,
      author: null,
      body: null,
      commit: null,
      state: "COMMENTED",
      submittedAt: null,
      isMinimized: false,
    },
    0,
  );
  assert.deepEqual(review, {
    nodeId: "review-node",
    databaseId: 1,
    body: "",
    commitId: null,
    state: "COMMENTED",
    isMinimized: false,
  });
  assert.throws(
    () => readGraphqlReview({ ...review, body: 1 }, 0),
    /invalid GraphQL review at index 0\.body/u,
  );
  assert.throws(
    () => readGraphqlReview({ ...review, state: "" }, 0),
    /invalid GraphQL review at index 0\.state/u,
  );
  assert.throws(
    () => readGraphqlReview({ ...review, isMinimized: "no" }, 0),
    /invalid GraphQL review at index 0\.isMinimized/u,
  );

  const rawComment = {
    id: "comment-node",
    databaseId: 2,
    pullRequestReview: null,
    replyTo: null,
    author: null,
    body: null,
    commit: null,
    createdAt: "created",
    updatedAt: "updated",
  };
  const comment = readGraphqlComment(rawComment, 0);
  assert.deepEqual(comment, {
    nodeId: "comment-node",
    databaseId: 2,
    body: "",
    createdAt: "created",
    updatedAt: "updated",
  });
  assert.throws(
    () => readGraphqlComment({ ...rawComment, body: 1 }, 0),
    /invalid GraphQL review comment at index 0\.body/u,
  );
  assert.throws(
    () =>
      readGraphqlComment(
        {
          ...rawComment,
          author: {},
        },
        0,
      ),
    /invalid GraphQL review comment at index 0\.author\.login/u,
  );
  assert.throws(
    () =>
      readGraphqlComment(
        {
          ...rawComment,
          commit: {},
        },
        0,
      ),
    /invalid GraphQL review comment at index 0\.commit\.oid/u,
  );

  const thread = readGraphqlThread(
    {
      id: "thread-node",
      isResolved: false,
      isOutdated: true,
      path: "src/file.ts",
      line: null,
      originalLine: null,
      comments: {
        nodes: [rawComment],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    },
    0,
  );
  assert.deepEqual(thread, {
    nodeId: "thread-node",
    isResolved: false,
    isOutdated: true,
    path: "src/file.ts",
    comments: [comment],
  });
  assert.throws(
    () => readGraphqlThread({ ...thread, isResolved: "no" }, 0),
    /invalid GraphQL review thread at index 0\.isResolved/u,
  );
  assert.throws(
    () => readGraphqlThread({ ...thread, isOutdated: "no" }, 0),
    /invalid GraphQL review thread at index 0\.isOutdated/u,
  );

  assert.deepEqual(
    readGraphqlThreadComments(
      {
        node: {
          comments: {
            nodes: [rawComment],
            pageInfo: { hasNextPage: true, endCursor: "next" },
          },
        },
      },
      3,
    ),
    { comments: [{ ...comment }], hasNextPage: true, endCursor: "next" },
  );
  assert.deepEqual(
    pullRequestConnection({ repository: { pullRequest: { reviews: { nodes: [] } } } }, "reviews"),
    { nodes: [] },
  );
  assert.throws(() => pullRequestConnection(null, "reviews"), /invalid GraphQL data/u);
});

test("uses an explicitly configured GraphQL endpoint", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import { graphqlUrlFor } from './build-test/src/lib/github-review-lifecycle.js'; process.stdout.write(graphqlUrlFor('https://api.github.com'));",
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, GITHUB_GRAPHQL_URL: "https://ghe.example/graphql/" },
      encoding: "utf8",
    },
  );
  assert.equal(stdout, "https://ghe.example/graphql");
});

test("paginates review and thread lifecycle connections", async () => {
  const review = {
    id: "review-node",
    databaseId: 1,
    author: { login: "review-action", __typename: "User" },
    body: "review",
    commit: { oid: "a".repeat(40) },
    state: "COMMENTED",
    submittedAt: null,
    isMinimized: false,
  };
  const thread = {
    id: "thread-node",
    isResolved: true,
    isOutdated: true,
    path: "src/file.ts",
    line: null,
    originalLine: null,
    comments: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
  await withFetch(
    [
      () =>
        jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviews: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "reviews-2" } },
              },
            },
          },
        }),
      () =>
        jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviews: { nodes: [review], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          },
        }),
      () =>
        jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [],
                  pageInfo: { hasNextPage: true, endCursor: "threads-2" },
                },
              },
            },
          },
        }),
      () =>
        jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [thread],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
    ],
    async (requests) => {
      const api = new GitHubApi("token", "https://api.github.com");
      const snapshot = await api.getReviewLifecycleSnapshot(context);
      assert.equal(snapshot.reviews.length, 1);
      assert.equal(snapshot.threads.length, 1);
      assert.equal(requests.length, 4);
      const variables = requests.map((request) => {
        const body = request.init?.body;
        if (typeof body !== "string") throw new Error("test request has no body");
        return JSON.parse(body) as { variables: { cursor: string | null } };
      });
      assert.deepEqual(
        variables.map((entry) => entry.variables.cursor),
        [null, "reviews-2", null, "threads-2"],
      );
    },
  );
});

test("fails closed on malformed GraphQL responses and non-advancing cursors", async () => {
  await withFetch([jsonResponse({ errors: [{ message: "permission denied" }] })], async () => {
    await assert.rejects(
      new GitHubApi("token").getReviewLifecycleSnapshot(context),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "GitHub GraphQL request returned errors: permission denied",
    );
  });
  await withFetch([new Response("not-json")], async () => {
    await assert.rejects(
      new GitHubApi("token").getReviewLifecycleSnapshot(context),
      /invalid GraphQL response/u,
    );
  });
  await withFetch(
    [
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviews: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } },
            },
          },
        },
      }),
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviews: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } },
            },
          },
        },
      }),
    ],
    async () => {
      await assert.rejects(
        new GitHubApi("token").getReviewLifecycleSnapshot(context),
        /non-advancing pull request review cursor/u,
      );
    },
  );
  await withFetch(
    [
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviews: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      }),
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "thread-node",
                    isResolved: false,
                    isOutdated: true,
                    path: "src/file.ts",
                    line: 1,
                    originalLine: 1,
                    comments: {
                      nodes: [],
                      pageInfo: { hasNextPage: true, endCursor: "comment-same" },
                    },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
      jsonResponse({
        data: {
          node: {
            comments: {
              nodes: [],
              pageInfo: { hasNextPage: true, endCursor: "comment-same" },
            },
          },
        },
      }),
    ],
    async () => {
      await assert.rejects(
        new GitHubApi("token").getReviewLifecycleSnapshot(context),
        /non-advancing review thread comment cursor/u,
      );
    },
  );
});

test("validates lifecycle mutation payloads and updates REST review comments", async () => {
  await withFetch([jsonResponse({ data: { updatePullRequestReview: null } })], async () => {
    await assert.rejects(
      new GitHubApi("token").updateSubmittedReview("review", "stale"),
      /invalid update/u,
    );
  });
  await withFetch(
    [
      jsonResponse({
        data: {
          dismissPullRequestReview: {
            pullRequestReview: { id: "review", state: "APPROVED" },
          },
        },
      }),
    ],
    async () => {
      await assert.rejects(
        new GitHubApi("token").dismissSubmittedReview("review", "superseded"),
        /did not dismiss/u,
      );
    },
  );
  await withFetch(
    [
      jsonResponse({
        data: {
          updatePullRequestReview: {
            pullRequestReview: { id: "review", body: "different" },
          },
        },
      }),
    ],
    async () => {
      await assert.rejects(
        new GitHubApi("token").updateSubmittedReview("review", "stale"),
        /did not update/u,
      );
    },
  );
  await withFetch([jsonResponse({ data: { dismissPullRequestReview: null } })], async () => {
    await assert.rejects(
      new GitHubApi("token").dismissSubmittedReview("review", "superseded"),
      /invalid dismiss/u,
    );
  });
  await withFetch(
    [
      jsonResponse({
        data: { resolveReviewThread: { thread: { id: "thread", isResolved: false } } },
      }),
    ],
    async () => {
      await assert.rejects(
        new GitHubApi("token").resolveReviewThread("thread"),
        /did not resolve/u,
      );
    },
  );
  await withFetch(
    [jsonResponse({ data: { minimizeComment: { minimizedComment: { isMinimized: false } } } })],
    async () => {
      await assert.rejects(new GitHubApi("token").minimizeComment("review"), /did not minimize/u);
    },
  );
  await withFetch([jsonResponse({ ok: true })], async (requests) => {
    await new GitHubApi("token").updateReviewComment(context, 42, "updated body");
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.ok(request);
    const input = request.input;
    const requestUrl =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.equal(requestUrl, "https://api.github.com/repos/owner/repository/pulls/comments/42");
    assert.equal(request.init?.method, "PATCH");
    assert.equal(request.init?.body, JSON.stringify({ body: "updated body" }));
  });
});
