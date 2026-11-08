export function redactDiscovery(result, secrets) {
    if (result === undefined)
        return undefined;
    return {
        ...result,
        ...(result.error === undefined ? {} : { error: redact(result.error, secrets) }),
        diagnostics: {
            ...result.diagnostics,
            termination: redact(result.diagnostics.termination, secrets),
        },
        tokenUsage: {
            ...result.tokenUsage,
            models: result.tokenUsage.models.map((usage) => ({
                ...usage,
                model: redact(usage.model, secrets),
                ...(usage.canonicalModel === undefined
                    ? {}
                    : { canonicalModel: redact(usage.canonicalModel, secrets) }),
            })),
        },
    };
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function redactSecret(value, secret) {
    if (secret.length < 8 && /^[A-Za-z0-9]+$/u.test(secret)) {
        const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(secret)}(?![A-Za-z0-9])`, "g");
        return value.replace(pattern, "[REDACTED]");
    }
    return value.split(secret).join("[REDACTED]");
}
export function redact(value, secrets) {
    return secrets
        .filter((secret) => secret.length > 0)
        .sort((left, right) => right.length - left.length)
        .reduce((result, secret) => redactSecret(result, secret), value);
}
function redactCounts(counts, secrets) {
    const totals = new Map();
    for (const [category, count] of Object.entries(counts)) {
        const key = redact(category, secrets);
        totals.set(key, (totals.get(key) ?? 0) + count);
    }
    return Object.fromEntries(totals);
}
export function redactGoalResults(goals, secrets) {
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
                    ...(goal.inspection.lineCoverage === undefined
                        ? {}
                        : {
                            lineCoverage: goal.inspection.lineCoverage.map((file) => ({
                                ...file,
                                path: redact(file.path, secrets),
                            })),
                        }),
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
export function escapeHtmlText(value) {
    return value
        .replace(/&/gu, "&amp;")
        .replace(/</gu, "&lt;")
        .replace(/>/gu, "&gt;")
        .replace(/\r/gu, "&#13;")
        .replace(/\n/gu, "&#10;");
}
export function escapeMarkdownText(value) {
    return escapeHtmlText(value.replace(/[-\\`*_[\]{}()#+.!|]/gu, "\\$&"));
}
