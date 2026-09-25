import * as core from "@actions/core";
import type { ChangedFile, GoalResult } from "../lib/types.js";
import {
  logAgentEventSafely,
  writeCompleteAgentLog,
  writeAgentMonitorEvent,
  type AgentLogWriter,
} from "./agent-logging.js";
import {
  reviewInspection,
  type ReviewEvidenceLedger,
  type ReviewValidationGap,
} from "./review-assessment.js";
import type { ReviewSubmissionRecovery } from "./review-submission.js";

export function writeReviewDiagnostic(
  goalIndex: number,
  event: "source-delivery" | "recovery-decision" | "submission-decision" | "review-result",
  details: Readonly<Record<string, unknown>>,
  secrets: readonly string[],
  write: AgentLogWriter = (line) => {
    core.info(line);
  },
): void {
  const allowed = new Set([
    "elapsedMs",
    "toolCallId",
    "query",
    "page",
    "kind",
    "path",
    "paths",
    "revision",
    "mergeBaseSha",
    "headSha",
    "range",
    "newBytes",
    "repeatedBytes",
    "newLines",
    "repeatedLines",
    "fileComplete",
    "newlyCompletedPaths",
    "evidenceRef",
    "status",
    "reason",
    "inspection",
    "missingPaths",
    "uniqueSourceBytes",
    "repeatedSourceBytes",
    "snapshotId",
    "briefingComplete",
    "nextCalls",
    "optionalCalls",
    "decision",
    "categories",
    "submissionAttempts",
    "repairAttempts",
    "remainingCorrections",
    "remainingInspectionCycles",
    "validationFailures",
    "inspectionContinuations",
    "consecutiveNoProgress",
    "recoveryCycles",
    "maxRecoveryCycles",
    "termination",
    "limitations",
    "reviewComplete",
    "tokenAccountingComplete",
    "error",
  ]);
  const projected = Object.fromEntries(Object.entries(details).filter(([key]) => allowed.has(key)));
  logAgentEventSafely(
    goalIndex,
    secrets,
    (safeWrite) => {
      writeCompleteAgentLog(
        goalIndex,
        "diagnostic",
        event,
        "details",
        projected,
        secrets,
        safeWrite,
      );
    },
    write,
  );
}

export function createReviewDiagnostics({
  goalIndex,
  files,
  evidenceLedger,
  recovery,
  startedAt,
  logSecrets,
}: {
  goalIndex: number;
  files: readonly ChangedFile[];
  evidenceLedger: ReviewEvidenceLedger;
  recovery: ReviewSubmissionRecovery;
  startedAt: number;
  logSecrets: readonly string[];
}) {
  function inspectionDetails(): Readonly<Record<string, unknown>> {
    const inspection = reviewInspection(files, evidenceLedger.issued);
    return {
      inspection: {
        observed: inspection.observedPaths.length,
        missing: inspection.missingPaths.length,
      },
      uniqueSourceBytes: evidenceLedger.uniqueSourceBytes,
      repeatedSourceBytes: evidenceLedger.repeatedSourceBytes,
    };
  }
  function recoveryDetails(): Readonly<Record<string, unknown>> {
    return {
      submissionAttempts: recovery.submissionAttempts,
      repairAttempts: recovery.repairAttempts,
      validationFailures: recovery.validationFailures,
      inspectionContinuations: recovery.inspectionContinuations,
      consecutiveNoProgress: recovery.consecutiveNoProgress,
      recoveryCycles: recovery.recoveryCycles,
      maxRecoveryCycles: recovery.maxCycles,
      remainingCorrections: recovery.remainingCorrections,
      remainingInspectionCycles: recovery.remainingInspectionCycles,
    };
  }
  function logDiagnostic(
    event: Parameters<typeof writeReviewDiagnostic>[1],
    details: Readonly<Record<string, unknown>>,
  ): void {
    writeReviewDiagnostic(
      goalIndex,
      event,
      { elapsedMs: Date.now() - startedAt, ...details },
      logSecrets,
    );
  }
  const withDiagnostics = (
    result: GoalResult,
    sessionPhase: string,
    validationGaps: readonly ReviewValidationGap[],
  ): GoalResult => {
    const diagnostics = {
      ...recovery.diagnostics(evidenceLedger.issued.size, sessionPhase),
      uniqueSourceBytes: evidenceLedger.uniqueSourceBytes,
      repeatedSourceBytes: evidenceLedger.repeatedSourceBytes,
    };
    writeAgentMonitorEvent(goalIndex, "review-recovery", diagnostics, logSecrets);
    const inspection = reviewInspection(files, evidenceLedger.issued);
    if (result.status === "incomplete") {
      const categories = [
        ...new Set([
          ...validationGaps.map((gap) => gap.category),
          ...(inspection.missingPaths.length > 0 ? ["inspection"] : []),
        ]),
      ];
      logDiagnostic("submission-decision", {
        decision: "finalized-incomplete",
        categories: categories.length > 0 ? categories : ["limitation"],
        ...inspectionDetails(),
        ...recoveryDetails(),
        termination: sessionPhase,
        limitations: result.submission?.limitations ?? [],
      });
    }
    logDiagnostic("review-result", {
      ...inspectionDetails(),
      ...recoveryDetails(),
      missingPaths: inspection.missingPaths,
      termination: sessionPhase,
      status: result.status,
      reviewComplete: result.status === "completed",
      tokenAccountingComplete: result.tokenUsage?.complete ?? false,
      limitations: result.submission?.limitations ?? [],
      ...(result.error === undefined ? {} : { error: result.error }),
    });
    return { ...result, inspection, diagnostics };
  };
  return { inspectionDetails, recoveryDetails, logDiagnostic, withDiagnostics };
}
