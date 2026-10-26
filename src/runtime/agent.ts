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
import {
  PullRequestConversationReader,
  type PullRequestDiffArtifact,
  PullRequestDiffReader,
} from "./agent-review-tools.js";
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
  unreadReviewFindingPaths,
  reviewSubmissionGaps,
  reviewSubmissionRejectionResult,
} from "./review-submission.js";
import {
  ReviewQueryReaderStore,
  createReviewStateTool,
  createReviewThreadTool,
  createReviewContextTools,
  createReviewSourceTools,
} from "./review-context-tools.js";
import { RepositorySnapshot, repositoryGuidanceForRun } from "./repository-snapshot.js";
import { createReviewDiagnostics } from "./review-diagnostics.js";
import { tool } from "./review-tool.js";
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
import { createRepositoryDiscoveryTools } from "./repository-discovery-tools.js";
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
    recovery.observeProgress(inspectionProgress());
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
  const conversationReader = new PullRequestConversationReader(conversation);
  const reviewSnapshot = { mergeBaseSha: diff.mergeBaseSha, headSha: context.headSha };
  const evidenceLedger = new ReviewEvidenceLedger(cwd, files, reviewSnapshot, diff.files);
  if (sharedSeed !== undefined) evidenceLedger.inherit(sharedSeed.evidence);
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
    sessionRecovery: () => ({
      ...provider.diagnostics,
      stallRecoveries: monitor?.recoveryCount ?? 0,
    }),
    sourceContextDelivered: () =>
      sharedSeed === undefined ||
      lifecycle.sessionId !== undefined ||
      evidenceLedger.issued.size > sharedSeed.evidence.references.length,
  });
  const evidenceHook: HookCallback = (input) => {
    if (input.hook_event_name !== "PostToolBatch") return Promise.resolve({ continue: true });
    const references = evidenceLedger.observeBatch(input.tool_calls);
    recovery.observeProgress(inspectionProgress());
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
  const submissionHook: HookCallback = (input) => {
    if (input.hook_event_name !== "PreToolUse" || !reviewPromptActive || submission !== undefined)
      return Promise.resolve({ continue: true });
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
    briefing.repositoryGuidance ??
    (await repositoryGuidanceForRun(diff, repositorySnapshot, files));
  const briefingReader = new ReviewBriefingReader(context, files, conversation, {
    ...briefing,
    repositoryGuidance,
  });
  if (sharedSeed !== undefined) briefingReader.inherit(sharedSeed.briefing);
  const discussionQueryCursors = new Map<string, string>();
  const queryReaderDiscussionKeys = new Map<string, string>();
  const detachDiscussionQuery = (cursor: string): void => {
    const discussionKey = queryReaderDiscussionKeys.get(cursor);
    queryReaderDiscussionKeys.delete(cursor);
    if (discussionKey !== undefined && discussionQueryCursors.get(discussionKey) === cursor)
      discussionQueryCursors.delete(discussionKey);
  };
  const queryReaders = new ReviewQueryReaderStore(detachDiscussionQuery, signal);
  const discussionReadPaths = new Set<string>();
  const discussionReadThreadIds = new Set<number>();
  const discussionPages = new Set<string>();
  let contextPages = 0;
  const inspectionProgress = () =>
    evidenceLedger.inspectionProgress + briefingReader.deliveredPages + discussionPages.size;
  const discussionPathScopes = new Map<string, string>();
  for (const file of files) {
    discussionPathScopes.set(file.path, file.path);
    if (file.previousPath !== undefined) discussionPathScopes.set(file.previousPath, file.path);
  }
  const discussionPathScope = (path: string): string => discussionPathScopes.get(path) ?? path;
  const contextReaders = new Map(
    contextFiles.map((file) => [
      file.path,
      { file, reader: new PullRequestDiffReader(file.snapshotPath, file.sizeBytes, signal) },
    ]),
  );
  if (contextReaders.size !== contextFiles.length) {
    throw new Error("A review goal must not contain duplicate prepared context files.");
  }
  const { conversationTool, briefingTool, contextFileTool } = createReviewContextTools({
    isActive: () => reviewPromptActive,
    signal,
    briefingReader,
    conversationReader,
    contextReaders,
    onConversationComplete: () => {
      for (const entry of conversation.entries)
        if (entry.kind === "inline_thread")
          discussionReadPaths.add(discussionPathScope(entry.path));
    },
    onDiscussionPage: (page) => {
      discussionPages.add(`conversation:${page}`);
    },
    onContextPage: () => {
      contextPages++;
    },
  });
  const reviewStateTool = createReviewStateTool({
    signal,
    isActive: () => reviewPromptActive,
    files,
    headSha: context.headSha,
    mergeBaseSha: diff.mergeBaseSha,
    briefingComplete: () => briefingReader.complete,
    ledger: evidenceLedger,
    readers: queryReaders,
    recovery,
    diff,
    onSnapshot: (details) => {
      logDiagnostic("recovery-decision", details);
    },
    gaps: () => (recovery.submissionAttempts === 0 ? [] : submissionGaps(recovery.latestInput)),
  });
  const { diffTool, repositoryFileTool } = createReviewSourceTools({
    signal,
    isActive: isReviewActive,
    diff,
    headSha: context.headSha,
    queryReaders,
    repositorySnapshot,
    ledger: evidenceLedger,
  });
  const discussionThreadTool = createReviewThreadTool({
    isActive: isReviewActive,
    signal,
    conversation,
    queryReaders,
    discussionPathScope,
    discussionReadPaths,
    discussionReadThreadIds,
    discussionQueryCursors,
    queryReaderDiscussionKeys,
    onPage: (selector, page) => {
      discussionPages.add(`${JSON.stringify(selector)}:${page}`);
    },
  });
  const unreadFindingPaths = (findings: readonly unknown[]): readonly string[] =>
    unreadReviewFindingPaths(
      findings,
      conversation,
      discussionPathScope,
      discussionReadPaths,
      discussionReadThreadIds,
    );
  function submissionGaps(input: unknown): readonly ReviewValidationGap[] {
    return reviewSubmissionGaps(
      input,
      files,
      evidenceLedger,
      config.interactWithPullRequest,
      briefingReader.complete,
      unreadFindingPaths,
      recovery.limitationReconsiderationPending,
      (path) =>
        queryReaders.continuation(
          discussionQueryCursors.get(`path:${discussionPathScope(path)}`) ?? "",
        ) ?? { tool: "read_pr_threads", arguments: { path } },
    );
  }
  const outputTool = tool(
    "submit_review",
    "Submit summary, findings with their own evidenceRefs, countercheck and counterevidenceRefs, and limitations. The host requires a changed-code scan. Validation allows one initial failure plus five corrections; inspection has separate bounded recovery.",
    (config.interactWithPullRequest ? interactiveSubmissionSchema : submissionSchema).shape,
    (input): Promise<CallToolResult> => {
      throwIfAborted(signal);
      if (!reviewPromptActive || submission !== undefined) {
        return Promise.resolve({
          content: [
            {
              type: "text",
              text: reviewSubmissionRejection(
                reviewPromptActive,
                submission !== undefined,
              ) as string,
            },
          ],
        });
      }
      validationGaps = recovery.reconsiderLimitations(
        submissionGaps(input),
        input.limitations.length > 0,
      );
      if (validationGaps.length > 0) {
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
    briefingTool,
    reviewStateTool,
    conversationTool,
    diffTool,
    repositoryFileTool,
    discussionThreadTool,
    ...(contextFileTool === undefined ? [] : [contextFileTool]),
    outputTool,
    ...(config.executor !== "codex"
      ? []
      : createRepositoryDiscoveryTools({
          snapshot: repositorySnapshot,
          readers: queryReaders,
          isActive: isReviewActive,
          signal,
        })),
  ];
  const mcpServers = createReviewMcpServers(config, reviewTools, contextFileTool !== undefined);
  const input = new PromptStream();
  const queueMessage = (text: string, label: string): void => {
    const message = makeUserMessage(text);
    input.push(message);
    logAgentEventSafely(goalIndex, logSecrets, (write) => {
      logQueuedUserMessage(message, label, goalIndex, logSecrets, write);
    });
  };
  let turn = createDeferred<SDKResultMessage>();
  let readerFailure: Error | undefined;
  let reader: Promise<void> | undefined;
  let session: ReviewSession | undefined;
  let monitor: SdkSessionMonitor | undefined;
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
    const readMcpFailures = (): Promise<readonly string[]> =>
      readAcceptedSubmissionMcpFailures(() => activeSession.mcpServerStatus(), configuredMcpNames);
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
            error: mcpFailed
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
        contextPages,
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
        ),
        ...inspectionDetails(),
        ...recoveryDetails(),
      }),
      write: (event, details) => {
        writeAgentMonitorEvent(goalIndex, event, details, logSecrets);
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
          if (message.type !== "active_goal")
            logAgentMessageSafely(message, goalIndex, logSecrets, toolUses);
          logAgentEventSafely(goalIndex, logSecrets, (write) => {
            logAgentLifecycleMessage(message, goalIndex, logSecrets, lifecycle, write);
          });
          if (isReviewActive()) recovery.observeMessage(message, observeRejection);
          if (message.type === "result") {
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
      recovery.observeProgress(inspectionProgress());
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
      [
        ...Array.from(contextReaders.values(), ({ reader: contextReader }) =>
          contextReader.close(),
        ),
        ...queryReaders.cleanupOperations(),
        repositorySnapshot.cleanup(),
      ],
      goalIndex,
      logSecrets,
    );
  }
}
export const runReviewGoals = createReviewGoalsRunner(runReviewGoal, sdkQuery, runSharedDiscovery);
