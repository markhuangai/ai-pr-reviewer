import { createHash } from "node:crypto";

import type { GitHubCommentAuthor, PullRequestIssueCommentRecord } from "./github-api.js";
import type {
  ReviewLifecycleCommentRecord,
  ReviewLifecycleReviewRecord,
  ReviewLifecycleSnapshot,
  ReviewLifecycleThreadRecord,
} from "./github-review-lifecycle.js";

export type ConversationAuthorRole = "human" | "bot" | "workflow" | "unknown";

export interface ConversationMessage {
  readonly id: number;
  readonly reviewId?: number;
  readonly inReplyToId?: number;
  readonly authorLogin?: string;
  readonly authorRole: ConversationAuthorRole;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly commitId?: string | null;
  readonly originalCommitId?: string;
  readonly path?: string;
  readonly line?: number;
  readonly originalLine?: number;
}

export interface InlineConversationThread {
  readonly kind: "inline_thread";
  readonly id: number;
  readonly reviewId?: number;
  readonly rootAvailable: boolean;
  readonly createdAt: string;
  readonly path: string;
  readonly line?: number;
  readonly originalLine?: number;
  readonly isResolved: boolean;
  readonly isOutdated: boolean;
  readonly resolvedByLogin?: string;
  readonly reviewIsMinimized?: boolean;
  readonly reviewMinimizedReason?: string;
  readonly messages: readonly ConversationMessage[];
}

export interface PullRequestConversationComment {
  readonly kind: "pr_comment";
  readonly id: number;
  readonly createdAt: string;
  readonly message: ConversationMessage;
}

export interface PullRequestReviewBody {
  readonly kind: "review_body";
  readonly id: number;
  readonly createdAt: string;
  readonly state: string;
  readonly commitId: string | null;
  readonly isMinimized: boolean;
  readonly minimizedReason?: string;
  readonly message: ConversationMessage;
}

export type ReviewConversationEntry =
  InlineConversationThread | PullRequestConversationComment | PullRequestReviewBody;

export interface ReviewConversationSnapshot {
  readonly digest: string;
  readonly entries: readonly ReviewConversationEntry[];
}

const ACTION_MARKER = /<!--\s*ai-pr-reviewer:v\d+:/u;

