import type { GoalResult } from "./types.js";
import { escapeMarkdownText } from "./redaction.js";

export function incompleteGoalDetails(goals: readonly GoalResult[]): string {
  const rows = goals.flatMap((goal, index) => {
    const missing = goal.inspection?.missingPaths.length ?? 0;
    const limitations = goal.submission?.limitations.length ?? 0;
    if (goal.status === "completed" && missing === 0 && limitations === 0) return [];
    const terminationReasons: Readonly<Record<string, string>> = {
      "max-turns-exhausted": "Configured SDK turn limit reached",
      "validation-exhausted": "Submission correction budget exhausted",
      "inspection-stalled": "Required inspection stopped making progress",
      "recovery-limit": "Configured recovery limit reached",
      "provider-retries-exhausted":
        "Model provider remained unavailable after two automatic retries",
      "provider-error":
        "Model provider request failed; check provider configuration and availability",
      "stall-recovery-exhausted":
        "Goal stopped making progress after two automatic recovery attempts",
      "interrupt-timeout": "Stalled session did not finish its interrupted turn within 30 seconds",
      "discovery-provider-retries-exhausted":
        "Shared discovery provider remained unavailable after two automatic retries",
      "discovery-provider-error": "Shared discovery provider request failed",
      "discovery-finish-exhausted":
        "Shared discovery did not produce a map after its finishing continuation",
      "discovery-deadline": "Shared discovery reached its ten-minute deadline",
      "discovery-failed": "Shared discovery failed before the review goals could start",
    };
    const termination = terminationReasons[goal.diagnostics?.termination ?? ""];
    const reasons: string[] = termination === undefined ? [] : [termination];
    if (goal.diagnostics?.providerErrorStatus !== undefined)
      reasons.push(`Provider HTTP ${goal.diagnostics.providerErrorStatus}`);
    if (missing > 0) reasons.push(`${missing} changed path${missing === 1 ? "" : "s"} unread`);
    if (limitations > 0)
      reasons.push(`${limitations} declared limitation${limitations === 1 ? "" : "s"}`);
    if (goal.status === "failed") reasons.push("Goal failed; inspect the workflow logs");
    if (reasons.length === 0) reasons.push("Required investigation did not finish");
    return [
      `| ${index + 1} | ${goal.status === "failed" ? "Failed" : "Incomplete"} | ${escapeMarkdownText(reasons.join("; "))} |`,
    ];
  });
  if (rows.length === 0) return "";
  const header = "### Incomplete checks\n\n| Check | Result | Reason |\n|:--|:--|:--|";
  const omitted = rows.length > 20 ? `\n\n${rows.length - 20} more incomplete checks omitted.` : "";
  return `${header}\n${rows.slice(0, 20).join("\n")}${omitted}`;
}
