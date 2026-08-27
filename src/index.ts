import { execFile } from "node:child_process";
import { promisify } from "node:util";

import * as core from "@actions/core";

import {
  aggregateReview,
  buildReviewRequest,
  buildRunSummary,
  reviewMarker,
} from "./lib/aggregate.js";
import { throwIfAborted } from "./lib/bootstrap/cancellation.js";
import { prepareContextFiles, type ContextFileArtifact } from "./lib/context-files.js";
import { GitHubApi, GitHubApiError, readPullRequestFilesFromCheckout } from "./lib/github-api.js";
import {
  parsePullRequestUrl,
  readPullRequestContext,
  readPullRequestEventContext,
  samePullRequest,
} from "./lib/github-event.js";
import {
  inputSecretCandidates,
  readReviewConfig,
  reviewSecretCandidates,
  type InputReader,
} from "./lib/input.js";
import {
  buildReviewConversation,
  mapConversationBodies,
  type ReviewConversationSnapshot,
} from "./lib/review-context.js";
import { emptyReviewBriefing, reviewBriefingDigest } from "./lib/review-evidence.js";
import { runReviewGoals } from "./runtime/agent.js";
import {
  createPullRequestWorkspace,
  type PullRequestWorkspace,
} from "./lib/pull-request-workspace.js";
import type {
  GoalResult,
  PullRequestContext,
  PullRequestReviewRequest,
  ReviewBriefing,
  ReviewRunResult,
} from "./lib/types.js";