function sameLogin(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function authorRole(
  author: GitHubCommentAuthor | undefined,
  authenticatedLogin: string,
  performedViaGitHubApp = false,
  actionAuthored = false,
): ConversationAuthorRole {
  if (actionAuthored || (author !== undefined && sameLogin(author.login, authenticatedLogin))) {
    return "workflow";
  }
  if (author === undefined) return "unknown";
  if (
    performedViaGitHubApp ||
    author.type.toLowerCase() === "bot" ||
    author.login.toLowerCase().endsWith("[bot]")
  ) {
    return "bot";
  }
  return "human";
}

function messageAuthor(author: GitHubCommentAuthor | undefined): { readonly authorLogin?: string } {
  return author === undefined ? {} : { authorLogin: author.login };
}

function reviewMessage(
  review: ReviewLifecycleReviewRecord,
  authenticatedLogin: string,
): ConversationMessage {
  const actionAuthored =
    review.author !== undefined &&
    sameLogin(review.author.login, authenticatedLogin) &&
    ACTION_MARKER.test(review.body);
  return {
    id: review.databaseId,
    ...messageAuthor(review.author),
    authorRole: authorRole(review.author, authenticatedLogin, false, actionAuthored),
    body: review.body,
    createdAt: review.submittedAt ?? "",
    updatedAt: review.submittedAt ?? "",
    commitId: review.commitId,
  };
}

function reviewCommentMessage(
  comment: ReviewLifecycleCommentRecord,
  thread: ReviewLifecycleThreadRecord,
  authenticatedLogin: string,
  actionReviewIds: ReadonlySet<number>,
): ConversationMessage {
  return {
    id: comment.databaseId,
    ...(comment.reviewId === undefined ? {} : { reviewId: comment.reviewId }),
    ...(comment.replyToId === undefined ? {} : { inReplyToId: comment.replyToId }),
    ...messageAuthor(comment.author),
    authorRole: authorRole(
      comment.author,
      authenticatedLogin,
      false,
      comment.replyToId === undefined &&
        comment.reviewId !== undefined &&
        actionReviewIds.has(comment.reviewId),
    ),
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    ...(comment.commitId === undefined ? {} : { commitId: comment.commitId }),
    ...(comment.originalCommitId === undefined
      ? {}
      : { originalCommitId: comment.originalCommitId }),
    path: thread.path,
    ...(thread.line === undefined ? {} : { line: thread.line }),
    ...(thread.originalLine === undefined ? {} : { originalLine: thread.originalLine }),
  };
}

function issueCommentMessage(
  comment: PullRequestIssueCommentRecord,
  authenticatedLogin: string,
): ConversationMessage {
  return {
    id: comment.id,
    ...messageAuthor(comment.author),
    authorRole: authorRole(comment.author, authenticatedLogin, comment.performedViaGitHubApp),
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function messageSort(left: ConversationMessage, right: ConversationMessage): number {
  const leftRoot = left.inReplyToId === undefined ? 0 : 1;
  const rightRoot = right.inReplyToId === undefined ? 0 : 1;
  return (
    leftRoot - rightRoot || left.createdAt.localeCompare(right.createdAt) || left.id - right.id
  );
}

function entrySort(left: ReviewConversationEntry, right: ReviewConversationEntry): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.id - right.id ||
    left.kind.localeCompare(right.kind)
  );
}

function conversationIdentityEntry(
  entry: ReviewConversationEntry,
  authenticatedLogin: string,
): unknown {
  if (entry.kind !== "inline_thread") {
    return {
      kind: entry.kind,
      id: entry.id,
      message: entry.message,
    };
  }
  const externalMessages = entry.messages.filter((message) => message.authorRole !== "workflow");
  const externallyResolved =
    entry.resolvedByLogin !== undefined && !sameLogin(entry.resolvedByLogin, authenticatedLogin);
  if (externalMessages.length === 0 && !externallyResolved) return undefined;
  return {
    kind: entry.kind,
    id: entry.id,
    reviewId: entry.reviewId,
    rootAvailable: entry.rootAvailable,
    createdAt: entry.createdAt,
    path: entry.path,
    line: entry.line,
    originalLine: entry.originalLine,
    messages: externalMessages,
    ...(externallyResolved
      ? {
          isResolved: entry.isResolved,
          resolvedByLogin: entry.resolvedByLogin,
        }
      : {}),
  };
}

function conversationDigest(
  entries: readonly ReviewConversationEntry[],
  authenticatedLogin = "",
): string {
  const identity = entries.flatMap((entry) => {
    const projected = conversationIdentityEntry(entry, authenticatedLogin);
    return projected === undefined ? [] : [projected];
  });
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function buildReviewConversation(
  authenticatedLogin: string,
  lifecycle: ReviewLifecycleSnapshot,
  issueComments: readonly PullRequestIssueCommentRecord[],
): ReviewConversationSnapshot {
  const actionReviewIds = new Set(
    lifecycle.reviews
      .filter(
        (review) =>
          review.author !== undefined &&
          sameLogin(review.author.login, authenticatedLogin) &&
          ACTION_MARKER.test(review.body),
      )
      .map((review) => review.databaseId),
  );
  const reviewsById = new Map(lifecycle.reviews.map((review) => [review.databaseId, review]));

  const entries: ReviewConversationEntry[] = [];
  for (const thread of lifecycle.threads) {
    const messages = thread.comments
      .map((comment) => reviewCommentMessage(comment, thread, authenticatedLogin, actionReviewIds))
      .sort(messageSort);
    const root = messages.find((message) => message.inReplyToId === undefined);
    const location = root ?? messages[0];
    if (location === undefined) continue;
    const rootId = root?.id ?? location.inReplyToId ?? location.id;
    const review = thread.reviewId === undefined ? undefined : reviewsById.get(thread.reviewId);
    entries.push({
      kind: "inline_thread",
      id: rootId,
      ...(thread.reviewId === undefined ? {} : { reviewId: thread.reviewId }),
      rootAvailable: root !== undefined,
      createdAt: root?.createdAt ?? location.createdAt,
      path: thread.path,
      ...(thread.line === undefined ? {} : { line: thread.line }),
      ...(thread.originalLine === undefined ? {} : { originalLine: thread.originalLine }),
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      ...(thread.resolvedBy === undefined ? {} : { resolvedByLogin: thread.resolvedBy.login }),
      ...(review === undefined ? {} : { reviewIsMinimized: review.isMinimized }),
      ...(review?.minimizedReason === undefined
        ? {}
        : { reviewMinimizedReason: review.minimizedReason }),
      messages,
    });
  }

  for (const review of lifecycle.reviews) {
    const message = reviewMessage(review, authenticatedLogin);
    if (message.authorRole === "workflow" || message.body.trim().length === 0) continue;
    entries.push({
      kind: "review_body",
      id: review.databaseId,
      createdAt: message.createdAt,
      state: review.state,
      commitId: review.commitId,
      isMinimized: review.isMinimized,
      ...(review.minimizedReason === undefined ? {} : { minimizedReason: review.minimizedReason }),
      message,
    });
  }

  for (const comment of issueComments) {
    const message = issueCommentMessage(comment, authenticatedLogin);
    if (message.authorRole === "workflow" || message.body.trim().length === 0) continue;
    entries.push({
      kind: "pr_comment",
      id: comment.id,
      createdAt: comment.createdAt,
      message,
    });
  }

  entries.sort(entrySort);
  return { digest: conversationDigest(entries, authenticatedLogin), entries };
}

function mapMessage(
  message: ConversationMessage,
  transform: (body: string) => string,
): ConversationMessage {
  return { ...message, body: transform(message.body) };
}

export function mapConversationBodies(
  snapshot: ReviewConversationSnapshot,
  transform: (body: string) => string,
): ReviewConversationSnapshot {
  return {
    digest: snapshot.digest,
    entries: snapshot.entries.map((entry): ReviewConversationEntry => {
      if (entry.kind === "inline_thread") {
        return {
          ...entry,
          messages: entry.messages.map((message) => mapMessage(message, transform)),
        };
      }
      return { ...entry, message: mapMessage(entry.message, transform) };
    }),
  };
}

export const reviewContextInternals = {
  ACTION_MARKER,
  authorRole,
  conversationDigest,
  entrySort,
  messageSort,
};
