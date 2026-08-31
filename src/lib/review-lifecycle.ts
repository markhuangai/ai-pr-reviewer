import { createHash } from "node:crypto";

import * as core from "@actions/core";

import type {
  ReviewLifecycleReviewRecord,
  ReviewLifecycleSnapshot,
  ReviewLifecycleThreadRecord,
} from "./github-review-lifecycle.js";
import type { GitHubApi } from "./github-api.js";
import type { PullRequestContext, ReviewConfig } from "./types.js";
import {
  runResolutionVerifiers,
  type ResolutionQuery,
  type ResolutionVerification,
} from "../runtime/resolution-session.js";

const ACTION_REVIEW_MARKER =
  /<!--\s*ai-pr-reviewer:v3:((?:[0-9a-f]{40}|[0-9a-f]{64})):[0-9a-f]{64}\s*-->/iu;
const FIXED_REPLY_MARKER = /<!--\s*ai-pr-reviewer:fixed:v1:((?:[0-9a-f]{40}|[0-9a-f]{64}))\s*-->/iu;

export interface ActionReviewIdentity {
  readonly headSha: string;
}

export interface ReviewLifecycleCandidate {
  readonly thread: ReviewLifecycleThreadRecord;
  readonly review: ReviewLifecycleReviewRecord;
  readonly sourceHeadSha: string;
  readonly revision: string;
}

export interface ReviewLifecyclePreparation {
  readonly snapshot: ReviewLifecycleSnapshot;
  readonly candidates: readonly ReviewLifecycleCandidate[];
  readonly deletedCleanReviewIds: readonly number[];
}

export interface ReviewLifecycleResult {
  readonly resolvedThreadIds: readonly string[];
  readonly minimizedReviewIds: readonly number[];
}

export interface ReviewLifecycleApi {
  getReviewLifecycleSnapshot(context: PullRequestContext): Promise<ReviewLifecycleSnapshot>;
  deleteSubmittedReview(reviewNodeId: string): Promise<void>;
  addReviewThreadReply(threadNodeId: string, body: string): Promise<void>;
  resolveReviewThread(threadNodeId: string): Promise<void>;
  minimizeComment(subjectNodeId: string): Promise<void>;
}

function sameLogin(left: string | undefined, right: string): boolean {
  return left !== undefined && left.toLowerCase() === right.toLowerCase();
}

export function parseActionReviewIdentity(body: string): ActionReviewIdentity | undefined {
  const match = ACTION_REVIEW_MARKER.exec(body);
  return match?.[1] === undefined ? undefined : { headSha: match[1] };
}

export function isActionOwnedReview(
  review: Pick<ReviewLifecycleReviewRecord, "author" | "body">,
  authenticatedLogin: string,
): boolean {
  return (
    sameLogin(review.author?.login, authenticatedLogin) &&
    parseActionReviewIdentity(review.body) !== undefined
  );
}

export function isCleanActionReview(
  review: ReviewLifecycleReviewRecord,
  context: PullRequestContext,
  authenticatedLogin: string,
): boolean {
  const identity = parseActionReviewIdentity(review.body);
  return (
    identity !== undefined &&
    isActionOwnedReview(review, authenticatedLogin) &&
    (review.state === "COMMENTED" || review.state === "APPROVED") &&
    review.commitId !== null &&
    review.commitId.toLowerCase() === identity.headSha.toLowerCase() &&
    identity.headSha.toLowerCase() !== context.headSha.toLowerCase() &&
    review.body.includes("## ✨ Good job!") &&
    !review.body.includes("### Findings")
  );
}

export function isFindingActionReview(
  review: ReviewLifecycleReviewRecord,
  context: PullRequestContext,
  authenticatedLogin: string,
): boolean {
  const identity = parseActionReviewIdentity(review.body);
  return (
    identity !== undefined &&
    isActionOwnedReview(review, authenticatedLogin) &&
    review.commitId !== null &&
    review.commitId.toLowerCase() === identity.headSha.toLowerCase() &&
    identity.headSha.toLowerCase() !== context.headSha.toLowerCase() &&
    review.body.includes("## 🔎 AI review")
  );
}

function threadRoot(thread: ReviewLifecycleThreadRecord) {
  return thread.comments.find((comment) => comment.replyToId === undefined) ?? thread.comments[0];
}

function threadRevision(thread: ReviewLifecycleThreadRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        nodeId: thread.nodeId,
        path: thread.path,
        line: thread.line,
        originalLine: thread.originalLine,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        comments: thread.comments.map((comment) => ({
          nodeId: comment.nodeId,
          body: comment.body,
          authorLogin: comment.author?.login,
          authorType: comment.author?.type,
          commitId: comment.commitId,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          reviewId: comment.reviewId,
          replyToId: comment.replyToId,
        })),
      }),
    )
    .digest("hex");
}

