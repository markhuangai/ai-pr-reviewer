import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

import type {
  Options,
  SDKActiveGoalMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { cancellationReason, CancellationError } from "../src/lib/bootstrap/cancellation.js";
import {
  agentInternals,
  runReviewGoal,
  runReviewGoals,
  type AgentQuery,
} from "../src/runtime/agent.js";
import type { PreparedContextFile } from "../src/lib/context-files.js";
import type { ConversationMessage, ReviewConversationSnapshot } from "../src/lib/review-context.js";
import { streamGitToFile } from "../src/runtime/git-stream.js";
import {
  RepositorySnapshot,
  repositorySnapshotInternals,
} from "../src/runtime/repository-snapshot.js";
import type {
  ChangedFile,
  PullRequestContext,
  ReviewBriefing,
  ReviewConfig,
} from "../src/lib/types.js";

export {
  CancellationError,
  RepositorySnapshot,
  access,
  agentInternals,
  assert,
  cancellationReason,
  chmod,
  delimiter,
  join,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  repositorySnapshotInternals,
  rm,
  runReviewGoal,
  runReviewGoals,
  stat,
  streamGitToFile,
  symlink,
  test,
  tmpdir,
  writeFile,
};
export type {
  AgentQuery,
  ChangedFile,
  ConversationMessage,
  Options,
  PreparedContextFile,
  PullRequestContext,
  ReviewBriefing,
  ReviewConfig,
  ReviewConversationSnapshot,
  SDKActiveGoalMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  TestContext,
};

export const execFileAsync = promisify(execFile);

export const emptyConversation: ReviewConversationSnapshot = {
  digest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8eacb808f73f18510b2e0b23",
  entries: [],
};

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

export async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "."]);
  await git(cwd, [
    "-c",
    "user.name=Test User",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--quiet",
    `--message=${message}`,
  ]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

export interface TestRepository {
  readonly root: string;
  readonly temporaryRoot: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly context: PullRequestContext;
}

export async function makeRepository(
  t: TestContext,
  change: (root: string) => Promise<void>,
  prepareBase?: (root: string) => Promise<void>,
): Promise<TestRepository> {
  const parent = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-agent-test-"));
  t.after(() => rm(parent, { force: true, recursive: true }));
  const root = join(parent, "repository");
  const temporaryRoot = join(parent, "temporary");
  await mkdir(root);
  await mkdir(temporaryRoot);
  await git(root, ["init", "--quiet"]);
  await writeFile(join(root, "review.txt"), "base\n");
  await prepareBase?.(root);
  const baseSha = await commit(root, "base");
  await change(root);
  const headSha = await commit(root, "head");
  return {
    root,
    temporaryRoot,
    baseSha,
    headSha,
    context: {
      repository: "owner/repository",
      owner: "owner",
      name: "repository",
      number: 1,
      baseSha,
      headSha,
      baseRef: "main",
      title: "Large change",
      htmlUrl: "https://github.com/owner/repository/pull/1",
    },
  };
}

export async function readCompleteDiff(
  reader: InstanceType<typeof agentInternals.PullRequestDiffReader>,
): Promise<{ readonly pages: number; readonly content: string }> {
  let content = "";
  let pages = 0;
  try {
    while (!reader.complete) {
      const page = await reader.readNext();
      pages += 1;
      content += page.content;
      assert.equal(page.page, pages);
    }
  } finally {
    await reader.close();
  }
  return { pages, content };
}

export interface RegisteredTool {
  handler(input: Record<string, unknown>): Promise<{
    readonly content: readonly { readonly type: string; readonly text?: string }[];
    readonly isError?: boolean;
  }>;
}

export type RegisteredToolResult = Awaited<ReturnType<RegisteredTool["handler"]>>;

export async function callRegisteredTool(
  registeredTool: RegisteredTool,
  input: Record<string, unknown>,
): Promise<RegisteredToolResult> {
  return registeredTool.handler(input);
}

export interface FakeQueryScenario {
  readonly submission?: Record<string, unknown>;
  readonly resultSubtypes?: readonly string[];
  readonly modelUsages?: readonly Readonly<Record<string, Readonly<Record<string, unknown>>>>[];
  readonly mcpStatuses?: readonly Record<string, unknown>[];
  readonly readerError?: Error;
  readonly readerErrorAfterResults?: Error;
  readonly queryError?: Error;
  readonly preflightTools?: boolean;
  readonly inspectOptions?: (options: Options) => void;
  readonly inspectPrompts?: (messages: readonly SDKUserMessage[]) => void;
  readonly contextFilePath?: string;
  readonly expectedContextFileContent?: string;
  readonly unauthorizedContextFilePath?: string;
  readonly assertContextToolResultsBounded?: boolean;
  readonly skipConversationRead?: boolean;
  readonly readThreadId?: number;
  readonly readThreadPath?: string;
  readonly readThreadFirstOnly?: boolean;
  readonly repeatThreadSelector?: boolean;
  readonly assertUnreadThreadAfterId?: boolean;
  readonly assertUnreadThreadRejection?: boolean;
  readonly readDiffPath?: string;
  readonly readRepositoryFilePath?: string;
  readonly probeThreadErrors?: boolean;
  readonly probeUnknownCursor?: boolean;
}

export function fakeAgentQuery(scenario: FakeQueryScenario): AgentQuery {
  return ((input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: Options;
  }) => {
    if (scenario.queryError) throw scenario.queryError;
    scenario.inspectOptions?.(input.options);
    const messages = input.prompt[Symbol.asyncIterator]();
    const outputServer = input.options.mcpServers?.review_output as unknown as {
      readonly instance: {
        readonly _registeredTools: Readonly<Record<string, RegisteredTool>>;
      };
    };
    const tools = outputServer.instance._registeredTools;
    const preflight = scenario.preflightTools
      ? Promise.all([
          tools.read_review_briefing?.handler({}),
          tools.read_pr_conversation?.handler({}),
          tools.read_pr_diff?.handler({}),
          tools.read_repository_file?.handler({ revision: "head", path: "review.txt" }),
          tools.read_pr_threads?.handler({}),
          tools.submit_review?.handler({}),
        ])
      : undefined;
    const preflightContextFile =
      scenario.preflightTools && scenario.contextFilePath !== undefined
        ? tools.read_context_file?.handler({ path: scenario.contextFilePath })
        : undefined;
    const session = {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
        const goalMessage = await messages.next();
        const reviewMessage = await messages.next();
        assert.equal(goalMessage.done, false);
        assert.equal(reviewMessage.done, false);
        scenario.inspectPrompts?.([goalMessage.value, reviewMessage.value]);
        if (preflight !== undefined) {
          const [
            briefingResult,
            conversationResult,
            diffResult,
            repositoryFileResult,
            threadResult,
            submitResult,
          ] = await preflight;
          assert.equal(
            briefingResult?.content[0]?.text,
            "Wait for the full review prompt before reading.",
          );
          assert.equal(
            conversationResult?.content[0]?.text,
            "Wait for the full review prompt before reading.",
          );
          assert.equal(
            diffResult?.content[0]?.text,
            "Wait for the full review prompt before reading.",
          );
          assert.equal(
            repositoryFileResult?.content[0]?.text,
            "Wait for the full review prompt before reading.",
          );
          assert.equal(
            threadResult?.content[0]?.text,
            "Wait for the full review prompt before reading.",
          );
          assert.equal(
            submitResult?.content[0]?.text,
            "Wait for the full review prompt before submitting.",
          );
        }
        if (preflightContextFile !== undefined) {
          const result = await preflightContextFile;
          assert.equal(result.content[0]?.text, "Wait for the full review prompt before reading.");
        }
        if (scenario.readerError) throw scenario.readerError;
        if (scenario.submission !== undefined) {
          const conversationTool = tools.read_pr_conversation;
          const diffTool = tools.read_pr_diff;
          const repositoryFileTool = tools.read_repository_file;
          const threadTool = tools.read_pr_threads;
          const briefingTool = tools.read_review_briefing;
          const submitTool = tools.submit_review;
          assert.ok(conversationTool);
          if (
            diffTool === undefined ||
            repositoryFileTool === undefined ||
            threadTool === undefined
          )
            throw new Error("The fixed repository tools were not registered.");
          assert.ok(briefingTool);
          assert.ok(submitTool);
          let briefingDone = false;
          while (!briefingDone) {
            const result = await briefingTool.handler({});
            const page = JSON.parse(result.content[0]?.text ?? "{}") as { readonly done?: unknown };
            briefingDone = page.done === true;
          }
          if (scenario.contextFilePath !== undefined) {
            const contextFileTool = tools.read_context_file;
            assert.ok(contextFileTool);
            let contextDone = false;
            let contextContent = "";
            let expectedPage = 1;
            while (!contextDone) {
              const result: RegisteredToolResult = await contextFileTool.handler({
                path: scenario.contextFilePath,
              });
              if (scenario.assertContextToolResultsBounded) assert.equal(result.isError, undefined);
              const page = JSON.parse(result.content[0]?.text ?? "{}") as {
                readonly path?: unknown;
                readonly page?: unknown;
                readonly content?: unknown;
                readonly done?: unknown;
              };
              assert.equal(page.path, scenario.contextFilePath);
              assert.equal(page.page, expectedPage);
              assert.equal(typeof page.content, "string");
              contextContent += page.content as string;
              contextDone = page.done === true;
              expectedPage += 1;
            }
            assert.equal(contextContent, scenario.expectedContextFileContent);
            if (scenario.unauthorizedContextFilePath !== undefined) {
              const denied = await contextFileTool.handler({
                path: scenario.unauthorizedContextFilePath,
              });
              assert.equal(denied.isError, true);
              assert.match(denied.content[0]?.text ?? "", /not authorized/u);
            }
          }
          if (scenario.probeUnknownCursor) {
            const unknown = await callRegisteredTool(diffTool, { cursor: "unknown-cursor" });
            assert.equal(unknown.isError, true);
          }
          if (scenario.readDiffPath !== undefined) {
            let done = false;
            let cursor: string | undefined;
            while (!done) {
              const result = await callRegisteredTool(
                diffTool,
                cursor === undefined ? { paths: [scenario.readDiffPath] } : { cursor },
              );
              assert.equal(result.isError, undefined);
              const page = JSON.parse(result.content[0]?.text ?? "{}") as {
                readonly done?: unknown;
                readonly nextCursor?: unknown;
              };
              done = page.done === true;
              cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
            }
          }
          if (scenario.readRepositoryFilePath !== undefined) {
            let done = false;
            let cursor: string | undefined;
            while (!done) {
              const result = await callRegisteredTool(
                repositoryFileTool,
                cursor === undefined
                  ? { revision: "head", path: scenario.readRepositoryFilePath }
                  : { revision: "head", path: scenario.readRepositoryFilePath, cursor },
              );
              assert.equal(result.isError, undefined);
              const page = JSON.parse(result.content[0]?.text ?? "{}") as {
                readonly done?: unknown;
                readonly nextCursor?: unknown;
              };
              done = page.done === true;
              cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
            }
          }
          if (scenario.probeThreadErrors) {
            const selectorError = await threadTool.handler({});
            assert.equal(selectorError.isError, true);
            const missing = await threadTool.handler({ id: 999 });
            assert.equal(missing.isError, true);
          }
          if (!scenario.skipConversationRead) {
            let conversationDone = false;
            while (!conversationDone) {
              const result = await conversationTool.handler({});
              const page = JSON.parse(result.content[0]?.text ?? "{}") as {
                readonly done?: unknown;
              };
              conversationDone = page.done === true;
            }
          }
          if (scenario.assertUnreadThreadRejection) {
            const rejected = await submitTool.handler(scenario.submission);
            assert.match(rejected.content[0]?.text ?? "", /Read prior discussion threads/u);
          }
          if (scenario.readThreadId !== undefined || scenario.readThreadPath !== undefined) {
            const threadTool = tools.read_pr_threads;
            assert.ok(threadTool);
            const selectors: readonly Readonly<Record<string, unknown>>[] = [
              ...(scenario.readThreadId === undefined ? [] : [{ id: scenario.readThreadId }]),
              ...(scenario.readThreadPath === undefined ? [] : [{ path: scenario.readThreadPath }]),
            ];
            for (const selector of selectors) {
              let threadDone = false;
              let threadCursor: string | undefined;
              let repeatedSelector = false;
              while (!threadDone) {
                const startingCursor = threadCursor;
                const result = await threadTool.handler(
                  startingCursor === undefined ? selector : { cursor: startingCursor },
                );
                const page = JSON.parse(result.content[0]?.text ?? "{}") as {
                  readonly done?: unknown;
                  readonly nextCursor?: unknown;
                };
                threadDone = page.done === true;
                threadCursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
                if (
                  scenario.repeatThreadSelector &&
                  !repeatedSelector &&
                  startingCursor === undefined &&
                  !threadDone &&
                  threadCursor !== undefined
                ) {
                  const repeated = await threadTool.handler(selector);
                  const repeatedPage = JSON.parse(repeated.content[0]?.text ?? "{}") as {
                    readonly reused?: unknown;
                    readonly nextCursor?: unknown;
                  };
                  assert.equal(repeatedPage.reused, true);
                  assert.equal(repeatedPage.nextCursor, threadCursor);
                  repeatedSelector = true;
                }
                if (scenario.readThreadFirstOnly && !threadDone && threadCursor !== undefined) {
                  const rejected = await submitTool.handler(scenario.submission);
                  assert.match(rejected.content[0]?.text ?? "", /Read prior discussion threads/u);
                }
              }
              if (scenario.assertUnreadThreadAfterId && "id" in selector) {
                const rejected = await submitTool.handler(scenario.submission);
                assert.match(rejected.content[0]?.text ?? "", /Read prior discussion threads/u);
              }
            }
          }
          let diffDone = false;
          while (!diffDone) {
            const result = await diffTool.handler({});
            const page = JSON.parse(result.content[0]?.text ?? "{}") as { readonly done?: unknown };
            diffDone = page.done === true;
          }
          const result = await submitTool.handler(scenario.submission);
          assert.equal(result.content[0]?.text, "Review submission accepted.");
        }
        const subtypes = scenario.resultSubtypes ?? ["success"];
        for (let index = 0; index < subtypes.length; index += 1) {
          const subtype = subtypes[index] ?? "success";
          yield {
            type: "result",
            subtype,
            errors: subtype === "success" ? [] : [`provider returned ${subtype}`],
            num_turns: index + 1,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: subtype !== "success",
            session_id: "test-session",
            uuid: `result-${index}`,
            modelUsage: scenario.modelUsages?.[index] ?? {
              "review-model": {
                inputTokens: 10 * (index + 1),
                outputTokens: 2 * (index + 1),
                cacheReadInputTokens: 4 * (index + 1),
                cacheCreationInputTokens: index + 1,
                canonicalModel: "canonical-review-model",
              },
            },
          } as unknown as SDKResultMessage;
          if (index + 1 < subtypes.length) assert.equal((await messages.next()).done, false);
        }
        if (scenario.readerErrorAfterResults) throw scenario.readerErrorAfterResults;
      },
      mcpServerStatus: () => Promise.resolve(scenario.mcpStatuses ?? []),
    };
    return session;
  }) as unknown as AgentQuery;
}