const execFileAsync = promisify(execFile);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactSecret(value: string, secret: string): string {
  if (secret.length < 8 && /^[A-Za-z0-9]+$/.test(secret)) {
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(secret)}(?![A-Za-z0-9])`, "g");
    return value.replace(pattern, "[REDACTED]");
  }
  return value.split(secret).join("[REDACTED]");
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => redactSecret(result, secret), value);
}

function redactGoals(
  goals: readonly GoalResult[],
  secrets: readonly string[],
): readonly GoalResult[] {
  return goals.map((goal) => ({
    ...goal,
    ...(goal.error === undefined ? {} : { error: redact(goal.error, secrets) }),
    ...(goal.tokenUsage === undefined
      ? {}
      : {
          tokenUsage: {
            ...goal.tokenUsage,
            models: goal.tokenUsage.models.map((usage) => ({
              ...usage,
              model: redact(usage.model, secrets),
              ...(usage.canonicalModel === undefined
                ? {}
                : { canonicalModel: redact(usage.canonicalModel, secrets) }),
            })),
          },
        }),
    ...(goal.submission === undefined
      ? {}
      : {
          submission: {
            summary: redact(goal.submission.summary, secrets),
            findings: goal.submission.findings.map((finding) => ({
              ...finding,
              title: redact(finding.title, secrets),
              body: redact(finding.body, secrets),
              ...(finding.agentPrompt === undefined
                ? {}
                : { agentPrompt: redact(finding.agentPrompt, secrets) }),
            })),
          },
        }),
  }));
}

function redactRequest(
  request: PullRequestReviewRequest,
  secrets: readonly string[],
): PullRequestReviewRequest {
  return {
    ...request,
    body: redact(request.body, secrets),
    comments: request.comments.map((comment) => ({
      ...comment,
      body: redact(comment.body, secrets),
    })),
  };
}

function isApprovalRejection(error: unknown): error is GitHubApiError {
  return (
    error instanceof GitHubApiError &&
    error.status === 422 &&
    /\bapprov(?:e|al|ed|ing)\b/i.test(error.message)
  );
}

interface LoadedConversation {
  readonly reviews: Awaited<ReturnType<GitHubApi["listReviews"]>>;
  readonly snapshot: ReviewConversationSnapshot;
}

async function loadConversation(
  api: GitHubApi,
  context: PullRequestContext,
  authenticatedLogin: string,
): Promise<LoadedConversation> {
  const [reviews, reviewComments, issueComments] = await Promise.all([
    api.listReviews(context),
    api.listReviewComments(context),
    api.listIssueComments(context),
  ]);
  return {
    reviews,
    snapshot: buildReviewConversation(authenticatedLogin, reviews, reviewComments, issueComments),
  };
}

async function assertWorkspace(
  context: PullRequestContext,
  cwd: string = process.env.GITHUB_WORKSPACE ?? process.cwd(),
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  let head: string;
  try {
    ({ stdout: head } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      ...(signal === undefined ? {} : { signal }),
    }));
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  throwIfAborted(signal);
  if (head.trim() !== context.headSha) {
    throw new Error(
      `Workspace HEAD ${head.trim()} does not match pull request head ${context.headSha}; refusing to review a mismatched checkout.`,
    );
  }
  let status: string;
  try {
    ({ stdout: status } = await execFileAsync("git", ["status", "--porcelain", "--ignored"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      ...(signal === undefined ? {} : { signal }),
    }));
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  throwIfAborted(signal);
  if (status.trim().length > 0) {
    throw new Error(
      "The checked-out workspace has tracked, untracked, or ignored content; refusing to review it.",
    );
  }
}

async function writeRunSummary(
  context: PullRequestContext,
  review: NonNullable<ReviewRunResult["review"]>,
  goals: readonly GoalResult[],
): Promise<void> {
  await core.summary.addRaw(buildRunSummary(context, review, goals), true).write();
}

function actionInputReader(): InputReader {
  return { get: (name) => core.getInput(name) };
}

function registerInputSecrets(secrets: readonly string[]): void {
  for (const secret of new Set(secrets)) if (secret.length > 0) core.setSecret(secret);
}

async function cleanupReviewArtifacts(
  contextFiles: Pick<ContextFileArtifact, "cleanup"> | undefined,
  temporaryWorkspace: Pick<PullRequestWorkspace, "cleanup"> | undefined,
): Promise<void> {
  const cleanups = await Promise.allSettled([
    contextFiles?.cleanup(),
    temporaryWorkspace?.cleanup(),
  ]);
  const failure = cleanups.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export async function runAction(
  reader: InputReader = actionInputReader(),
  inputSecrets: readonly string[] = inputSecretCandidates(reader),
  dependencies: ActionDependencies = defaultActionDependencies,
  abortController = new AbortController(),
): Promise<ReviewRunResult> {
  const { signal } = abortController;
  throwIfAborted(signal);
  registerInputSecrets(inputSecrets);
  const config = readReviewConfig(reader);
  const secrets = reviewSecretCandidates(config);
  registerInputSecrets(secrets);
  const api = dependencies.createApi(config.githubToken, signal);
  const eventContext = await dependencies.readEventContext(signal);
  throwIfAborted(signal);
  const locator =
    config.pullRequestUrl === undefined ? undefined : parsePullRequestUrl(config.pullRequestUrl);
  if (
    eventContext !== undefined &&
    locator !== undefined &&
    !samePullRequest(eventContext, locator)
  ) {
    throw new Error(
      "Input 'pull-request-url' must identify the pull request that triggered this workflow.",
    );
  }
  const context =
    locator === undefined
      ? (eventContext ?? (await readPullRequestContext(undefined, undefined, signal)))
      : await api.getPullRequestContext(locator);
  throwIfAborted(signal);
  const temporaryWorkspace =
    locator === undefined
      ? undefined
      : await dependencies.createWorkspace(
          context,
          config.githubToken,
          undefined,
          undefined,
          signal,
        );
  const workspace = temporaryWorkspace?.path ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
  let contextFiles: ContextFileArtifact | undefined;
  try {
    throwIfAborted(signal);
    await assertWorkspace(context, workspace, signal);
    contextFiles = await (dependencies.prepareContextFiles ?? prepareContextFiles)(
      config.reviewPrompts,
      workspace,
      undefined,
      signal,
    );
    throwIfAborted(signal);
    const authenticatedLogin = await api.getAuthenticatedUserLogin();
    const conversation = await loadConversation(api, context, authenticatedLogin);
    const briefing =
      typeof (api as GitHubApi & { getLinkedIssues?: unknown }).getLinkedIssues === "function"
        ? await api.getLinkedIssues(context)
        : emptyReviewBriefing();
    throwIfAborted(signal);
    if (config.interactWithPullRequest) {
      const marker = reviewMarker(
        context,
        config,
        conversation.snapshot.digest,
        contextFiles.identity,
        reviewBriefingDigest(context, briefing),
      );
      if (
        conversation.reviews.some(
          (review) =>
            review.author?.login.toLowerCase() === authenticatedLogin.toLowerCase() &&
            review.state !== "DISMISSED" &&
            review.commitId === context.headSha &&
            review.body.includes(marker),
        )
      ) {
        core.info("An identical review already exists for this pull request head; skipping.");
        return { skipped: true };
      }
    }

    await assertWorkspace(context, workspace, signal);
    const files = await (dependencies.readFiles ?? readPullRequestFilesFromCheckout)(
      context,
      workspace,
      signal,
    );
    throwIfAborted(signal);
    core.info(
      `Reviewing ${files.length} changed file${files.length === 1 ? "" : "s"} and ${conversation.snapshot.entries.length} conversation entr${conversation.snapshot.entries.length === 1 ? "y" : "ies"} with ${config.reviewPrompts.length} isolated goal session${config.reviewPrompts.length === 1 ? "" : "s"}.`,
    );
    const redactedConversation = mapConversationBodies(conversation.snapshot, (body) =>
      redact(body, secrets),
    );
    const redactedContext: PullRequestContext = {
      ...context,
      title: redact(context.title, secrets),
      ...(context.body === undefined ? {} : { body: redact(context.body, secrets) }),
    };
    const redactedBriefing: ReviewBriefing = {
      linkedIssueReferencesTruncated: briefing.linkedIssueReferencesTruncated,
      linkedIssues: briefing.linkedIssues.map((issue) => ({
        ...issue,
        title: redact(issue.title, secrets),
        body: redact(issue.body, secrets),
      })),
    };
    const rawGoals = await dependencies.runGoals(
      redactedContext,
      files,
      redactedConversation,
      config,
      contextFiles.filesByGoal,
      workspace,
      undefined,
      abortController,
      redactedBriefing,
    );
    throwIfAborted(signal);
    const goals = redactGoals(rawGoals, secrets);
    const review = aggregateReview(
      context,
      config,
      files,
      goals,
      conversation.snapshot.digest,
      contextFiles.identity,
      reviewBriefingDigest(context, briefing),
    );
    if (!config.interactWithPullRequest) {
      await assertWorkspace(context, workspace, signal);
      throwIfAborted(signal);
      await dependencies.writeSummary(context, review, goals);
      throwIfAborted(signal);
      if (review.allGoalsFailed) {
        throw new Error("All review goals failed; the result was written to the run summary.");
      }
      if (review.partial) {
        throw new Error(
          "The review was written as a partial result, but one or more goals failed.",
        );
      }
      return { skipped: false, review };
    }
    if (review.allGoalsFailed) {
      await assertWorkspace(context, workspace, signal);
      throwIfAborted(signal);
      await dependencies.writeSummary(context, review, goals);
      throwIfAborted(signal);
      throw new Error(
        "All review goals failed; no pull request review was posted, and the result was written to the run summary.",
      );
    }

    let request = redactRequest(buildReviewRequest(context, review, goals), secrets);
    await assertWorkspace(context, workspace, signal);
    throwIfAborted(signal);
    if (request.event === "APPROVE") {
      const liveRefs = await api.getPullRequestRefs(context);
      throwIfAborted(signal);
      if (liveRefs.headSha !== context.headSha || liveRefs.baseSha !== context.baseSha) {
        core.warning(
          "The pull request refs changed after capture; posting this captured review as a comment instead of an approval.",
        );
        request = {
          ...request,
          event: "COMMENT",
          body: `${request.body}\n\n> The pull request refs changed after capture, so this review was posted as a comment.`,
        };
      }
    }
    try {
      await api.createReview(context, request);
      throwIfAborted(signal);
    } catch (error) {
      throwIfAborted(signal);
      if (request.event !== "APPROVE" || !isApprovalRejection(error)) throw error;
      core.warning("GitHub rejected the approval review; retrying as a comment review.");
      await assertWorkspace(context, workspace, signal);
      throwIfAborted(signal);
      await api.createReview(context, {
        ...request,
        event: "COMMENT",
        body: `${request.body}\n\n> GitHub rejected the requested approval, so this result was posted as a comment.`,
      });
      throwIfAborted(signal);
    }
    if (review.partial)
      throw new Error("The review was posted as a partial result, but one or more goals failed.");
    return { skipped: false, review };
  } finally {
    await cleanupReviewArtifacts(contextFiles, temporaryWorkspace);
  }
}

interface ActionDependencies {
  readonly createApi: (token: string, signal?: AbortSignal) => GitHubApi;
  readonly readEventContext: (signal?: AbortSignal) => Promise<PullRequestContext | undefined>;
  readonly createWorkspace: typeof createPullRequestWorkspace;
  readonly readFiles?: typeof readPullRequestFilesFromCheckout;
  readonly prepareContextFiles?: typeof prepareContextFiles;
  readonly runGoals: typeof runReviewGoals;
  readonly writeSummary: typeof writeRunSummary;
}

const defaultActionDependencies: ActionDependencies = {
  createApi: (token, signal) =>
    new GitHubApi(token, process.env.GITHUB_API_URL ?? "https://api.github.com", signal),
  readEventContext: (signal) => readPullRequestEventContext(undefined, undefined, signal),
  createWorkspace: createPullRequestWorkspace,
  readFiles: readPullRequestFilesFromCheckout,
  runGoals: runReviewGoals,
  writeSummary: writeRunSummary,
};

export async function main(abortController = new AbortController()): Promise<void> {
  let inputSecrets: readonly string[] = [];
  try {
    const reader = actionInputReader();
    inputSecrets = inputSecretCandidates(reader);
    await runAction(reader, inputSecrets, defaultActionDependencies, abortController);
  } catch (error) {
    if (abortController.signal.aborted) {
      core.info("Pull request review cancelled; no new review or run summary will be published.");
      return;
    }
    const environmentInputSecrets = Object.entries(process.env)
      .filter(([key]) => key.startsWith("INPUT_"))
      .map(([, value]) => value ?? "");
    core.setFailed(redact(errorMessage(error), [...inputSecrets, ...environmentInputSecrets]));
  }
}

export const indexInternals = {
  assertWorkspace,
  loadConversation,
  writeRunSummary,
  inputSecretCandidates,
  redact,
  redactGoals,
  cleanupReviewArtifacts,
  reviewSecrets: reviewSecretCandidates,
};
