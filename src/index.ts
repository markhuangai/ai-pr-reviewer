import * as core from "@actions/core";

import { aggregateReview, buildReviewRequest, reviewMarker } from "./lib/aggregate.js";
import { GitHubApi, GitHubApiError } from "./lib/github-api.js";
import { readPullRequestContext } from "./lib/github-event.js";
import { readReviewConfig } from "./lib/input.js";
import { runReviewGoals } from "./runtime/agent.js";
import type {
  GoalResult,
  PullRequestReviewRequest,
  ReviewConfig,
  ReviewRunResult,
} from "./lib/types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((result, secret) => result.split(secret).join("[REDACTED]"), value);
}

function reviewSecrets(config: ReviewConfig): readonly string[] {
  return [
    config.githubToken,
    config.aiSecret,
    config.aiBaseUrl,
    ...Object.values(config.mcpServers).flatMap((server) => [
      server.url,
      ...Object.values(server.headers ?? {}),
    ]),
  ];
}

function redactGoals(
  goals: readonly GoalResult[],
  secrets: readonly string[],
): readonly GoalResult[] {
  return goals.map((goal) => ({
    ...goal,
    ...(goal.error === undefined ? {} : { error: redact(goal.error, secrets) }),
    ...(goal.submission === undefined
      ? {}
      : {
          submission: {
            summary: redact(goal.submission.summary, secrets),
            findings: goal.submission.findings.map((finding) => ({
              ...finding,
              title: redact(finding.title, secrets),
              body: redact(finding.body, secrets),
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

export async function runAction(): Promise<ReviewRunResult> {
  const config = readReviewConfig({ get: (name) => core.getInput(name) });
  const secrets = reviewSecrets(config);
  for (const secret of new Set(secrets)) if (secret.length > 0) core.setSecret(secret);
  const context = await readPullRequestContext();
  const api = new GitHubApi(config.githubToken);
  const authenticatedLogin = await api.getAuthenticatedUserLogin();
  const marker = reviewMarker(context, config);
  const existingReviews = await api.listReviews(context);
  if (
    existingReviews.some(
      (review) =>
        review.authorLogin.toLowerCase() === authenticatedLogin.toLowerCase() &&
        review.state !== "DISMISSED" &&
        review.commitId === context.headSha &&
        review.body.includes(marker),
    )
  ) {
    core.info("An identical review already exists for this pull request head; skipping.");
    return { skipped: true };
  }

  const files = await api.getPullRequestFiles(context);
  core.info(
    `Reviewing ${files.length} changed file${files.length === 1 ? "" : "s"} with ${config.reviewPrompts.length} isolated goal session${config.reviewPrompts.length === 1 ? "" : "s"}.`,
  );
  const rawGoals = await runReviewGoals(context, files, config);
  const goals = redactGoals(rawGoals, secrets);
  const review = aggregateReview(context, config, files, goals);
  if (review.allGoalsFailed) {
    throw new Error("All review goals failed; no pull request review was posted.");
  }

  const request = redactRequest(buildReviewRequest(context, review, goals), secrets);
  try {
    await api.createReview(context, request);
  } catch (error) {
    if (request.event !== "APPROVE" || !isApprovalRejection(error)) throw error;
    core.warning("GitHub rejected the approval review; retrying as a comment review.");
    await api.createReview(context, {
      ...request,
      event: "COMMENT",
      body: `${request.body}\n\n> GitHub rejected the requested approval, so this result was posted as a comment.`,
    });
  }
  if (review.partial)
    throw new Error("The review was posted as a partial result, but one or more goals failed.");
  return { skipped: false, review };
}

export async function main(): Promise<void> {
  try {
    await runAction();
  } catch (error) {
    const inputSecrets = Object.entries(process.env)
      .filter(([key]) => key.startsWith("INPUT_"))
      .map(([, value]) => value ?? "");
    core.setFailed(redact(errorMessage(error), [...inputSecrets]));
  }
}

export const indexInternals = { redact, reviewSecrets };
