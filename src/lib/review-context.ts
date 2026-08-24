import { createHash } from "node:crypto";

import type {
  ExistingReview,
  GitHubCommentAuthor,
  PullRequestIssueCommentRecord,
  PullRequestReviewCommentRecord,
} from "./github-api.js";

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
  readonly rootAvailable: boolean;
  readonly createdAt: string;
  readonly path: string;
  readonly line?: number;
  readonly originalLine?: number;
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

function reviewMessage(review: ExistingReview, authenticatedLogin: string): ConversationMessage {
  const actionAuthored =
    review.author !== undefined &&
    sameLogin(review.author.login, authenticatedLogin) &&
    ACTION_MARKER.test(review.body);
  return {
    id: review.id,
    ...messageAuthor(review.author),
    authorRole: authorRole(review.author, authenticatedLogin, false, actionAuthored),
    body: review.body,
    createdAt: review.submittedAt ?? "",
    updatedAt: review.submittedAt ?? "",
    commitId: review.commitId,
  };
}

function reviewCommentMessage(
  comment: PullRequestReviewCommentRecord,
  authenticatedLogin: string,
  actionReviewIds: ReadonlySet<number>,
): ConversationMessage {
  return {
    id: comment.id,
    ...(comment.reviewId === undefined ? {} : { reviewId: comment.reviewId }),
    ...(comment.inReplyToId === undefined ? {} : { inReplyToId: comment.inReplyToId }),
    ...messageAuthor(comment.author),
    authorRole: authorRole(
      comment.author,
      authenticatedLogin,
      false,
      comment.inReplyToId === undefined &&
        comment.reviewId !== undefined &&
        actionReviewIds.has(comment.reviewId),
    ),
    body: comment.body,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    commitId: comment.commitId,
    originalCommitId: comment.originalCommitId,
    path: comment.path,
    ...(comment.line === undefined ? {} : { line: comment.line }),
    ...(comment.originalLine === undefined ? {} : { originalLine: comment.originalLine }),
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

function conversationDigest(entries: readonly ReviewConversationEntry[]): string {
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function buildReviewConversation(
  authenticatedLogin: string,
  reviews: readonly ExistingReview[],
  reviewComments: readonly PullRequestReviewCommentRecord[],
  issueComments: readonly PullRequestIssueCommentRecord[],
): ReviewConversationSnapshot {
  const actionReviewIds = new Set(
    reviews
      .filter(
        (review) =>
          review.author !== undefined &&
          sameLogin(review.author.login, authenticatedLogin) &&
          ACTION_MARKER.test(review.body),
      )
      .map((review) => review.id),
  );
  const threads = new Map<number, ConversationMessage[]>();
  for (const comment of reviewComments) {
    const rootId = comment.inReplyToId ?? comment.id;
    const messages = threads.get(rootId) ?? [];
    messages.push(reviewCommentMessage(comment, authenticatedLogin, actionReviewIds));
    threads.set(rootId, messages);
  }

  const entries: ReviewConversationEntry[] = [];
  for (const [rootId, unsorted] of threads) {
    const messages = [...unsorted].sort(messageSort);
    if (
      !messages.some((message) => message.authorRole !== "workflow" && message.body.trim() !== "")
    )
      continue;
    const root = messages.find((message) => message.id === rootId);
    const location = root ?? messages[0];
    if (location === undefined || location.path === undefined) continue;
    entries.push({
      kind: "inline_thread",
      id: rootId,
      rootAvailable: root !== undefined,
      createdAt: root?.createdAt ?? location.createdAt,
      path: location.path,
      ...(location.line === undefined ? {} : { line: location.line }),
      ...(location.originalLine === undefined ? {} : { originalLine: location.originalLine }),
      messages,
    });
  }

  for (const review of reviews) {
    const message = reviewMessage(review, authenticatedLogin);
    if (message.authorRole === "workflow" || message.body.trim().length === 0) continue;
    entries.push({
      kind: "review_body",
      id: review.id,
      createdAt: message.createdAt,
      state: review.state,
      commitId: review.commitId,
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
  return { digest: conversationDigest(entries), entries };
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
