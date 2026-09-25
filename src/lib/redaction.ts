import type { GoalResult } from "./types.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactSecret(value: string, secret: string): string {
  if (secret.length < 8 && /^[A-Za-z0-9]+$/u.test(secret)) {
    const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(secret)}(?![A-Za-z0-9])`, "g");
    return value.replace(pattern, "[REDACTED]");
  }
  return value.split(secret).join("[REDACTED]");
}

export function redact(value: string, secrets: readonly string[]): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => redactSecret(result, secret), value);
}

function redactCounts(
  counts: Readonly<Record<string, number>>,
  secrets: readonly string[],
): Record<string, number> {
  const totals = new Map<string, number>();
  for (const [category, count] of Object.entries(counts)) {
    const key = redact(category, secrets);
    totals.set(key, (totals.get(key) ?? 0) + count);
  }
  return Object.fromEntries(totals);
}

export function redactGoalResults(
  goals: readonly GoalResult[],
  secrets: readonly string[],
): readonly GoalResult[] {
  return goals.map((goal) => ({
    ...goal,
    prompt: redact(goal.prompt, secrets),
    ...(goal.error === undefined ? {} : { error: redact(goal.error, secrets) }),
    ...(goal.inspection === undefined
      ? {}
      : {
          inspection: {
            observedPaths: goal.inspection.observedPaths.map((path) => redact(path, secrets)),
            missingPaths: goal.inspection.missingPaths.map((path) => redact(path, secrets)),
          },
        }),
    ...(goal.diagnostics === undefined
      ? {}
      : {
          diagnostics: {
            ...goal.diagnostics,
            termination: redact(goal.diagnostics.termination, secrets),
            rejectionCounts: redactCounts(goal.diagnostics.rejectionCounts, secrets),
          },
        }),
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
            limitations: goal.submission.limitations.map((limitation) => ({
              paths: limitation.paths.map((path) => redact(path, secrets)),
              reason: redact(limitation.reason, secrets),
            })),
          },
        }),
  }));
}