function threadRevisionWithoutOwnedFixedReplies(
  thread: ReviewLifecycleThreadRecord,
  headSha: string,
  authenticatedLogin: string,
): string {
  const comments = thread.comments.filter(
    (comment) =>
      !(
        comment.replyToId !== undefined &&
        sameLogin(comment.author?.login, authenticatedLogin) &&
        FIXED_REPLY_MARKER.exec(comment.body)?.[1]?.toLowerCase() === headSha.toLowerCase()
      ),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        nodeId: thread.nodeId,
        path: thread.path,
        line: thread.line,
        originalLine: thread.originalLine,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        comments,
      }),
    )
    .digest("hex");
}

function threadBelongsToReview(
  thread: ReviewLifecycleThreadRecord,
  review: ReviewLifecycleReviewRecord,
  authenticatedLogin: string,
): boolean {
  const root = threadRoot(thread);
  return (
    thread.reviewId === review.databaseId &&
    thread.reviewNodeId === review.nodeId &&
    sameLogin(root?.author?.login, authenticatedLogin)
  );
}

export function selectUnresolvedActionThreads(
  snapshot: ReviewLifecycleSnapshot,
  context: PullRequestContext,
  authenticatedLogin: string,
): readonly ReviewLifecycleCandidate[] {
  const candidates: ReviewLifecycleCandidate[] = [];
  for (const thread of snapshot.threads) {
    if (thread.isResolved) continue;
    const review = snapshot.reviews.find((item) => item.databaseId === thread.reviewId);
    if (review === undefined || !isFindingActionReview(review, context, authenticatedLogin))
      continue;
    if (!threadBelongsToReview(thread, review, authenticatedLogin)) continue;
    const identity = parseActionReviewIdentity(review.body);
    if (identity === undefined) continue;
    candidates.push({
      thread,
      review,
      sourceHeadSha: identity.headSha,
      revision: threadRevision(thread),
    });
  }
  return candidates;
}

export function fixedReplyBody(headSha: string): string {
  return [
    `Fixed in \`${headSha}\`: a fresh AI inspection found that the original failure path is no longer present at this head.`,
    "",
    `<!-- ai-pr-reviewer:fixed:v1:${headSha} -->`,
  ].join("\n");
}

export async function prepareReviewLifecycle(
  api: ReviewLifecycleApi,
  context: PullRequestContext,
  authenticatedLogin: string,
): Promise<ReviewLifecyclePreparation> {
  const snapshot = await api.getReviewLifecycleSnapshot(context);
  const staleCleanReviews = snapshot.reviews.filter((review) =>
    isCleanActionReview(review, context, authenticatedLogin),
  );
  for (const review of staleCleanReviews) await api.deleteSubmittedReview(review.nodeId);
  return {
    snapshot,
    candidates: selectUnresolvedActionThreads(snapshot, context, authenticatedLogin),
    deletedCleanReviewIds: staleCleanReviews.map((review) => review.databaseId),
  };
}

function hasFixedReply(
  thread: ReviewLifecycleThreadRecord,
  headSha: string,
  authenticatedLogin: string,
): boolean {
  return thread.comments.some((comment) => {
    const marker = FIXED_REPLY_MARKER.exec(comment.body);
    return (
      marker?.[1]?.toLowerCase() === headSha.toLowerCase() &&
      comment.replyToId !== undefined &&
      sameLogin(comment.author?.login, authenticatedLogin)
    );
  });
}

function onlyExpectedFixedReply(
  before: ReviewLifecycleThreadRecord,
  after: ReviewLifecycleThreadRecord,
  headSha: string,
  authenticatedLogin: string,
): boolean {
  const beforeFixedReplies = before.comments.filter(
    (comment) =>
      comment.replyToId !== undefined &&
      sameLogin(comment.author?.login, authenticatedLogin) &&
      FIXED_REPLY_MARKER.exec(comment.body)?.[1]?.toLowerCase() === headSha.toLowerCase(),
  ).length;
  const afterFixedReplies = after.comments.filter(
    (comment) =>
      comment.replyToId !== undefined &&
      sameLogin(comment.author?.login, authenticatedLogin) &&
      FIXED_REPLY_MARKER.exec(comment.body)?.[1]?.toLowerCase() === headSha.toLowerCase(),
  ).length;
  return (
    !after.isResolved &&
    afterFixedReplies === beforeFixedReplies + 1 &&
    threadRevisionWithoutOwnedFixedReplies(before, headSha, authenticatedLogin) ===
      threadRevisionWithoutOwnedFixedReplies(after, headSha, authenticatedLogin)
  );
}

