import * as core from "@actions/core";

import { aggregateReview, buildReviewRequest, reviewMarker } from "./lib/aggregate.js";
import { GitHubApi, GitHubApiError } from "./lib/github-api.js";
import { readPullRequestContext } from "./lib/github-event.js";
import { readReviewConfig } from "./lib/input.js";
import { runReviewGoals } from "./runtime/agent.js";
import type { GoalResult, ReviewRunResult } from "./lib/types.js";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redact(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((result, secret) => result.split(secret).join("[REDACTED]"), value);
}

function redactGoals(
  goals: readonly GoalResult[],
  secrets: readonly string[],
): readonly GoalResult[] {
  return goals.map((goal) => ({
    ...goal,
    ...(goal.error === undefined ? {} : { error: redact(goal.error, secrets) }),
  }));
}

export async function runAction(): Promise<ReviewRunResult> {
  const config = readReviewConfig({ get: (name) => core.getInput(name) });
  const context = await readPullRequestContext();
  const api = new GitHubApi(config.githubToken);
  const marker = reviewMarker(context, config);
  const existingReviews = await api.listReviews(context);
  if (
    existingReviews.some(
      (review) => review.commitId === context.headSha && review.body.includes(marker),
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
  const goals = redactGoals(rawGoals, [
    config.githubToken,
    config.aiSecret,
    ...Object.values(config.mcpServers).flatMap((server) => Object.values(server.headers ?? {})),
  ]);
  const review = aggregateReview(context, config, files, goals);
  if (review.allGoalsFailed) {
    throw new Error("All review goals failed; no pull request review was posted.");
  }

  const request = buildReviewRequest(context, review, goals);
  try {
    await api.createReview(context, request);
  } catch (error) {
    if (request.event !== "APPROVE" || !(error instanceof GitHubApiError)) throw error;
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
    core.setFailed(
      redact(errorMessage(error), [
        process.env.INPUT_GITHUB_PAT ?? "",
        process.env.INPUT_AI_SECRET ?? "",
      ]),
    );
  }
}
