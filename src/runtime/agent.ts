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
  PromptStream,
  REVIEW_SYSTEM_PROMPT,
  closeSdkSession,
  createDeferred,
  createReviewSessionRecoveryMonitor,
  interactiveSubmissionSchema,
  makeOptions,
  makeUserMessage,
  repairPrompt,
  reviewSessionSnapshot,
  reviewSubmissionRejection,
  startReviewPrompt,
  submissionSchema,
  toSubmission,
  type AgentQuery,
  type SdkSessionMonitor,
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
import {
  ProviderRecovery,
  waitForProviderRetry,
  type SessionRecoveryFailure,
} from "./session-recovery.js";
import {
  createReviewSession,
  createReviewMcpServers,
  type ReviewSession,
} from "./review-session.js";
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
  const provider = new ProviderRecovery();
  const accepted = createDeferred<undefined>();
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
      ...provider.diagnostics,
      stallRecoveries: monitor?.recoveryCount ?? 0,
      ...(firstSubmissionMs === undefined ? {} : { firstSubmissionMs }),
      ...(delivery === undefined ? {} : { contextHandoffs: delivery.handoffs }),
    }),
    sourceContextDelivered: () =>
      sharedSeed === undefined ||
      lifecycle.sessionId !== undefined ||
      evidenceLedger.issued.size > sharedSeed.evidence.references.length,
  });
  const evidenceHook: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse" && input.tool_name === "Read") {
      evidenceLedger.observeNativeRead(input);
      return Promise.resolve({ continue: true });
    }
    if (input.hook_event_name !== "PostToolBatch") return Promise.resolve({ continue: true });
    await delivery?.refresh();
    const references = evidenceLedger.observeBatch(input.tool_calls);
    recovery.observeProgress(inspectionProgress(), evidenceLedger.deliveryEpoch);
    monitor?.observeProgress();
    const deliveredInspection = inspectionDetails();
    for (const delivery of evidenceLedger.deliveries)
      logDiagnostic("source-delivery", { ...delivery, ...deliveredInspection });
    for (const call of input.tool_calls) {
      if (call.tool_name !== submissionName || !reviewPromptActive) continue;
      recovery.observeUse(call.tool_use_id, call.tool_input);
      observeRejection(call.tool_use_id, call.tool_response);
    }
    if (references.length === 0) return Promise.resolve({ continue: true });
    return Promise.resolve({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "PostToolBatch",
        additionalContext: `${evidenceLedger.renderReferences(references)}\n${JSON.stringify({
          ...deliveredInspection,
          ...(!briefingReader.complete
            ? { nextCall: { tool: "read_review_briefing", arguments: {} } }
            : evidenceLedger.inspection.missingPaths.length > 0
              ? { nextCall: { tool: "read_pr_diff", arguments: { remaining: true } } }
              : {}),
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
  let monitor: SdkSessionMonitor | undefined;
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
          () => monitor?.rebaseProgress(),
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
      accepted.resolve(undefined);
      logDiagnostic("submission-decision", {
        decision: "accepted",
        ...inspectionDetails(),
        ...recoveryDetails(),
        limitations: candidate.limitations,
      });
      monitor?.acceptSubmission();
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
  const input = new PromptStream();
  const queueMessage = (text: string, label: string): void => {
    const message = makeUserMessage(text);
    input.push(message);
    if (delivery === undefined)
      logAgentEventSafely(goalIndex, logSecrets, (write) => {
        logQueuedUserMessage(message, label, goalIndex, logSecrets, write);
      });
  };
  let turn = createDeferred<SDKResultMessage>();
  let readerFailure: Error | undefined;
  let reader: Promise<void> | undefined;
  let session: ReviewSession | undefined;
  let sessionPhase = "starting";
  const sessionState = { stallBoundaryPending: false, expectedSessionClose: false };
  let sessionClosed = false;
  let closedOperation: void | Promise<void>;
  const stalledSubmission = createDeferred<undefined>();
  const recoveryFailure = createDeferred<SessionRecoveryFailure>();
  const closeSession = (): void | Promise<void> => {
    if (session === undefined || sessionClosed) return closedOperation;
    sessionClosed = true;
    return (closedOperation = session.close());
  };
  let shutdown: Promise<void> | undefined;
  let confirmClosed: (() => void) | undefined;
  const finishSession = async (): Promise<void> => {
    monitor?.stop();
    sessionState.expectedSessionClose = true;
    input.finish();
    await (shutdown ??= closeSdkSession(closeSession, reader).then(() => confirmClosed?.()));
    if (readerFailure !== undefined) throw readerFailure;
  };
  const tokenUsageState: {
    models: readonly ReviewModelUsage[];
    latestSnapshotValid: boolean;
  } = { models: [], latestSnapshotValid: false };
  const withDiagnostics = (result: GoalResult): GoalResult =>
    finalizeDiagnostics(result, sessionPhase, validationGaps);
  const retainedSubmission = (): GoalSubmission | undefined =>
    retainReviewSubmission(
      recovery.latestInput,
      files,
      evidenceLedger.issued,
      config.interactWithPullRequest,
      submissionGaps(recovery.latestInput),
      (finding) => briefingReader.complete && unreadFindingPaths([finding]).length === 0,
      `Required inspection stopped: ${recovery.exhaustionReason ?? sessionPhase}.`,
    );
  const abortTurn = (): void => {
    input.finish();
    turn.reject(signal?.reason ?? new Error("The pull request review was cancelled."));
  };
  signal?.addEventListener("abort", abortTurn, { once: true });
  if (signal?.aborted) abortTurn();
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
    session = createReviewSession(queryAgent, {
      config,
      ...forkSessionOptions(sharedSeed),
      ...(delivery === undefined ? {} : { contextDelivery: delivery }),
      cwd,
      tools: reviewTools,
      outputServerName,
      isAccepted: () => submission !== undefined,
      prompt: input,
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
    const activeSession = session;
    confirmClosed = sharedSeed?.retainSession();
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
    const finalizeUnaccepted = async (
      error: string,
      tokenComplete: boolean,
      failed = false,
    ): Promise<GoalResult> => {
      monitor?.stop();
      const status: AcceptedSubmissionMcpStatus = failed
        ? { checked: false, failures: "" }
        : await readAcceptedSubmissionMcpStatus(readMcpFailures);
      await finishSession();
      throwIfAborted(signal);
      if (submission !== undefined && !failed)
        return withDiagnostics(
          acceptedSubmissionResult(goal, submission, status, tokenUsageState.models, tokenComplete),
        );
      const retained = submission ?? retainedSubmission();
      const mcpFailed = status.error !== undefined || status.failures.length > 0;
      return withDiagnostics(
        withTokenUsage(
          {
            prompt: goal,
            status: failed || mcpFailed || retained === undefined ? "failed" : "incomplete",
            ...(retained === undefined ? {} : { submission: retained }),
            error:
              delivery !== undefined
                ? `Review stopped (${sessionPhase}${mcpFailed ? "; MCP status failed" : ""}).`
                : mcpFailed
                  ? `${error}; configured MCP status: ${status.error ?? status.failures}`
                  : error,
          },
          tokenUsageState.models,
          tokenComplete && readerFailure === undefined,
        ),
      );
    };
    let stalledMcpStatus = { checked: false, failures: "" };
    let stalledSubmissionFinalization: Promise<void> | undefined;
    const activeMonitor = createReviewSessionRecoveryMonitor({
      progress: () =>
        inspectionProgress() +
        evidenceLedger.uniqueSourceBytes +
        evidenceLedger.uniqueNativeLines +
        goalTools.contextPages(),
      onRecoveryFailure: (reason) => {
        recoveryFailure.resolve(reason);
      },
      snapshot: () => ({
        ...reviewSessionSnapshot(
          sessionPhase,
          lifecycle,
          recovery.repairAttempts,
          submission !== undefined,
          sessionState.stallBoundaryPending,
          delivery === undefined,
        ),
        ...inspectionDetails(),
        ...recoveryDetails(),
      }),
      write: (event, details) => {
        writeAgentMonitorEvent(
          goalIndex,
          event,
          delivery === undefined || details.error === undefined
            ? details
            : { ...details, error: "Runtime request failed." },
          logSecrets,
        );
      },
      hasAcceptedSubmission: () => submission !== undefined,
      setPhase: (phase) => {
        sessionPhase = phase;
      },
      finishAcceptedInput: () => {
        sessionState.expectedSessionClose = true;
        input.finish();
      },
      markBoundaryPending: () => {
        sessionState.stallBoundaryPending = true;
        sessionPhase = "waiting-for-interrupted-turn-boundary";
      },
      interrupt: () => activeSession.interrupt(),
      finalizeAcceptedSubmission: () => {
        stalledSubmission.resolve(undefined);
        stalledSubmissionFinalization = (async () => {
          stalledMcpStatus = await readAcceptedSubmissionMcpStatus(readMcpFailures);
          await finishSession();
        })();
        void stalledSubmissionFinalization.catch((error: unknown) => {
          turn.reject(error);
        });
      },
    });
    monitor = activeMonitor;
    activeMonitor.start();
    sessionPhase = "waiting-for-sdk-message";
    reader = (async () => {
      try {
        for await (const message of activeSession) {
          assertIndependentSession(message, sharedSeed);
          provider.observe(message);
          activeMonitor.observe(sdkSessionActivity(message, toolUses));
          if (message.type !== "active_goal" && delivery === undefined)
            logAgentMessageSafely(message, goalIndex, logSecrets, toolUses);
          logAgentEventSafely(goalIndex, logSecrets, (write) => {
            logAgentLifecycleMessage(
              message,
              goalIndex,
              logSecrets,
              lifecycle,
              delivery !== undefined
                ? (line) => {
                    if (
                      !line.includes("turn-result errors:") &&
                      !line.includes("compaction-result error:") &&
                      !line.includes("goal-iteration details:")
                    )
                      write(line);
                  }
                : write,
            );
          });
          if (isReviewActive()) recovery.observeMessage(message, observeRejection);
          if (message.type === "result") {
            if (
              delivery !== undefined &&
              config.executor !== "codex" &&
              message.subtype === "success" &&
              message.num_turns === 0 &&
              !delivery.advanceRequested &&
              !sessionState.stallBoundaryPending &&
              provider.failure(message) === undefined
            )
              continue;
            if (submission !== undefined) activeMonitor.stop();
            const snapshot = sharedModelUsage(message.modelUsage, config.executor, sharedSeed);
            tokenUsageState.latestSnapshotValid =
              modelUsageSince(snapshot, tokenUsageState.models) !== undefined;
            if (snapshot !== undefined && tokenUsageState.latestSnapshotValid)
              tokenUsageState.models = snapshot;
            if (provider.failure(message) !== undefined)
              tokenUsageState.latestSnapshotValid = false;
            const completedTurn = turn;
            turn = createDeferred<SDKResultMessage>();
            completedTurn.resolve(message);
          }
        }
      } catch (error) {
        readerFailure = error instanceof Error ? error : new Error(errorMessage(error));
        turn.reject(readerFailure);
      } finally {
        if (signal?.aborted) turn.reject(signal.reason);
        else if (!sessionState.expectedSessionClose && readerFailure === undefined) {
          turn.reject(
            new Error(
              "The " +
                (config.executor ?? "claude") +
                " message stream ended before a terminal result.",
            ),
          );
        }
      }
    })();
    throwIfAborted(signal);
    startReviewPrompt(
      input,
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
    sessionPhase = "waiting-for-turn-result";
    for (;;) {
      const outcome = await Promise.race([
        turn.promise.then((result) => ({ kind: "result" as const, result })),
        recoveryExhausted.promise.then(() => ({ kind: "recovery-exhausted" as const })),
        stalledSubmission.promise.then(() => ({ kind: "stalled-submission" as const })),
        recoveryFailure.promise.then((reason) => ({ kind: "recovery-failed" as const, reason })),
      ]);
      throwIfAborted(signal);
      if (outcome.kind === "recovery-failed") {
        sessionPhase = outcome.reason;
        return await finalizeUnaccepted(
          outcome.reason === "interrupt-timeout"
            ? "The stalled session did not finish its interrupted turn within 30 seconds."
            : "The goal stalled again after two recovery attempts.",
          false,
          true,
        );
      }
      if (outcome.kind === "stalled-submission" || stalledSubmissionFinalization !== undefined) {
        const acceptedSubmission = submission;
        if (acceptedSubmission === undefined) {
          throw new Error("The SDK session closed for stall recovery without an accepted review.");
        }
        activeMonitor.stop();
        sessionPhase = "finalizing-accepted-submission";
        if (stalledSubmissionFinalization !== undefined) await stalledSubmissionFinalization;
        await finishSession();
        throwIfAborted(signal);
        writeAgentMonitorEvent(
          goalIndex,
          "submission-finalized",
          acceptedSubmissionDetails(
            activeMonitor.recoveryCount,
            false,
            undefined,
            stalledMcpStatus,
            false,
          ),
          logSecrets,
        );
        return withDiagnostics(
          acceptedSubmissionResult(
            goal,
            acceptedSubmission,
            stalledMcpStatus,
            tokenUsageState.models,
            false,
          ),
        );
      }
      if (outcome.kind === "recovery-exhausted") {
        sessionPhase = recovery.exhaustionReason ?? "repair-exhausted";
        return await finalizeUnaccepted(`Review recovery stopped: ${sessionPhase}.`, false);
      }
      const { result } = outcome;
      const providerFailure = provider.failure(result);
      const continueSweep = await delivery?.boundary();
      const claudeNativeTurns = activeSession.nativeModelTurns?.();
      if (
        claudeNativeTurns !== undefined &&
        (claudeNativeTurns > config.maxTurns ||
          (claudeNativeTurns === config.maxTurns && submission === undefined)) &&
        providerFailure === undefined
      ) {
        sessionPhase = "max-turns-exhausted";
        return await finalizeUnaccepted(
          "The review reached the configured runtime turn limit.",
          tokenUsageState.latestSnapshotValid,
          submission !== undefined,
        );
      }
      const interrupted = sessionState.stallBoundaryPending;
      if (interrupted) {
        activeMonitor.interruptedTurnFinished();
        sessionState.stallBoundaryPending = false;
      }
      if (interrupted && providerFailure === undefined) {
        writeAgentMonitorEvent(
          goalIndex,
          "interrupted-turn-boundary",
          {
            recovery: activeMonitor.recoveryCount,
            result_subtype: result.subtype,
            submission_accepted: submission !== undefined,
          },
          logSecrets,
        );
        if (submission !== undefined) {
          const acceptedSubmission = submission;
          sessionPhase = "finalizing-interrupted-submission";
          activeMonitor.stop();
          const interruptedMcpStatus = await readAcceptedSubmissionMcpStatus(readMcpFailures);
          throwIfAborted(signal);
          await finishSession();
          throwIfAborted(signal);
          writeAgentMonitorEvent(
            goalIndex,
            "submission-finalized",
            acceptedSubmissionDetails(
              activeMonitor.recoveryCount,
              true,
              result.subtype,
              interruptedMcpStatus,
              readerFailure === undefined && tokenUsageState.latestSnapshotValid,
            ),
            logSecrets,
          );
          return withDiagnostics(
            acceptedSubmissionResult(
              goal,
              acceptedSubmission,
              interruptedMcpStatus,
              tokenUsageState.models,
              readerFailure === undefined && tokenUsageState.latestSnapshotValid,
            ),
          );
        }
        if (result.subtype === "error_max_turns" || recovery.exhausted) {
          sessionPhase =
            result.subtype === "error_max_turns"
              ? "max-turns-exhausted"
              : (recovery.exhaustionReason ?? "repair-exhausted");
          return await finalizeUnaccepted(
            "Review recovery stopped at the configured limit.",
            tokenUsageState.latestSnapshotValid,
          );
        }
        sessionPhase = "waiting-for-continuation-result";
        queueMessage(
          "The previous turn was interrupted because it stopped making progress. Continue the same goal from the current session state. Re-read evidence only when needed, then submit exactly once through the required output tool.",
          `stall-continuation-${activeMonitor.recoveryCount}`,
        );
        writeAgentMonitorEvent(
          goalIndex,
          "continuation-queued",
          {
            recovery: activeMonitor.recoveryCount,
            interrupted_result_subtype: result.subtype,
            repair_attempts: recovery.repairAttempts,
          },
          logSecrets,
        );
        continue;
      }
      if (providerFailure !== undefined) {
        recovery.finishProviderTurn();
        const delay = submission === undefined ? provider.retryDelay(providerFailure) : undefined;
        if (delay === undefined) {
          sessionPhase =
            providerFailure.retryable && submission === undefined
              ? "provider-retries-exhausted"
              : "provider-error";
          return await finalizeUnaccepted(
            providerFailure.message,
            tokenUsageState.latestSnapshotValid,
            true,
          );
        }
        sessionPhase = "waiting-for-provider-retry";
        activeMonitor.pause();
        writeAgentMonitorEvent(
          goalIndex,
          "provider-retry",
          {
            retry: provider.retries,
            max_retries: 2,
            retry_delay_ms: delay,
            error_status: providerFailure.status,
            error: providerFailure.category,
          },
          logSecrets,
        );
        await waitForProviderRetry(delay, signal, accepted.promise);
        throwIfAborted(signal);
        activeMonitor.resume();
        if (submission !== undefined) {
          sessionPhase = "provider-error";
          return await finalizeUnaccepted(
            providerFailure.message,
            tokenUsageState.latestSnapshotValid,
            true,
          );
        }
        sessionPhase = "waiting-for-continuation-result";
        queueMessage(
          "The model provider request failed temporarily. Continue the same review from the existing evidence and exact next calls in read_review_state, then submit through submit_review.",
          `provider-retry-${provider.retries}`,
        );
        continue;
      }
      if (result.subtype !== "success") {
        sessionPhase =
          result.subtype === "error_max_turns" ? "max-turns-exhausted" : "finalizing-failed-turn";
        return await finalizeUnaccepted(
          result.errors.join("; ") || `${config.executor ?? "claude"} returned ${result.subtype}.`,
          tokenUsageState.latestSnapshotValid,
          result.subtype !== "error_max_turns",
        );
      }
      if (submission !== undefined) {
        sessionPhase = "checking-mcp-status";
        activeMonitor.stop();
        const mcpStatus = await readAcceptedSubmissionMcpStatus(readMcpFailures);
        throwIfAborted(signal);
        await finishSession();
        throwIfAborted(signal);
        return withDiagnostics(
          acceptedSubmissionResult(
            goal,
            submission,
            mcpStatus,
            tokenUsageState.models,
            readerFailure === undefined && tokenUsageState.latestSnapshotValid,
          ),
        );
      }
      const nextContext = continueSweep ? delivery?.nextMessage() : undefined;
      if (nextContext !== undefined) {
        const message = makeUserMessage(nextContext.text);
        input.push(nextContext.packet ? { ...message, client_composed: true } : message);
        continue;
      }
      recovery.observeProgress(inspectionProgress(), evidenceLedger.deliveryEpoch);
      const recoveryKind = recovery.finishTurn();
      if (recovery.exhausted) {
        sessionPhase = recovery.exhaustionReason ?? "repair-exhausted";
        return await finalizeUnaccepted(
          `Review recovery stopped: ${sessionPhase}.`,
          tokenUsageState.latestSnapshotValid,
        );
      }
      throwIfAborted(signal);
      sessionPhase = "waiting-for-repair-result";
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
      !sessionPhase.startsWith("provider-") &&
      sessionPhase !== "interrupt-timeout" &&
      sessionPhase !== "stall-recovery-exhausted"
    )
      sessionPhase = "failed";
    let failure = readerFailure?.message ?? errorMessage(error);
    try {
      await finishSession();
    } catch (cleanupError) {
      if (cleanupError !== error)
        failure += `; session cleanup failed: ${errorMessage(cleanupError)}`;
    }
    throwIfAborted(signal);
    if (delivery !== undefined) failure = `Review stopped (${sessionPhase}).`;
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
    monitor?.stop();
    evidenceLedger.clearPendingNativeReads();
    void closeSession();
    signal?.removeEventListener("abort", abortTurn);
    writeAgentSessionEndLog(
      goalIndex,
      lifecycle,
      reviewPromptActive,
      recovery.repairAttempts,
      submission !== undefined,
      monitor?.recoveryCount ?? 0,
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
