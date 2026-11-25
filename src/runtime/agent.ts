import { acceptedSubmissionResult } from "./review-submission.js";
import { ReviewBriefingReader } from "./review-briefing.js";
import {
  query as sdkQuery,
  type HookCallback,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { throwIfAborted } from "../lib/bootstrap/cancellation.js";
import type { PreparedContextFile } from "../lib/context-files.js";
import { reviewSecretCandidates } from "../lib/input.js";
import type { ReviewConversationSnapshot } from "../lib/review-context.js";
import type {
  ChangedFile,
  GoalResult,
  GoalSubmission,
  PullRequestContext,
  ReviewBriefing,
  ReviewConfig,
  ReviewModelUsage,
} from "../lib/types.js";
import {
  agentLogLine,
  createAgentLifecycleState,
  errorMessage,
  logAgentEventSafely,
  logAgentLifecycleMessage,
  logAgentMessageSafely,
  logQueuedUserMessage,
  acceptedSubmissionDetails,
  readAcceptedSubmissionMcpFailures,
  readAcceptedSubmissionMcpStatus,
  runAgentCleanup,
  sdkSessionActivity,
  withTokenUsage,
  writeCompleteAgentLog,
  writeAgentMonitorEvent,
  writeAgentSessionEndLog,
  writeAgentLifecycleLog,
  type AgentToolUse,
  type AcceptedSubmissionMcpStatus,
} from "./agent-logging.js";
import type { PullRequestDiffArtifact } from "./agent-review-tools.js";
import {
  REVIEW_SYSTEM_PROMPT,
  interactiveSubmissionSchema,
  makeOptions,
  repairPrompt,
  reviewSessionSnapshot,
  reviewSubmissionRejection,
  startReviewPrompt,
  submissionSchema,
  toSubmission,
  type AgentQuery,
  createReviewGoalsRunner,
} from "./agent-session.js";
import {
  ReviewEvidenceLedger,
  toolResponseDocument,
  type ReviewValidationGap,
} from "./review-assessment.js";
import {
  ReviewSubmissionRecovery,
  investigationOnly,
  retainReviewSubmission,
  reviewSubmissionRejectionResult,
} from "./review-submission.js";
import { createReviewGoalTools } from "./review-goal-tools.js";
import { RepositorySnapshot, repositoryGuidanceForRun } from "./repository-snapshot.js";
import { createReviewDiagnostics } from "./review-diagnostics.js";
import { tool } from "./review-tool.js";
import { ReviewContextDelivery } from "./review-context-delivery.js";
import { ADVANCE_REVIEW_CONTEXT_CALL } from "./review-context-packets.js";
import { createReviewSession, createReviewMcpServers } from "./review-session.js";
import { SessionRunner, createDeferred, makeUserMessage } from "./session-runner.js";
import {
  assertDiscoverySnapshot,
  assertIndependentSession,
  sharedModelUsage,
  modelUsageSince,
  forkSessionOptions,
  runSharedDiscovery,
  type SharedReviewSeed,
} from "./shared-discovery.js";
export { agentInternals, type AgentQuery } from "./agent-session.js";
export const POST_COVERAGE_WRAP_UP_ROUNDS = 8;
export const POST_COVERAGE_WRAP_UP_MS = 8 * 60 * 1_000;

export async function runReviewGoal(
  goal: string,
  goalIndex: number,
  context: PullRequestContext,
  files: readonly ChangedFile[],
  conversation: ReviewConversationSnapshot,
  config: ReviewConfig,
  diff: PullRequestDiffArtifact,
  cwd = process.env.GITHUB_WORKSPACE ?? process.cwd(),
  queryAgent: AgentQuery = sdkQuery,
  contextFiles: readonly PreparedContextFile[] = [],
  abortController?: AbortController,
  briefing: ReviewBriefing = {
    linkedIssues: [],
    linkedIssueReferencesTruncated: false,
  },
  sharedSeed?: SharedReviewSeed,
): Promise<GoalResult> {
  const signal = abortController?.signal;
  throwIfAborted(signal);
  assertDiscoverySnapshot(sharedSeed, context, conversation, briefing);
  const sharedContext = sharedSeed?.sharedContext;
  let submission: GoalSubmission | undefined;
  const startedAt = Date.now();
  const recovery = new ReviewSubmissionRecovery(config.maxTurns);
  const recoveryExhausted = createDeferred<undefined>();
  const submissionName = "mcp__review_output__submit_review";
  let validationGaps: readonly ReviewValidationGap[] = [];
  const observeRejection = (id: string, response?: unknown): void => {
    if (submission !== undefined || !recovery.hasUse(id)) return;
    validationGaps = submissionGaps(recovery.latestInput);
    const rejectedGaps = submissionGaps(recovery.inputFor(id));
    const document = toolResponseDocument(response);
    const recordedCategories = Array.isArray(document?.categories)
      ? document.categories.filter((category): category is string => typeof category === "string")
      : Array.isArray(document?.gaps)
        ? document.gaps.flatMap((gap: unknown) =>
            typeof gap === "object" &&
            gap !== null &&
            "category" in gap &&
            typeof gap.category === "string"
              ? [gap.category]
              : [],
          )
        : [];
    recovery.observeProgress(inspectionProgress(), evidenceLedger.deliveryEpoch);
    const changed = recovery.reject(
      id,
      recordedCategories.length > 0
        ? recordedCategories
        : rejectedGaps.length === 0
          ? ["submission"]
          : rejectedGaps.map((gap) => gap.category),
    );
    if (changed)
      logDiagnostic("submission-decision", {
        toolCallId: id,
        decision: investigationOnly(recordedCategories) ? "continued" : "rejected",
        categories:
          recordedCategories.length > 0
            ? recordedCategories
            : rejectedGaps.map((gap) => gap.category),
        ...recoveryDetails(),
      });
    if (recovery.exhausted && recovery.allRejected) recoveryExhausted.resolve(undefined);
  };
  let reviewPromptActive = false;
  const isReviewActive = (): boolean => reviewPromptActive;
  const logSecrets = reviewSecretCandidates(config);
  const effectiveSystemPrompt = config.systemPrompt ?? REVIEW_SYSTEM_PROMPT;
  const toolUses = new Map<string, AgentToolUse>();
  const lifecycle = createAgentLifecycleState();
  const reviewSnapshot = { mergeBaseSha: diff.mergeBaseSha, headSha: context.headSha };
  const evidenceLedger = new ReviewEvidenceLedger(cwd, files, reviewSnapshot, diff.files);
  if (sharedSeed !== undefined && sharedContext === undefined)
    evidenceLedger.inherit(sharedSeed.evidence);
  let firstSubmissionMs: number | undefined;
  const {
    inspectionDetails,
    recoveryDetails,
    logDiagnostic,
    withDiagnostics: finalizeDiagnostics,
  } = createReviewDiagnostics({
    goalIndex,
    files,
    evidenceLedger,
    recovery,
    startedAt,
    logSecrets,
    privateContext: sharedContext !== undefined,
    sessionRecovery: () => ({
      ...runner.providerDiagnostics,
      stallRecoveries: runner.recoveryCount,
      ...(firstSubmissionMs === undefined ? {} : { firstSubmissionMs }),
      ...(delivery === undefined ? {} : { contextHandoffs: delivery.handoffs }),
    }),
    sourceContextDelivered: () =>
      sharedSeed === undefined ||
      lifecycle.sessionId !== undefined ||
      evidenceLedger.issued.size > sharedSeed.evidence.references.length,
  });
  let coverageCompletedAt: number | undefined;
  let coverageCompletedThisRound = false;
  let postCoverageToolRounds = 0;
  let postCoverageEpoch = 0;
  let wrapUpSent = false;
  const resetPostCoverage = (): void => {
    coverageCompletedAt = undefined;
    coverageCompletedThisRound = false;
    postCoverageToolRounds = 0;
    wrapUpSent = false;
  };
  const postCoverageWrapUp = (coverageComplete: boolean, roundComplete: boolean) => {
    // Compaction restarts pacing even when all verified packet receipts survive it.
    const deliveryEpoch = evidenceLedger.deliveryEpoch + lifecycle.compactionBoundaries;
    if (postCoverageEpoch !== deliveryEpoch) {
      postCoverageEpoch = deliveryEpoch;
      resetPostCoverage();
    }
    if (!reviewPromptActive || submission !== undefined || !coverageComplete || wrapUpSent)
      return undefined;
    const now = Date.now();
    if (coverageCompletedAt === undefined) {
      coverageCompletedAt = now;
      coverageCompletedThisRound = true;
    }
    if (!roundComplete) return undefined;
    if (!coverageCompletedThisRound) postCoverageToolRounds++;
    coverageCompletedThisRound = false;
    const elapsedMs = now - coverageCompletedAt;
    const roundsReached = postCoverageToolRounds >= POST_COVERAGE_WRAP_UP_ROUNDS;
    if (!roundsReached && elapsedMs < POST_COVERAGE_WRAP_UP_MS) return undefined;
    wrapUpSent = true;
    writeMonitorEvent("post-coverage-wrap-up", {
      trigger: roundsReached ? "rounds" : "elapsed",
      post_coverage_rounds: postCoverageToolRounds,
      post_coverage_elapsed_ms: elapsedMs,
      delivery_epoch: deliveryEpoch,
    });
    return "All required briefing pages and changed paths are already inspected. Finish any required evidence and discussion checks, then call submit_review now with the supported findings.";
  };
  const evidenceHook: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse" && input.tool_name === "Read") {
      evidenceLedger.observeNativeRead(input);
      return Promise.resolve({ continue: true });
    }
    if (input.hook_event_name !== "PostToolBatch") return Promise.resolve({ continue: true });
    await delivery?.refresh();
    const references = evidenceLedger.observeBatch(input.tool_calls);
    recovery.observeProgress(inspectionProgress(), evidenceLedger.deliveryEpoch);
    runner.observeProgress();
    const deliveredInspection = inspectionDetails();
    for (const delivery of evidenceLedger.deliveries)
      logDiagnostic("source-delivery", { ...delivery, ...deliveredInspection });
    for (const call of input.tool_calls) {
      if (call.tool_name !== submissionName || !reviewPromptActive) continue;
      recovery.observeUse(call.tool_use_id, call.tool_input);
      observeRejection(call.tool_use_id, call.tool_response);
    }
    const briefingComplete = briefingReader.complete;
    const inspectionComplete = evidenceLedger.inspection.missingPaths.length === 0;
    const coverageComplete = briefingComplete && inspectionComplete;
    const advanceContext = !coverageComplete && delivery?.hasUnstagedPackets === true;
    const codexRoundBoundary = config.executor === "codex" && input.tool_calls.length === 0;
    const wrapUp = postCoverageWrapUp(
      coverageComplete,
      config.executor !== "codex" || codexRoundBoundary,
    );
    if (
      references.length === 0 &&
      wrapUp === undefined &&
      (coverageComplete || delivery === undefined || codexRoundBoundary)
    )
      return Promise.resolve({ continue: true });
    return Promise.resolve({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PostToolBatch",
        additionalContext: `${evidenceLedger.renderReferences(references)}\n${JSON.stringify({
          ...deliveredInspection,
          ...(advanceContext
            ? { nextCall: ADVANCE_REVIEW_CONTEXT_CALL }
            : !briefingComplete
              ? { nextCall: { tool: "read_review_briefing", arguments: {} } }
              : !inspectionComplete
                ? { nextCall: { tool: "read_pr_diff", arguments: { remaining: true } } }
                : {}),
          ...(wrapUp === undefined ? {} : { wrapUp }),
        })}`,
      },
    });
  };
  const submissionHook: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse" || !reviewPromptActive || submission !== undefined)
      return Promise.resolve({ continue: true });
    firstSubmissionMs ??= Date.now() - startedAt;
    await delivery?.refresh();
    recovery.observeUse(input.tool_use_id, input.tool_input);
    return Promise.resolve({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        ...(recovery.allows(input.tool_use_id)
          ? {}
          : {
              permissionDecision: "deny" as const,
              permissionDecisionReason: "Review submission recovery is exhausted.",
            }),
      },
    });
  };
  const repositorySnapshot = new RepositorySnapshot(
    cwd,
    context.baseSha,
    context.headSha,
    diff.mergeBaseSha,
    files,
    signal,
  );
  const repositoryGuidance =
    sharedContext === undefined
      ? (briefing.repositoryGuidance ??
        (await repositoryGuidanceForRun(diff, repositorySnapshot, files)))
      : undefined;
  const briefingReader = new ReviewBriefingReader(
    context,
    files,
    conversation,
    {
      ...briefing,
      ...(repositoryGuidance === undefined ? {} : { repositoryGuidance }),
    },
    sharedContext?.briefing,
  );
  if (sharedSeed !== undefined && sharedContext === undefined)
    briefingReader.inherit(sharedSeed.briefing);
  const delivery =
    sharedContext === undefined || sharedSeed === undefined
      ? undefined
      : new ReviewContextDelivery(
          sharedContext,
          sharedSeed.sessionHome,
          briefingReader,
          evidenceLedger,
          (event, details) => {
            writeAgentMonitorEvent(goalIndex, event, details, logSecrets);
          },
          () => {
            resetPostCoverage();
            runner.rebaseProgress();
          },
        );
  const advanceContextTool = delivery?.advanceTool(
    () => reviewPromptActive && submission === undefined,
    signal,
  );
  const goalTools = createReviewGoalTools({
    context,
    files,
    conversation,
    config,
    contextFiles,
    diff,
    repositorySnapshot,
    evidenceLedger,
    briefingReader,
    signal,
    isReviewActive,
    recovery,
    ...(delivery === undefined
      ? {}
      : {
          beforeRead: () => delivery.refresh(),
          hasPendingContextPackets: () => delivery.hasUnstagedPackets,
        }),
    onSnapshot: (details) => {
      logDiagnostic("recovery-decision", details);
    },
  });
  const { submissionGaps, unreadFindingPaths, inspectionProgress } = goalTools;
  const outputTool = tool(
    "submit_review",
    "Submit summary, findings with their own evidenceRefs, countercheck and counterevidenceRefs, and limitations. The host requires a changed-code scan. Validation allows one initial failure plus five corrections; inspection has separate bounded recovery.",
    (config.interactWithPullRequest ? interactiveSubmissionSchema : submissionSchema).shape,
    async (input): Promise<CallToolResult> => {
      throwIfAborted(signal);
      const initialRejection = reviewSubmissionRejection(
        reviewPromptActive,
        submission !== undefined,
      );
      if (initialRejection === undefined && delivery !== undefined) {
        await delivery.refresh();
        throwIfAborted(signal);
      }
      const rejection =
        initialRejection ?? reviewSubmissionRejection(reviewPromptActive, submission !== undefined);
      if (rejection !== undefined) {
        return Promise.resolve({
          content: [{ type: "text", text: rejection }],
        });
      }
      validationGaps = submissionGaps(input);
      if (validationGaps.length > 0) {
        recovery.observeProgress(inspectionProgress(), evidenceLedger.deliveryEpoch);
        const budget = recovery.rejectionBudget(validationGaps.map((gap) => gap.category));
        return Promise.resolve(
          reviewSubmissionRejectionResult(
            validationGaps,
            evidenceLedger,
            files,
            budget.remainingCorrections,
            budget.remainingInspectionCycles,
            delivery?.hasUnstagedPackets,
          ),
        );
      }
      const candidate = toSubmission(submissionSchema.parse(input));
      if (delivery === undefined)
        logAgentEventSafely(goalIndex, logSecrets, (write) => {
          writeCompleteAgentLog(
            goalIndex,
            "review submission",
            "submit_review",
            "candidate",
            candidate,
            logSecrets,
            write,
          );
        });
      submission = candidate;
      runner.acceptOutput();
      logDiagnostic("submission-decision", {
        decision: "accepted",
        ...inspectionDetails(),
        ...recoveryDetails(),
        limitations: candidate.limitations,
      });
      return Promise.resolve({ content: [{ type: "text", text: "Review submission accepted." }] });
    },
    { alwaysLoad: true },
  );
  const outputServerName = "review_output";
  const reviewTools = [
    ...goalTools.tools,
    ...(advanceContextTool === undefined ? [] : [advanceContextTool]),
    outputTool,
    ...goalTools.repositoryTools,
  ];
  const mcpServers = createReviewMcpServers(
    config,
    reviewTools,
    goalTools.hasContextFiles,
    "review",
    delivery !== undefined,
  );
  const writeMonitorEvent = (event: string, details: Readonly<Record<string, unknown>>): void => {
    writeAgentMonitorEvent(
      goalIndex,
      event,
      delivery === undefined || details.error === undefined
        ? details
        : { ...details, error: "Runtime request failed." },
      logSecrets,
    );
  };
  const runner: SessionRunner = new SessionRunner({
    signal,
    streamEnded: `The ${config.executor ?? "claude"} message stream ended before a terminal result.`,
    write: writeMonitorEvent,
    watchdog: {
      kind: "review",
      activity: (message) => sdkSessionActivity(message, toolUses),
      progress: () =>
        inspectionProgress() +
        evidenceLedger.uniqueSourceBytes +
        evidenceLedger.uniqueNativeLines +
        goalTools.contextPages(),
      snapshot: () => ({
        ...reviewSessionSnapshot(
          runner.phase,
          lifecycle,
          recovery.repairAttempts,
          submission !== undefined,
          runner.awaitingInterruptedTurn,
          delivery === undefined,
        ),
        ...inspectionDetails(),
        ...recoveryDetails(),
      }),
    },
  });
  const queueMessage = (text: string, label: string): void => {
    const message = makeUserMessage(text);
    runner.prompts.push(message);
    if (delivery === undefined)
      logAgentEventSafely(goalIndex, logSecrets, (write) => {
        logQueuedUserMessage(message, label, goalIndex, logSecrets, write);
      });
  };
  let confirmClosed: (() => void) | undefined;
  const tokenUsageState: {
    models: readonly ReviewModelUsage[];
    latestSnapshotValid: boolean;
  } = { models: [], latestSnapshotValid: false };
  const withDiagnostics = (result: GoalResult): GoalResult =>
    finalizeDiagnostics(result, runner.phase, validationGaps);
  const retainedSubmission = (): GoalSubmission | undefined =>
    retainReviewSubmission(
      recovery.latestInput,
      files,
      evidenceLedger.issued,
      config.interactWithPullRequest,
      submissionGaps(recovery.latestInput),
      (finding) => briefingReader.complete && unreadFindingPaths([finding]).length === 0,
      `Required inspection stopped: ${recovery.exhaustionReason ?? runner.phase}.`,
    );
  try {
    throwIfAborted(signal);
    logAgentEventSafely(goalIndex, logSecrets, (write) => {
      writeAgentLifecycleLog(goalIndex, "start", { prompt_gate: "closed" }, logSecrets, write);
      if (delivery === undefined)
        writeCompleteAgentLog(
          goalIndex,
          "system message",
          "review",
          "text",
          effectiveSystemPrompt,
          logSecrets,
          write,
        );
    });
    const activeSession = runner.start(
      (prompt) => {
        const session = createReviewSession(queryAgent, {
          config,
          ...forkSessionOptions(sharedSeed),
          ...(delivery === undefined ? {} : { contextDelivery: delivery }),
          cwd,
          tools: reviewTools,
          outputServerName,
          isAccepted: () => submission !== undefined,
          prompt,
          options: makeOptions(
            config,
            cwd,
            mcpServers,
            outputServerName,
            contextFiles.length > 0,
            abortController,
            effectiveSystemPrompt,
            evidenceHook,
            submissionHook,
          ),
        });
        confirmClosed = sharedSeed?.retainSession();
        return session;
      },
      (message, providerFailure) => {
        assertIndependentSession(message, sharedSeed);
        if (message.type !== "active_goal" && delivery === undefined)
          logAgentMessageSafely(message, goalIndex, logSecrets, toolUses);
        logAgentEventSafely(goalIndex, logSecrets, (write) => {
          logAgentLifecycleMessage(
            message,
            goalIndex,
            logSecrets,
            lifecycle,
            delivery === undefined
              ? write
              : (line) => {
                  if (
                    !line.includes("turn-result errors:") &&
                    !line.includes("compaction-result error:") &&
                    !line.includes("goal-iteration details:")
                  )
                    write(line);
                },
          );
        });
        if (isReviewActive()) recovery.observeMessage(message, observeRejection);
        if (message.type !== "result") return;
        if (
          delivery !== undefined &&
          config.executor !== "codex" &&
          message.subtype === "success" &&
          message.num_turns === 0 &&
          !delivery.advanceRequested &&
          !runner.awaitingInterruptedTurn &&
          providerFailure === undefined
        )
          return false;
        const snapshot = sharedModelUsage(message.modelUsage, config.executor, sharedSeed);
        tokenUsageState.latestSnapshotValid =
          modelUsageSince(snapshot, tokenUsageState.models) !== undefined;
        if (snapshot !== undefined && tokenUsageState.latestSnapshotValid)
          tokenUsageState.models = snapshot;
        if (providerFailure !== undefined) tokenUsageState.latestSnapshotValid = false;
        return undefined;
      },
    );
    const configuredMcpNames = new Set(Object.keys(config.mcpServers));
    const readMcpFailures = async (): Promise<readonly string[]> => {
      try {
        const failures = await readAcceptedSubmissionMcpFailures(
          () => activeSession.mcpServerStatus(),
          configuredMcpNames,
        );
        return delivery !== undefined && failures.length > 0
          ? ["Configured MCP servers are unavailable."]
          : failures;
      } catch (error) {
        if (delivery === undefined) throw error;
        throw new Error("Could not verify configured MCP server status.", { cause: error });
      }
    };
    const readMcpStatus = () => readAcceptedSubmissionMcpStatus(readMcpFailures);
    const resultAfterClose = (
      status: AcceptedSubmissionMcpStatus,
      tokenComplete: boolean,
      stopReason?: string,
      failed = false,
    ): GoalResult => {
      const providerFailure = runner.acceptedProviderFailure?.failure;
      if (providerFailure !== undefined) runner.phase = "provider-error";
      const mustFail = failed || providerFailure !== undefined;
      if (submission !== undefined && !mustFail)
        return withDiagnostics(
          acceptedSubmissionResult(goal, submission, status, tokenUsageState.models, tokenComplete),
        );
      const error =
        providerFailure?.message ?? stopReason ?? "The review closed without a submission.";
      const retained = submission ?? retainedSubmission();
      const mcpFailed = status.error !== undefined || status.failures.length > 0;
      return withDiagnostics(
        withTokenUsage(
          {
            prompt: goal,
            status: mustFail || mcpFailed || retained === undefined ? "failed" : "incomplete",
            ...(retained === undefined ? {} : { submission: retained }),
            error:
              delivery !== undefined
                ? `Review stopped (${runner.phase}${mcpFailed ? "; MCP status failed" : ""}).`
                : mcpFailed
                  ? `${error}; configured MCP status: ${status.error ?? status.failures}`
                  : error,
          },
          tokenUsageState.models,
          tokenComplete && providerFailure === undefined,
        ),
      );
    };
    const finalizeAccepted = async (
      terminal: SDKResultMessage | undefined,
      interrupted = false,
    ): Promise<GoalResult> => {
      runner.phase =
        terminal === undefined
          ? "finalizing-accepted-submission"
          : interrupted
            ? "finalizing-interrupted-submission"
            : "checking-mcp-status";
      const status = await runner.finish(readMcpStatus);
      const lateProviderFailure = runner.acceptedProviderFailure;
      const terminalSubtype = lateProviderFailure?.subtype ?? terminal?.subtype;
      const tokenComplete =
        terminal !== undefined &&
        lateProviderFailure === undefined &&
        tokenUsageState.latestSnapshotValid;
      writeMonitorEvent(
        "submission-finalized",
        acceptedSubmissionDetails(
          runner.recoveryCount,
          terminalSubtype !== undefined,
          terminalSubtype,
          status,
          tokenComplete,
        ),
      );
      return resultAfterClose(status, tokenComplete);
    };
    const finalizeUnaccepted = async (
      error: string,
      tokenComplete: boolean,
      failed = false,
    ): Promise<GoalResult> => {
      const status = await runner.finish(
        failed
          ? () => Promise.resolve<AcceptedSubmissionMcpStatus>({ checked: false, failures: "" })
          : readMcpStatus,
      );
      return resultAfterClose(status, tokenComplete, error, failed);
    };
    throwIfAborted(signal);
    startReviewPrompt(
      runner.prompts,
      goal,
      context,
      files,
      diff.mergeBaseSha,
      conversation.entries.length,
      contextFiles,
      goalIndex,
      logSecrets,
      () => {
        reviewPromptActive = true;
      },
      undefined,
      cwd,
      config.interactWithPullRequest,
      sharedSeed !== undefined,
      sharedContext === undefined ? undefined : sharedSeed?.changeMap,
      config.executor,
    );
    logAgentEventSafely(goalIndex, logSecrets, (write) => {
      writeAgentLifecycleLog(
        goalIndex,
        "prompt-gate-open",
        { queued_messages: 2 },
        logSecrets,
        write,
      );
    });
    runner.phase = "waiting-for-turn-result";
    const exhausted = recoveryExhausted.promise.then(() => ({
      kind: "recovery-exhausted" as const,
    }));
    for (;;) {
      const outcome = await runner.waitForTurn(exhausted);
      if (outcome.kind === "recovery-failed") {
        runner.phase = outcome.reason;
        return await finalizeUnaccepted(
          outcome.reason === "interrupt-timeout"
            ? "The stalled session did not finish its interrupted turn within 30 seconds."
            : "The goal stalled again after two recovery attempts.",
          false,
          true,
        );
      }
      if (outcome.kind === "accepted-after-grace") {
        if (submission === undefined) throw new Error("The accepted review is unavailable.");
        return await finalizeAccepted(undefined);
      }
      if (outcome.kind === "recovery-exhausted") {
        runner.phase = recovery.exhaustionReason ?? "repair-exhausted";
        return await finalizeUnaccepted(`Review recovery stopped: ${runner.phase}.`, false);
      }
      const { result, providerFailure, interrupted } = outcome;
      const continueSweep = await delivery?.boundary();
      const claudeNativeTurns = activeSession.nativeModelTurns?.();
      if (
        claudeNativeTurns !== undefined &&
        (claudeNativeTurns > config.maxTurns ||
          (claudeNativeTurns === config.maxTurns && submission === undefined)) &&
        providerFailure === undefined
      ) {
        runner.phase = "max-turns-exhausted";
        return await finalizeUnaccepted(
          "The review reached the configured runtime turn limit.",
          tokenUsageState.latestSnapshotValid,
          submission !== undefined,
        );
      }
      if (interrupted && providerFailure === undefined) {
        writeMonitorEvent("interrupted-turn-boundary", {
          recovery: runner.recoveryCount,
          result_subtype: result.subtype,
          submission_accepted: submission !== undefined,
        });
        if (submission !== undefined) return await finalizeAccepted(result, true);
        if (result.subtype === "error_max_turns" || recovery.exhausted) {
          runner.phase =
            result.subtype === "error_max_turns"
              ? "max-turns-exhausted"
              : (recovery.exhaustionReason ?? "repair-exhausted");
          return await finalizeUnaccepted(
            "Review recovery stopped at the configured limit.",
            tokenUsageState.latestSnapshotValid,
          );
        }
        runner.phase = "waiting-for-continuation-result";
        const coverageComplete =
          briefingReader.complete && evidenceLedger.inspection.missingPaths.length === 0;
        queueMessage(
          coverageComplete
            ? "The previous turn was interrupted because it stopped making progress. Continue the same goal from the current session state. The host confirms that all required briefing pages and changed paths are already inspected. Call submit_review now using the evidence already gathered."
            : "The previous turn was interrupted because it stopped making progress. Continue the same goal from the current session state. Re-read evidence only when needed, then submit exactly once through the required output tool.",
          `stall-continuation-${runner.recoveryCount}`,
        );
        writeMonitorEvent("continuation-queued", {
          recovery: runner.recoveryCount,
          interrupted_result_subtype: result.subtype,
          repair_attempts: recovery.repairAttempts,
          coverage_complete: coverageComplete,
        });
        continue;
      }
      if (providerFailure !== undefined) {
        recovery.finishProviderTurn();
        const retry = await runner.retry(providerFailure);
        if (retry !== "retry") {
          runner.phase = retry;
          return await finalizeUnaccepted(
            providerFailure.message,
            tokenUsageState.latestSnapshotValid,
            true,
          );
        }
        runner.phase = "waiting-for-continuation-result";
        queueMessage(
          "The model provider request failed temporarily. Continue the same review from the existing evidence and exact next calls in read_review_state, then submit through submit_review.",
          `provider-retry-${runner.providerDiagnostics.providerRetries}`,
        );
        continue;
      }
      if (result.subtype !== "success") {
        runner.phase =
          result.subtype === "error_max_turns" ? "max-turns-exhausted" : "finalizing-failed-turn";
        return await finalizeUnaccepted(
          result.errors.join("; ") || `${config.executor ?? "claude"} returned ${result.subtype}.`,
          tokenUsageState.latestSnapshotValid,
          result.subtype !== "error_max_turns",
        );
      }
      if (submission !== undefined) return await finalizeAccepted(result);
      const nextContext = continueSweep ? delivery?.nextMessage() : undefined;
      if (nextContext !== undefined) {
        const message = makeUserMessage(nextContext.text);
        runner.prompts.push(nextContext.packet ? { ...message, client_composed: true } : message);
        continue;
      }
      recovery.observeProgress(inspectionProgress(), evidenceLedger.deliveryEpoch);
      const recoveryKind = recovery.finishTurn();
      if (recovery.exhausted) {
        runner.phase = recovery.exhaustionReason ?? "repair-exhausted";
        return await finalizeUnaccepted(
          `Review recovery stopped: ${runner.phase}.`,
          tokenUsageState.latestSnapshotValid,
        );
      }
      throwIfAborted(signal);
      runner.phase = "waiting-for-repair-result";
      queueMessage(
        repairPrompt(
          recoveryKind === "inspection"
            ? { kind: "inspection", remainingCycles: recovery.remainingInspectionCycles }
            : { kind: "validation", attempt: recovery.repairAttempts + 1 },
          briefingReader.complete,
          config.interactWithPullRequest,
          validationGaps[0]?.message.slice(0, 1_000),
        ),
        recoveryKind === "inspection"
          ? `inspection-continuation-${recovery.inspectionContinuations}`
          : `repair-${recovery.repairAttempts + 1}`,
      );
    }
  } catch (error) {
    if (
      !runner.phase.startsWith("provider-") &&
      runner.phase !== "interrupt-timeout" &&
      runner.phase !== "stall-recovery-exhausted"
    )
      runner.phase = "failed";
    let failure = runner.readerFailure?.message ?? errorMessage(error);
    try {
      await runner.close();
    } catch (cleanupError) {
      if (cleanupError !== error)
        failure += `; session cleanup failed: ${errorMessage(cleanupError)}`;
    }
    throwIfAborted(signal);
    if (delivery !== undefined) failure = `Review stopped (${runner.phase}).`;
    logAgentEventSafely(goalIndex, logSecrets, (write) => {
      write(agentLogLine(goalIndex, "session", "failure", "error", failure, logSecrets));
    });
    const retained = submission ?? retainedSubmission();
    return withDiagnostics(
      withTokenUsage(
        {
          prompt: goal,
          status: "failed",
          ...(retained === undefined ? {} : { submission: retained }),
          error: failure,
        },
        tokenUsageState.models,
        false,
      ),
    );
  } finally {
    runner.dispose();
    if (runner.closed) confirmClosed?.();
    evidenceLedger.clearPendingNativeReads();
    writeAgentSessionEndLog(
      goalIndex,
      lifecycle,
      reviewPromptActive,
      recovery.repairAttempts,
      submission !== undefined,
      runner.recoveryCount,
      logSecrets,
    );
    await runAgentCleanup(
      [...goalTools.cleanupOperations(), repositorySnapshot.cleanup()],
      goalIndex,
      logSecrets,
    );
  }
}
export const runReviewGoals = createReviewGoalsRunner(runReviewGoal, sdkQuery, runSharedDiscovery);
