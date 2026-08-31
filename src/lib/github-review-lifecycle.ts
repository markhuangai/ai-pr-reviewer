import type { GitHubCommentAuthor } from "./github-api.js";

export interface ReviewLifecycleReviewRecord {
  readonly nodeId: string;
  readonly databaseId: number;
  readonly author?: GitHubCommentAuthor;
  readonly body: string;
  readonly commitId: string | null;
  readonly state: string;
  readonly submittedAt?: string;
  readonly isMinimized: boolean;
}

export interface ReviewLifecycleCommentRecord {
  readonly nodeId: string;
  readonly databaseId: number;
  readonly reviewId?: number;
  readonly reviewNodeId?: string;
  readonly replyToId?: number;
  readonly author?: GitHubCommentAuthor;
  readonly body: string;
  readonly commitId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ReviewLifecycleThreadRecord {
  readonly nodeId: string;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly path: string;
  readonly line?: number;
  readonly originalLine?: number;
  readonly reviewId?: number;
  readonly reviewNodeId?: string;
  readonly commentsCursor?: string;
  readonly comments: readonly ReviewLifecycleCommentRecord[];
}

export interface ReviewLifecycleSnapshot {
  readonly reviews: readonly ReviewLifecycleReviewRecord[];
  readonly threads: readonly ReviewLifecycleThreadRecord[];
}

export const REVIEW_LIFECYCLE_REVIEWS_QUERY = `
  query AiPrReviewerReviews($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviews(first: 100, after: $cursor) {
          nodes {
            id
            databaseId
            author { login __typename }
            body
            commit { oid }
            state
            submittedAt
            isMinimized
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export const REVIEW_LIFECYCLE_THREADS_QUERY = `
  query AiPrReviewerThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        reviewThreads(first: 100, after: $cursor) {
          nodes {
            id
            isResolved
            isOutdated
            path
            line
            originalLine
            comments(first: 100) {
              nodes {
                id
                databaseId
                author { login __typename }
                body
                commit { oid }
                createdAt
                updatedAt
                pullRequestReview { id databaseId }
                replyTo { databaseId }
              }
              pageInfo { hasNextPage endCursor }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export const UPDATE_REVIEW_MUTATION = `
  mutation AiPrReviewerUpdateReview($reviewId: ID!, $body: String!) {
    updatePullRequestReview(input: { pullRequestReviewId: $reviewId, body: $body }) {
      pullRequestReview { id body state }
    }
  }
`;

export const DISMISS_REVIEW_MUTATION = `
  mutation AiPrReviewerDismissReview($reviewId: ID!, $message: String!) {
    dismissPullRequestReview(input: { pullRequestReviewId: $reviewId, message: $message }) {
      pullRequestReview { id state }
    }
  }
`;

export const RESOLVE_THREAD_MUTATION = `
  mutation AiPrReviewerResolveThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }
`;

export const MINIMIZE_COMMENT_MUTATION = `
  mutation AiPrReviewerMinimizeComment($subjectId: ID!, $classifier: ReportedContentClassifiers!) {
    minimizeComment(input: { subjectId: $subjectId, classifier: $classifier }) {
      minimizedComment { isMinimized }
    }
  }
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`GitHub returned an invalid ${path}.`);
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`GitHub returned an invalid ${path}.`);
  return value;
}

function positiveId(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`GitHub returned an invalid ${path}.`);
  }
  return value;
}

function optionalPositiveId(value: unknown, path: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  return positiveId(value, path);
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredString(value, path);
}

function readAuthor(value: unknown, path: string): GitHubCommentAuthor | undefined {
  if (value === null || value === undefined) return undefined;
  const author = requiredRecord(value, path);
  return {
    login: requiredString(author.login, `${path}.login`),
    type: requiredString(author.__typename, `${path}.__typename`),
  };
}

function readCommit(value: unknown, path: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requiredString(requiredRecord(value, path).oid, `${path}.oid`);
}

function readPageInfo(
  value: unknown,
  path: string,
): { readonly hasNextPage: boolean; readonly endCursor?: string } {
  const pageInfo = requiredRecord(value, path);
  if (typeof pageInfo.hasNextPage !== "boolean") {
    throw new Error(`GitHub returned an invalid ${path}.hasNextPage.`);
  }
  const endCursor = optionalString(pageInfo.endCursor, `${path}.endCursor`);
  if (pageInfo.hasNextPage && endCursor === undefined) {
    throw new Error(`GitHub returned an incomplete ${path} page cursor.`);
  }
  return { hasNextPage: pageInfo.hasNextPage, ...(endCursor === undefined ? {} : { endCursor }) };
}

export function readGraphqlConnection(
  value: unknown,
  path: string,
): {
  readonly nodes: readonly unknown[];
  readonly hasNextPage: boolean;
  readonly endCursor?: string;
} {
  const connection = requiredRecord(value, path);
  if (!Array.isArray(connection.nodes))
    throw new Error(`GitHub returned an invalid ${path}.nodes.`);
  return {
    nodes: connection.nodes,
    ...readPageInfo(connection.pageInfo, `${path}.pageInfo`),
  };
}

export function pullRequestConnection(data: unknown, name: string): Record<string, unknown> {
  const root = requiredRecord(data, "GraphQL data");
  const repository = requiredRecord(root.repository, "repository");
  const pullRequest = requiredRecord(repository.pullRequest, "pull request");
  return requiredRecord(pullRequest[name], `pull request ${name}`);
}

export function readGraphqlReview(value: unknown, index: number): ReviewLifecycleReviewRecord {
  const path = `GraphQL review at index ${index}`;
  const review = requiredRecord(value, path);
  if (typeof review.body !== "string" && review.body !== null) {
    throw new Error(`GitHub returned an invalid ${path}.body.`);
  }
  if (typeof review.state !== "string" || review.state.length === 0) {
    throw new Error(`GitHub returned an invalid ${path}.state.`);
  }
  if (typeof review.isMinimized !== "boolean") {
    throw new Error(`GitHub returned an invalid ${path}.isMinimized.`);
  }
  const author = readAuthor(review.author, `${path}.author`);
  const commitId = readCommit(review.commit, `${path}.commit`);
  const submittedAt = optionalString(review.submittedAt, `${path}.submittedAt`);
  return {
    nodeId: requiredString(review.id, `${path}.id`),
    databaseId: positiveId(review.databaseId, `${path}.databaseId`),
    ...(author === undefined ? {} : { author }),
    body: review.body === null ? "" : review.body,
    commitId: commitId ?? null,
    state: review.state,
    ...(submittedAt === undefined ? {} : { submittedAt }),
    isMinimized: review.isMinimized,
  };
}

export function readGraphqlComment(value: unknown, index: number): ReviewLifecycleCommentRecord {
  const path = `GraphQL review comment at index ${index}`;
  const comment = requiredRecord(value, path);
  const reviewValue = comment.pullRequestReview;
  const review =
    reviewValue === null || reviewValue === undefined
      ? undefined
      : requiredRecord(reviewValue, `${path}.pullRequestReview`);
  const replyValue = comment.replyTo;
  const replyTo =
    replyValue === null || replyValue === undefined
      ? undefined
      : requiredRecord(replyValue, `${path}.replyTo`);
  if (typeof comment.body !== "string" && comment.body !== null) {
    throw new Error(`GitHub returned an invalid ${path}.body.`);
  }
  const author = readAuthor(comment.author, `${path}.author`);
  const commitId = readCommit(comment.commit, `${path}.commit`);
  return {
    nodeId: requiredString(comment.id, `${path}.id`),
    databaseId: positiveId(comment.databaseId, `${path}.databaseId`),
    ...(review === undefined
      ? {}
      : {
          reviewId: positiveId(review.databaseId, `${path}.pullRequestReview.databaseId`),
          reviewNodeId: requiredString(review.id, `${path}.pullRequestReview.id`),
        }),
    ...(replyTo === undefined
      ? {}
      : { replyToId: positiveId(replyTo.databaseId, `${path}.replyTo.databaseId`) }),
    ...(author === undefined ? {} : { author }),
    body: comment.body === null ? "" : comment.body,
    ...(commitId === undefined ? {} : { commitId }),
    createdAt: requiredString(comment.createdAt, `${path}.createdAt`),
    updatedAt: requiredString(comment.updatedAt, `${path}.updatedAt`),
  };
}

export function readGraphqlThread(value: unknown, index: number): ReviewLifecycleThreadRecord {
  const path = `GraphQL review thread at index ${index}`;
  const thread = requiredRecord(value, path);
  if (typeof thread.isResolved !== "boolean") {
    throw new Error(`GitHub returned an invalid ${path}.isResolved.`);
  }
  if (typeof thread.isOutdated !== "boolean") {
    throw new Error(`GitHub returned an invalid ${path}.isOutdated.`);
  }
  const connection = readGraphqlConnection(thread.comments, `${path}.comments`);
  const comments = connection.nodes.map((comment, commentIndex) =>
    readGraphqlComment(comment, commentIndex),
  );
  const root = comments.find((comment) => comment.replyToId === undefined) ?? comments[0];
  const line = optionalPositiveId(thread.line, `${path}.line`);
  const originalLine = optionalPositiveId(thread.originalLine, `${path}.originalLine`);
  return {
    nodeId: requiredString(thread.id, `${path}.id`),
    isResolved: thread.isResolved,
    isOutdated: thread.isOutdated,
    path: requiredString(thread.path, `${path}.path`),
    ...(line === undefined ? {} : { line }),
    ...(originalLine === undefined ? {} : { originalLine }),
    ...(root?.reviewId === undefined ? {} : { reviewId: root.reviewId }),
    ...(root?.reviewNodeId === undefined ? {} : { reviewNodeId: root.reviewNodeId }),
    ...(connection.hasNextPage && connection.endCursor !== undefined
      ? { commentsCursor: connection.endCursor }
      : {}),
    comments,
  };
}

export const REVIEW_LIFECYCLE_THREAD_COMMENTS_QUERY = `
  query AiPrReviewerThreadComments($threadId: ID!, $cursor: String) {
    node(id: $threadId) {
      ... on PullRequestReviewThread {
        comments(first: 100, after: $cursor) {
          nodes {
            id
            databaseId
            author { login __typename }
            body
            commit { oid }
            createdAt
            updatedAt
            pullRequestReview { id databaseId }
            replyTo { databaseId }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

export function readGraphqlThreadComments(
  value: unknown,
  indexOffset = 0,
): {
  readonly comments: readonly ReviewLifecycleCommentRecord[];
  readonly hasNextPage: boolean;
  readonly endCursor?: string;
} {
  const root = requiredRecord(value, "GraphQL data");
  const node = requiredRecord(root.node, "review thread node");
  const connection = readGraphqlConnection(node.comments, "review thread comments");
  return {
    comments: connection.nodes.map((comment, index) =>
      readGraphqlComment(comment, indexOffset + index),
    ),
    hasNextPage: connection.hasNextPage,
    ...(connection.endCursor === undefined ? {} : { endCursor: connection.endCursor }),
  };
}

export function graphqlUrlFor(apiUrl: string): string {
  const configured = process.env.GITHUB_GRAPHQL_URL?.trim();
  if (configured !== undefined && configured.length > 0) return configured.replace(/\/$/u, "");
  const url = new URL(apiUrl);
  const pathname = url.pathname.replace(/\/$/u, "");
  url.pathname = pathname.endsWith("/api/v3")
    ? `${pathname.slice(0, -"/api/v3".length)}/api/graphql`
    : `${pathname}/graphql`;
  url.search = "";
  return url.toString().replace(/\/$/u, "");
}