export async function resolveReviewLifecycle(
  api: ReviewLifecycleApi,
  preparation: ReviewLifecyclePreparation,
  context: PullRequestContext,
  authenticatedLogin: string,
  config: ReviewConfig,
  cwd: string,
  queryAgent?: ResolutionQuery,
  abortController?: AbortController,
  verify = runResolutionVerifiers,
): Promise<readonly string[]> {
  if (preparation.candidates.length === 0) return [];
  const verifications = await verify(
    context,
    preparation.candidates.map((candidate) => candidate.thread),
    config,
    cwd,
    queryAgent,
    abortController,
  );
  const resolvedThreadIds: string[] = [];
  for (let index = 0; index < preparation.candidates.length; index += 1) {
    const candidate = preparation.candidates[index];
    const verification = verifications[index];
    if (
      candidate === undefined ||
      verification === undefined ||
      !isHighConfidenceFixed(verification)
    ) {
      continue;
    }
    let latest = await api.getReviewLifecycleSnapshot(context);
    let currentThread = latest.threads.find((thread) => thread.nodeId === candidate.thread.nodeId);
    let currentReview = latest.reviews.find(
      (review) => review.databaseId === candidate.review.databaseId,
    );
    if (
      currentThread === undefined ||
      currentReview === undefined ||
      currentThread.isResolved ||
      threadRevision(currentThread) !== candidate.revision ||
      !isFindingActionReview(currentReview, context, authenticatedLogin) ||
      !threadBelongsToReview(currentThread, currentReview, authenticatedLogin)
    ) {
      continue;
    }
    if (!hasFixedReply(currentThread, context.headSha, authenticatedLogin)) {
      const beforeReplyThread = currentThread;
      await api.addReviewThreadReply(currentThread.nodeId, fixedReplyBody(context.headSha));
      latest = await api.getReviewLifecycleSnapshot(context);
      currentThread = latest.threads.find((thread) => thread.nodeId === candidate.thread.nodeId);
      currentReview = latest.reviews.find(
        (review) => review.databaseId === candidate.review.databaseId,
      );
      if (
        currentThread === undefined ||
        currentReview === undefined ||
        currentThread.isResolved ||
        !isFindingActionReview(currentReview, context, authenticatedLogin) ||
        !threadBelongsToReview(currentThread, currentReview, authenticatedLogin) ||
        !onlyExpectedFixedReply(
          beforeReplyThread,
          currentThread,
          context.headSha,
          authenticatedLogin,
        )
      ) {
        continue;
      }
    }
    const beforeResolve = await api.getReviewLifecycleSnapshot(context);
    const resolveThread = beforeResolve.threads.find(
      (thread) => thread.nodeId === candidate.thread.nodeId,
    );
    const resolveReview = beforeResolve.reviews.find(
      (review) => review.databaseId === candidate.review.databaseId,
    );
    if (
      resolveThread === undefined ||
      resolveReview === undefined ||
      resolveThread.isResolved ||
      threadRevision(resolveThread) !== threadRevision(currentThread) ||
      !isFindingActionReview(resolveReview, context, authenticatedLogin) ||
      !threadBelongsToReview(resolveThread, resolveReview, authenticatedLogin)
    ) {
      continue;
    }
    await api.resolveReviewThread(resolveThread.nodeId);
    resolvedThreadIds.push(resolveThread.nodeId);
  }
  return resolvedThreadIds;
}

function isHighConfidenceFixed(verification: ResolutionVerification): boolean {
  return (
    verification.status === "completed" &&
    verification.verdict === "fixed" &&
    verification.confidence === "high"
  );
}

export async function finalizeReviewLifecycle(
  api: ReviewLifecycleApi,
  context: PullRequestContext,
  authenticatedLogin: string,
): Promise<readonly number[]> {
  const snapshot = await api.getReviewLifecycleSnapshot(context);
  const minimized: number[] = [];
  for (const review of snapshot.reviews) {
    if (
      review.isMinimized ||
      !isFindingActionReview(review, context, authenticatedLogin) ||
      review.body.includes("### Findings")
    ) {
      continue;
    }
    const threads = snapshot.threads.filter((thread) => thread.reviewId === review.databaseId);
    if (threads.length === 0 || threads.some((thread) => !thread.isResolved)) continue;
    await api.minimizeComment(review.nodeId);
    minimized.push(review.databaseId);
  }
  return minimized;
}

export function isReviewLifecycleApi(value: GitHubApi): value is GitHubApi & ReviewLifecycleApi {
  return (
    typeof (value as Partial<ReviewLifecycleApi>).getReviewLifecycleSnapshot === "function" &&
    typeof (value as Partial<ReviewLifecycleApi>).deleteSubmittedReview === "function" &&
    typeof (value as Partial<ReviewLifecycleApi>).addReviewThreadReply === "function" &&
    typeof (value as Partial<ReviewLifecycleApi>).resolveReviewThread === "function" &&
    typeof (value as Partial<ReviewLifecycleApi>).minimizeComment === "function"
  );
}

export function logLifecycleResult(result: ReviewLifecycleResult): void {
  if (result.resolvedThreadIds.length > 0) {
    core.info(
      `Resolved ${result.resolvedThreadIds.length} stale AI review thread${result.resolvedThreadIds.length === 1 ? "" : "s"}.`,
    );
  }
  if (result.minimizedReviewIds.length > 0) {
    core.info(
      `Minimized ${result.minimizedReviewIds.length} superseded AI review${result.minimizedReviewIds.length === 1 ? "" : "s"}.`,
    );
  }
}

export const reviewLifecycleInternals = {
  ACTION_REVIEW_MARKER,
  FIXED_REPLY_MARKER,
  isHighConfidenceFixed,
  threadRevision,
  threadRevisionWithoutOwnedFixedReplies,
  onlyExpectedFixedReply,
  threadRoot,
};
