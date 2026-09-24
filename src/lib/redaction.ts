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

export function redactGoalResults(
  goals: readonly GoalResult[],
  secrets: readonly string[],
): readonly GoalResult[] {
  return goals.map((goal) => ({
    ...goal,
    prompt: redact(goal.prompt, secrets),
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
            assessment: {
              coverage: goal.submission.assessment.coverage.map((entry) => ({
                ...entry,
                paths: entry.paths.map((path) => redact(path, secrets)),
                rationale: redact(entry.rationale, secrets),
              })),
              candidates: goal.submission.assessment.candidates.map((candidate) => ({
                ...candidate,
                paths: candidate.paths.map((path) => redact(path, secrets)),
                trigger: redact(candidate.trigger, secrets),
                impact: redact(candidate.impact, secrets),
                countercheck: redact(candidate.countercheck, secrets),
              })),
            },
          },
        }),
  }));
}