export function reviewConfig(overrides: Partial<ReviewConfig> = {}): ReviewConfig {
  return {
    githubToken: "github-secret",
    aiBaseUrl: "https://ai.example.test",
    aiSecret: "ai-secret",
    model: "review-model",
    reviewPrompts: [{ prompt: "correctness", files: [] }],
    parallelCount: 1,
    maxTurns: 2,
    autoApprove: false,
    interactWithPullRequest: false,
    mcpServers: {},
    ...overrides,
  };
}

export async function makeReviewDiff(
  t: TestContext,
  content = "diff --git a/src/change.ts b/src/change.ts\n+changed\n",
): Promise<Parameters<typeof runReviewGoal>[6]> {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-goal-diff-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "pull-request.diff");
  await writeFile(path, content);
  return {
    mergeBaseSha: "a".repeat(40),
    path,
    size: Buffer.byteLength(content),
    createReader: () => new agentInternals.PullRequestDiffReader(path, Buffer.byteLength(content)),
    cleanup: () => rm(root, { recursive: true, force: true }),
  } as Parameters<typeof runReviewGoal>[6];
}

export const goalContext: PullRequestContext = {
  repository: "owner/repository",
  owner: "owner",
  name: "repository",
  number: 8,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  baseRef: "main",
  title: "Goal execution",
  htmlUrl: "https://github.com/owner/repository/pull/8",
};
