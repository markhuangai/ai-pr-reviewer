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
import { redact } from "./lib/redaction.js";
import { DiagnosticLogger, type DiagnosticDescriptor } from "./lib/diagnostics.js";
import { emptyReviewBriefing, reviewBriefingDigest } from "./lib/review-evidence.js";
import {
  finalizeReviewLifecycle,
  isReviewLifecycleApi,
  logLifecycleResult,
  prepareReviewLifecycle,
  resolveReviewLifecycle,
  type ReviewLifecyclePreparation,
} from "./lib/review-lifecycle.js";
import { runReviewGoals } from "./runtime/agent.js";
import { runResolutionVerifiers, type ResolutionQuery } from "./runtime/resolution-session.js";
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

function actionDiagnosticContext(): Readonly<Record<string, unknown>> {
  const context: Record<string, string> = {};
  for (const [field, environmentKey] of [
    ["run_id", "GITHUB_RUN_ID"],
    ["run_attempt", "GITHUB_RUN_ATTEMPT"],
    ["job", "GITHUB_JOB"],
    ["action_ref", "GITHUB_ACTION_REF"],
    ["build_id", "AI_PR_REVIEWER_BUILD_ID"],
  ] as const) {
    const value = process.env[environmentKey];
    if (value !== undefined && value.length > 0) context[field] = value;
  }
  return context;
}

