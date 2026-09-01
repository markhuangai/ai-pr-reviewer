import type { GoalResult, GoalSubmission, ReviewModelUsage } from "../lib/types.js";
import { errorMessage, withTokenUsage } from "./agent-logging.js";

export interface AcceptedSubmissionMcpStatus {
  readonly checked: boolean;
  readonly failures: string;
  readonly error?: string;
}

export async function readAcceptedSubmissionMcpFailures(
  mcpServerStatus: () => Promise<readonly McpServerStatusRecord[]>,
  configuredMcpNames: ReadonlySet<string>,
): Promise<readonly string[]> {
  return (await mcpServerStatus())
    .filter(
      (status) =>
        configuredMcpNames.has(status.name) &&
        (status.status === "failed" || status.status === "needs-auth"),
    )
    .map((status) => `${status.name}: ${status.error ?? status.status}`);
}

interface McpServerStatusRecord {
  readonly name: string;
  readonly status: string;
  readonly error?: string;
}

export async function readAcceptedSubmissionMcpStatus(
  readFailures: () => Promise<readonly string[]>,
): Promise<AcceptedSubmissionMcpStatus> {
  try {
    return { checked: true, failures: (await readFailures()).join("; ") };
  } catch (error) {
    return {
      checked: false,
      failures: "",
      error: errorMessage(error),
    };
  }
}

export function acceptedSubmissionResult(
  goal: string,
  submission: GoalSubmission,
  status: AcceptedSubmissionMcpStatus,
  models: readonly ReviewModelUsage[],
  tokenAccountingComplete: boolean,
): GoalResult {
  const error =
    status.error === undefined
      ? status.failures.length === 0
        ? undefined
        : `Configured MCP server failure: ${status.failures}`
      : `Configured MCP server status check failed: ${status.error}`;
  return withTokenUsage(
    {
      prompt: goal,
      status: error === undefined ? "completed" : "failed",
      submission,
      ...(error === undefined ? {} : { error }),
    },
    models,
    tokenAccountingComplete,
  );
}

export function acceptedSubmissionDetails(
  recovery: number,
  terminalSdkResult: boolean,
  terminalSdkResultSubtype: string | undefined,
  status: AcceptedSubmissionMcpStatus,
  tokenAccountingComplete: boolean,
): Readonly<Record<string, unknown>> {
  return {
    recovery,
    terminal_sdk_result: terminalSdkResult,
    ...(terminalSdkResultSubtype === undefined
      ? {}
      : { terminal_sdk_result_subtype: terminalSdkResultSubtype }),
    mcp_status_checked: status.checked,
    ...(status.failures.length === 0 ? {} : { mcp_failures: status.failures }),
    ...(status.error === undefined ? {} : { mcp_status_error: status.error }),
    token_accounting_complete: tokenAccountingComplete,
  };
}
