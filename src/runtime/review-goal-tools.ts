import type { PreparedContextFile } from "../lib/context-files.js";
import type { ReviewConversationSnapshot } from "../lib/review-context.js";
import type { ChangedFile, PullRequestContext, ReviewConfig } from "../lib/types.js";
import {
  PullRequestConversationReader,
  PullRequestDiffReader,
  type PullRequestDiffArtifact,
} from "./agent-review-tools.js";
import type { ReviewBriefingReader } from "./review-briefing.js";
import type { ReviewEvidenceLedger, ReviewValidationGap } from "./review-assessment.js";
import {
  ReviewQueryReaderStore,
  createReviewContextTools,
  createReviewSourceTools,
  createReviewStateTool,
  createReviewThreadTool,
} from "./review-context-tools.js";
import {
  unreadReviewFindingPaths,
  reviewSubmissionGaps,
  type ReviewSubmissionRecovery,
} from "./review-submission.js";
import type { RepositorySnapshot } from "./repository-snapshot.js";
import { createRepositoryDiscoveryTools } from "./repository-discovery-tools.js";

export function createReviewGoalTools({
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
  onSnapshot,
}: {
  context: PullRequestContext;
  files: readonly ChangedFile[];
  conversation: ReviewConversationSnapshot;
  config: ReviewConfig;
  contextFiles: readonly PreparedContextFile[];
  diff: PullRequestDiffArtifact;
  repositorySnapshot: RepositorySnapshot;
  evidenceLedger: ReviewEvidenceLedger;
  briefingReader: ReviewBriefingReader;
  signal: AbortSignal | undefined;
  isReviewActive: () => boolean;
  recovery: ReviewSubmissionRecovery;
  onSnapshot: (details: Readonly<Record<string, unknown>>) => void;
}) {
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
    isActive: isReviewActive,
    signal,
    briefingReader,
    conversationReader: new PullRequestConversationReader(conversation),
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
    isActive: isReviewActive,
    files,
    headSha: context.headSha,
    mergeBaseSha: diff.mergeBaseSha,
    briefingComplete: () => briefingReader.complete,
    ledger: evidenceLedger,
    readers: queryReaders,
    recovery,
    diff,
    onSnapshot,
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
      (path) =>
        queryReaders.continuation(
          discussionQueryCursors.get(`path:${discussionPathScope(path)}`) ?? "",
        ) ?? { tool: "read_pr_threads", arguments: { path } },
    );
  }
  return {
    tools: [
      briefingTool,
      reviewStateTool,
      conversationTool,
      diffTool,
      repositoryFileTool,
      discussionThreadTool,
      ...(contextFileTool === undefined ? [] : [contextFileTool]),
    ],
    repositoryTools:
      config.executor === "codex"
        ? createRepositoryDiscoveryTools({
            snapshot: repositorySnapshot,
            readers: queryReaders,
            isActive: isReviewActive,
            signal,
          })
        : [],
    hasContextFiles: contextFileTool !== undefined,
    unreadFindingPaths,
    submissionGaps,
    inspectionProgress,
    contextPages: () => contextPages,
    cleanupOperations: () => [
      ...Array.from(contextReaders.values(), ({ reader }) => reader.close()),
      ...queryReaders.cleanupOperations(),
    ],
  };
}