function actionDescriptor(phase: string, operation: string, purpose: string): DiagnosticDescriptor {
  return { component: "action", phase, operation, purpose };
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
  diagnostics?: DiagnosticLogger,
): Promise<void> {
  const cleanup = async (
    artifact: Pick<ContextFileArtifact, "cleanup"> | Pick<PullRequestWorkspace, "cleanup">,
    operation: string,
    purpose: string,
  ): Promise<void> => {
    const action = () => artifact.cleanup();
    if (diagnostics === undefined) {
      await action();
      return;
    }
    await diagnostics.withSpan(actionDescriptor("cleanup", operation, purpose), action);
  };
  const cleanups = await Promise.allSettled(
    [
      contextFiles === undefined
        ? undefined
        : cleanup(
            contextFiles,
            "action.context.cleanup",
            "remove captured workflow context snapshots",
          ),
      temporaryWorkspace === undefined
        ? undefined
        : cleanup(
            temporaryWorkspace,
            "action.workspace.cleanup",
            "remove the isolated pull request checkout",
          ),
    ].filter((promise): promise is Promise<void> => promise !== undefined),
  );
  const failure = cleanups.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

export async function runAction(
  reader: InputReader = actionInputReader(),
  inputSecrets?: readonly string[],
  dependencies: ActionDependencies = defaultActionDependencies,
  abortController = new AbortController(),
  diagnostics = new DiagnosticLogger({
    component: "action",
    context: actionDiagnosticContext(),
  }),
): Promise<ReviewRunResult> {
  const environmentInputSecrets = Object.entries(process.env)
    .filter(([key]) => key.startsWith("INPUT_"))
    .map(([, value]) => value ?? "");
  const readerInputSecrets = inputSecretCandidates(reader);
  const discoveredInputSecrets = [
    ...environmentInputSecrets,
    ...readerInputSecrets,
    ...(inputSecrets ?? []),
  ];
  diagnostics.addSecrets(discoveredInputSecrets);
  registerInputSecrets([...readerInputSecrets, ...(inputSecrets ?? [])]);
  const runSpan = diagnostics.start(
    actionDescriptor("action", "action.run", "execute one pull request review run"),
  );
  try {
    const { signal } = abortController;
    throwIfAborted(signal);
    const config = await diagnostics.withSpan(
      actionDescriptor("configuration", "action.config.read", "read and validate action inputs"),
      () => readReviewConfig(reader),
    );
    const secrets = reviewSecretCandidates(config);
    diagnostics.addSecrets(secrets);
    registerInputSecrets(secrets);
    const api = await diagnostics.withSpan(
      actionDescriptor(
        "configuration",
        "action.github-api.create",
        "initialize the GitHub API client",
      ),
      () => dependencies.createApi(config.githubToken, signal, diagnostics),
    );
    const eventContext = await diagnostics.withSpan(
      actionDescriptor("target", "action.event.read", "read the pull request event context"),
      () => dependencies.readEventContext(signal),
    );
    throwIfAborted(signal);
    const locator = await diagnostics.withSpan(
      actionDescriptor(
        "target",
        "action.pull-request-url.parse",
        "parse the optional pull request URL",
      ),
      () =>
        config.pullRequestUrl === undefined
          ? undefined
          : parsePullRequestUrl(config.pullRequestUrl),
      { provided: config.pullRequestUrl !== undefined },
    );
    await diagnostics.withSpan(
      actionDescriptor(
        "target",
        "action.pull-request.validate",
        "verify event and input target identity",
      ),
      () => {
        if (
          eventContext !== undefined &&
          locator !== undefined &&
          !samePullRequest(eventContext, locator)
        ) {
          throw new Error(
            "Input 'pull-request-url' must identify the pull request that triggered this workflow.",
          );
        }
      },
    );
    const context = await diagnostics.withSpan(
      actionDescriptor(
        "target",
        "action.pull-request.capture",
        "capture the immutable pull request context",
      ),
      () =>
        locator === undefined
          ? (eventContext ?? readPullRequestContext(undefined, undefined, signal))
          : api.getPullRequestContext(locator),
    );
    throwIfAborted(signal);
    const temporaryWorkspace =
      locator === undefined
        ? undefined
        : await diagnostics.withSpan(
            actionDescriptor(
              "workspace",
              "action.workspace.create",
              "create the isolated pull request checkout",
            ),
            () =>
              dependencies.createWorkspace(
                context,
                config.githubToken,
                undefined,
                undefined,
                signal,
              ),
          );
    const workspace = temporaryWorkspace?.path ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
    let contextFiles: ContextFileArtifact | undefined;
    let successDetails: Readonly<Record<string, unknown>> | undefined;
    try {
      throwIfAborted(signal);
      await diagnostics.withSpan(
        actionDescriptor(
          "workspace",
          "action.workspace.validate",
          "verify a pristine checkout at the captured head",
        ),
        () => assertWorkspace(context, workspace, signal),
      );
      const preparedContextFiles = await diagnostics.withSpan(
        actionDescriptor(
          "context",
          "action.context.prepare",
          "capture authorized immutable context files",
        ),
        () =>
          (dependencies.prepareContextFiles ?? prepareContextFiles)(
            config.reviewPrompts,
            workspace,
            undefined,
            signal,
          ),
      );
      contextFiles = preparedContextFiles;
      throwIfAborted(signal);
      const authenticatedLogin = await diagnostics.withSpan(
        actionDescriptor(
          "conversation",
          "action.identity.capture",
          "identify the authenticated GitHub user",
        ),
        () => api.getAuthenticatedUserLogin(),
      );
      let conversation = await diagnostics.withSpan(
        actionDescriptor(
          "conversation",
          "action.conversation.capture",
          "capture pull request reviews and comments",
        ),
        () => loadConversation(api, context, authenticatedLogin),
      );
      const lifecycleApi =
        config.interactWithPullRequest && isReviewLifecycleApi(api) ? api : undefined;
      const lifecyclePreparation: ReviewLifecyclePreparation | undefined =
        lifecycleApi === undefined
          ? undefined
          : await diagnostics.withSpan(
              actionDescriptor(
                "lifecycle",
                "action.lifecycle.prepare",
                "capture and prepare stale action-owned reviews",
              ),
              () => prepareReviewLifecycle(lifecycleApi, context, authenticatedLogin),
            );
      if (lifecyclePreparation?.reconciledCleanReviewIds.length) {
        core.info(
          `Reconciled ${lifecyclePreparation.reconciledCleanReviewIds.length} stale clean AI review${lifecyclePreparation.reconciledCleanReviewIds.length === 1 ? "" : "s"} before analysis.`,
        );
      }
      const briefing =
        typeof (api as GitHubApi & { getLinkedIssues?: unknown }).getLinkedIssues === "function"
          ? await diagnostics.withSpan(
              actionDescriptor(
                "briefing",
                "action.briefing.linked-issues",
                "load linked issue context for the review briefing",
              ),
              () => api.getLinkedIssues(context),
            )
          : emptyReviewBriefing();
      throwIfAborted(signal);
      let resolvedThreadIds: readonly string[] = [];
      if (lifecycleApi !== undefined && lifecyclePreparation !== undefined) {
        resolvedThreadIds = await diagnostics.withSpan(
          actionDescriptor(
            "lifecycle",
            "action.lifecycle.resolve",
            "verify and reconcile stale action-owned findings",
          ),
          () =>
            resolveReviewLifecycle(
              lifecycleApi,
              lifecyclePreparation,
              context,
              authenticatedLogin,
              config,
              workspace,
              dependencies.queryAgent,
              abortController,
              dependencies.runResolutionVerifiers,
            ),
        );
        if (resolvedThreadIds.length > 0) {
          core.info(
            `Resolved ${resolvedThreadIds.length} stale AI review thread${resolvedThreadIds.length === 1 ? "" : "s"} before posting the current review.`,
          );
        }
        if (lifecyclePreparation.candidates.length > 0) {
          conversation = await diagnostics.withSpan(
            actionDescriptor(
              "conversation",
              "action.conversation.reload",
              "reload pull request conversation after lifecycle mutations",
            ),
            () => loadConversation(api, context, authenticatedLogin),
          );
          throwIfAborted(signal);
        }
      }
      if (config.interactWithPullRequest) {
        const marker = reviewMarker(
          context,
          config,
          conversation.snapshot.digest,
          preparedContextFiles.identity,
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
          if (lifecycleApi !== undefined) {
            const minimizedReviewIds = await diagnostics.withSpan(
              actionDescriptor(
                "lifecycle",
                "action.lifecycle.finalize",
                "finalize superseded action-owned reviews after duplicate detection",
              ),
              () => finalizeReviewLifecycle(lifecycleApi, context, authenticatedLogin),
            );
            logLifecycleResult({ resolvedThreadIds: [], minimizedReviewIds });
          }
          core.info("An identical review already exists for this pull request head; skipping.");
          successDetails = { outcome: "skipped", reason: "identical current-head review" };
          return { skipped: true };
        }
      }

      await diagnostics.withSpan(
        actionDescriptor(
          "workspace",
          "action.workspace.revalidate",
          "revalidate the checkout before diff capture",
        ),
        () => assertWorkspace(context, workspace, signal),
      );
      const files = await diagnostics.withSpan(
        actionDescriptor(
          "diff",
          "action.diff.capture",
          "capture changed files from the verified checkout",
        ),
        () =>
          (dependencies.readFiles ?? readPullRequestFilesFromCheckout)(context, workspace, signal),
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
      const rawGoals = await diagnostics.withSpan(
        actionDescriptor(
          "review",
          "action.goals.run",
          "run isolated review goals over the captured evidence",
        ),
        () =>
          dependencies.runGoals(
            redactedContext,
            files,
            redactedConversation,
            config,
            preparedContextFiles.filesByGoal,
            workspace,
            undefined,
            abortController,
            redactedBriefing,
          ),
      );
      throwIfAborted(signal);
      const goals = await diagnostics.withSpan(
        actionDescriptor(
          "review",
          "action.goals.redact",
          "apply configured secret redaction to goal results",
        ),
        () => redactGoals(rawGoals, secrets),
      );
      const review = await diagnostics.withSpan(
        actionDescriptor(
          "review",
          "action.review.aggregate",
          "aggregate and validate goal review results",
        ),
        () =>
          aggregateReview(
            context,
            config,
            files,
            goals,
            conversation.snapshot.digest,
            preparedContextFiles.identity,
            reviewBriefingDigest(context, briefing),
          ),
      );
      if (!config.interactWithPullRequest) {
        await diagnostics.withSpan(
          actionDescriptor(
            "workspace",
            "action.workspace.revalidate",
            "revalidate the checkout before summary publication",
          ),
          () => assertWorkspace(context, workspace, signal),
        );
        throwIfAborted(signal);
        await diagnostics.withSpan(
          actionDescriptor(
            "publication",
            "action.summary.write",
            "write the summary-only review result",
          ),
          () => dependencies.writeSummary(context, review, goals),
        );
        throwIfAborted(signal);
        if (review.allGoalsFailed) {
          throw new Error("All review goals failed; the result was written to the run summary.");
        }
        if (review.partial) {
          throw new Error(
            "The review was written as a partial result, but one or more goals failed.",
          );
        }
        successDetails = { outcome: "completed", mode: "summary" };
        return { skipped: false, review };
      }
      if (review.allGoalsFailed) {
        await diagnostics.withSpan(
          actionDescriptor(
            "workspace",
            "action.workspace.revalidate",
            "revalidate the checkout before failure summary publication",
          ),
          () => assertWorkspace(context, workspace, signal),
        );
        throwIfAborted(signal);
        await diagnostics.withSpan(
          actionDescriptor(
            "publication",
            "action.summary.write",
            "write the failed review result before failing",
          ),
          () => dependencies.writeSummary(context, review, goals),
        );
        throwIfAborted(signal);
        throw new Error(
          "All review goals failed; no pull request review was posted, and the result was written to the run summary.",
        );
      }

      let request = await diagnostics.withSpan(
        actionDescriptor(
          "publication",
          "action.review.request",
          "build the secret-redacted GitHub review request",
        ),
        () => redactRequest(buildReviewRequest(context, review, goals), secrets),
      );
      await diagnostics.withSpan(
        actionDescriptor(
          "workspace",
          "action.workspace.revalidate",
          "revalidate the checkout before review publication",
        ),
        () => assertWorkspace(context, workspace, signal),
      );
      throwIfAborted(signal);
      if (request.event === "APPROVE") {
        const liveRefs = await diagnostics.withSpan(
          actionDescriptor(
            "publication",
            "action.review.head-fence",
            "verify pull request refs before approval",
          ),
          () => api.getPullRequestRefs(context),
        );
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
        await diagnostics.withSpan(
          actionDescriptor(
            "publication",
            "action.review.create",
            "publish the captured review to GitHub",
          ),
          () => api.createReview(context, request),
        );
        throwIfAborted(signal);
      } catch (error) {
        throwIfAborted(signal);
        if (request.event !== "APPROVE" || !isApprovalRejection(error)) throw error;
        core.warning("GitHub rejected the approval review; retrying as a comment review.");
        await diagnostics.withSpan(
          actionDescriptor(
            "workspace",
            "action.workspace.revalidate",
            "revalidate the checkout before fallback publication",
          ),
          () => assertWorkspace(context, workspace, signal),
        );
        throwIfAborted(signal);
        await diagnostics.withSpan(
          actionDescriptor(
            "publication",
            "action.review.create-fallback",
            "publish a comment after approval rejection",
          ),
          () =>
            api.createReview(context, {
              ...request,
              event: "COMMENT",
              body: `${request.body}\n\n> GitHub rejected the requested approval, so this result was posted as a comment.`,
            }),
        );
        throwIfAborted(signal);
      }
      if (lifecycleApi !== undefined) {
        const minimizedReviewIds = await diagnostics.withSpan(
          actionDescriptor(
            "lifecycle",
            "action.lifecycle.finalize",
            "finalize superseded action-owned reviews after publication",
          ),
          () => finalizeReviewLifecycle(lifecycleApi, context, authenticatedLogin),
        );
        logLifecycleResult({ resolvedThreadIds, minimizedReviewIds });
      }
      if (review.partial)
        throw new Error("The review was posted as a partial result, but one or more goals failed.");
      successDetails = { outcome: "completed", mode: "interactive" };
      return { skipped: false, review };
    } finally {
      await cleanupReviewArtifacts(contextFiles, temporaryWorkspace, diagnostics);
      if (successDetails?.outcome === "skipped") runSpan.skipped(successDetails);
      else if (successDetails !== undefined) runSpan.success(successDetails);
    }
  } catch (error) {
    if (abortController.signal.aborted) runSpan.cancelled(error);
    else runSpan.failure(error);
    throw error;
  }
}

interface ActionDependencies {
  readonly createApi: (
    token: string,
    signal?: AbortSignal,
    diagnostics?: DiagnosticLogger,
  ) => GitHubApi;
  readonly readEventContext: (signal?: AbortSignal) => Promise<PullRequestContext | undefined>;
  readonly createWorkspace: typeof createPullRequestWorkspace;
  readonly readFiles?: typeof readPullRequestFilesFromCheckout;
  readonly prepareContextFiles?: typeof prepareContextFiles;
  readonly runGoals: typeof runReviewGoals;
  readonly queryAgent?: ResolutionQuery;
  readonly runResolutionVerifiers?: typeof runResolutionVerifiers;
  readonly writeSummary: typeof writeRunSummary;
}

const defaultActionDependencies: ActionDependencies = {
  createApi: (token, signal, diagnostics) =>
    new GitHubApi(
      token,
      process.env.GITHUB_API_URL ?? "https://api.github.com",
      signal,
      undefined,
      diagnostics,
    ),
  readEventContext: (signal) => readPullRequestEventContext(undefined, undefined, signal),
  createWorkspace: createPullRequestWorkspace,
  readFiles: readPullRequestFilesFromCheckout,
  runGoals: runReviewGoals,
  runResolutionVerifiers,
  writeSummary: writeRunSummary,
};

export async function main(abortController = new AbortController()): Promise<void> {
  let inputSecrets: readonly string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "action",
    context: actionDiagnosticContext(),
  });
  const environmentInputSecrets = Object.entries(process.env)
    .filter(([key]) => key.startsWith("INPUT_"))
    .map(([, value]) => value ?? "");
  diagnostics.addSecrets(environmentInputSecrets);
  const mainSpan = diagnostics.start(
    actionDescriptor("action", "action.main", "run the GitHub Action entrypoint"),
  );
  try {
    const reader = actionInputReader();
    inputSecrets = inputSecretCandidates(reader);
    diagnostics.addSecrets(inputSecrets);
    registerInputSecrets(inputSecrets);
    await runAction(reader, inputSecrets, defaultActionDependencies, abortController, diagnostics);
    mainSpan.success();
  } catch (error) {
    if (abortController.signal.aborted) {
      mainSpan.cancelled(error);
      core.info("Pull request review cancelled; no new review or run summary will be published.");
      return;
    }
    diagnostics.addSecrets(environmentInputSecrets);
    mainSpan.failure(error);
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
