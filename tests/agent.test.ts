import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

import {
  agentInternals,
  runReviewGoal,
  runReviewGoals,
  type AgentQuery,
} from "../src/runtime/agent.js";
import type { PreparedContextFile } from "../src/lib/context-files.js";
import type { ReviewConversationSnapshot } from "../src/lib/review-context.js";
import type { ChangedFile, PullRequestContext, ReviewConfig } from "../src/lib/types.js";

const execFileAsync = promisify(execFile);

const emptyConversation: ReviewConversationSnapshot = {
  digest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8eacb808f73f18510b2e0b23",
  entries: [],
};

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function commit(cwd: string, message: string): Promise<string> {
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

interface TestRepository {
  readonly root: string;
  readonly temporaryRoot: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly context: PullRequestContext;
}

async function makeRepository(
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

async function readCompleteDiff(
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

interface RegisteredTool {
  handler(input: Record<string, unknown>): Promise<{
    readonly content: readonly { readonly type: string; readonly text?: string }[];
    readonly isError?: boolean;
  }>;
}

interface FakeQueryScenario {
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
}

function fakeAgentQuery(scenario: FakeQueryScenario): AgentQuery {
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
          tools.read_pr_conversation?.handler({}),
          tools.read_pr_diff?.handler({}),
          tools.submit_review?.handler({}),
        ])
      : undefined;
    const session = {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
        const goalMessage = await messages.next();
        const reviewMessage = await messages.next();
        assert.equal(goalMessage.done, false);
        assert.equal(reviewMessage.done, false);
        scenario.inspectPrompts?.([goalMessage.value, reviewMessage.value]);
        if (preflight !== undefined) {
          const [conversationResult, diffResult, submitResult] = await preflight;
          assert.equal(
            conversationResult?.content[0]?.text,
            "Wait for the full review prompt before reading.",
          );
          assert.equal(
            diffResult?.content[0]?.text,
            "Wait for the full review prompt before reading.",
          );
          assert.equal(
            submitResult?.content[0]?.text,
            "Wait for the full review prompt before submitting.",
          );
        }
        if (scenario.readerError) throw scenario.readerError;
        if (scenario.submission !== undefined) {
          const conversationTool = tools.read_pr_conversation;
          const diffTool = tools.read_pr_diff;
          const submitTool = tools.submit_review;
          assert.ok(conversationTool);
          assert.ok(diffTool);
          assert.ok(submitTool);
          if (scenario.contextFilePath !== undefined) {
            const contextFileTool = tools.read_context_file;
            assert.ok(contextFileTool);
            let contextDone = false;
            let contextContent = "";
            let expectedPage = 1;
            while (!contextDone) {
              const result = await contextFileTool.handler({ path: scenario.contextFilePath });
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
          let conversationDone = false;
          while (!conversationDone) {
            const result = await conversationTool.handler({});
            const page = JSON.parse(result.content[0]?.text ?? "{}") as {
              readonly done?: unknown;
            };
            conversationDone = page.done === true;
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

function reviewConfig(overrides: Partial<ReviewConfig> = {}): ReviewConfig {
  return {
    githubToken: "github-secret",
    aiBaseUrl: "https://ai.example.test",
    aiSecret: "ai-secret",
    aiAuthMode: "api-key",
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

test("streams a complete diff larger than the former character budget", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    const lines = Array.from({ length: 8_000 }, (_, index) => `changed-${String(index)}-🙂`);
    await writeFile(join(root, "review.txt"), `${lines.join("\n")}\n`);
    await writeFile(join(root, "later.txt"), "final-file-content\n");
  });
  const artifact = await agentInternals.createPullRequestDiff(
    repository.context,
    repository.root,
    repository.temporaryRoot,
  );
  try {
    assert.ok(artifact.size > 30_000);
    const first = artifact.createReader();
    const second = artifact.createReader();
    const [firstResult, secondResult] = await Promise.all([
      readCompleteDiff(first),
      readCompleteDiff(second),
    ]);
    assert.ok(firstResult.pages > 1);
    assert.equal(firstResult.content, secondResult.content);
    assert.match(firstResult.content, /changed-7999-🙂/u);
    assert.match(firstResult.content, /final-file-content/u);
    assert.equal(firstResult.content.includes("�"), false);
  } finally {
    const artifactPath = artifact.path;
    await artifact.cleanup();
    await assert.rejects(access(artifactPath));
  }
});

test("ignores pull-request diff attributes while omitting binary contents", async (t) => {
  const repository = await makeRepository(
    t,
    async (root) => {
      await writeFile(join(root, ".gitattributes"), "* -diff\n");
      await writeFile(join(root, "review.txt"), "visible source change\n");
      await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 4]));
    },
    async (root) => {
      await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    },
  );
  const artifact = await agentInternals.createPullRequestDiff(
    repository.context,
    repository.root,
    repository.temporaryRoot,
  );
  try {
    const result = await readCompleteDiff(artifact.createReader());
    assert.match(result.content, /^\+\* -diff$/mu);
    assert.match(result.content, /^\+visible source change$/mu);
    assert.match(result.content, /Binary files/u);
    assert.equal(result.content.includes("\u0000"), false);
  } finally {
    await artifact.cleanup();
  }
});

test("returns one completed page for an empty diff", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "review.txt"), "head\n");
  });
  const artifact = await agentInternals.createPullRequestDiff(
    { ...repository.context, baseSha: repository.headSha },
    repository.root,
    repository.temporaryRoot,
  );
  try {
    const result = await readCompleteDiff(artifact.createReader());
    assert.equal(result.pages, 1);
    assert.equal(result.content, "");
  } finally {
    await artifact.cleanup();
  }
});

test("streams empty and multi-page Unicode pull request conversations", () => {
  const emptyReader = new agentInternals.PullRequestConversationReader(emptyConversation);
  assert.deepEqual(emptyReader.readNext(), {
    page: 1,
    content: '{"entries":[]}',
    done: true,
  });
  assert.equal(emptyReader.complete, true);
  assert.deepEqual(emptyReader.readNext(), { page: 1, content: "", done: true });

  const body = `Owner context: ${"🙂".repeat(20_000)}`;
  const reader = new agentInternals.PullRequestConversationReader({
    digest: "conversation-digest",
    entries: [
      {
        kind: "pr_comment",
        id: 1,
        createdAt: "2026-08-17T00:00:00Z",
        message: {
          id: 1,
          authorLogin: "owner",
          authorRole: "human",
          body,
          createdAt: "2026-08-17T00:00:00Z",
          updatedAt: "2026-08-17T00:00:00Z",
        },
      },
    ],
  });
  let content = "";
  let pages = 0;
  while (!reader.complete) {
    const page = reader.readNext();
    pages += 1;
    assert.equal(page.page, pages);
    content += page.content;
  }
  assert.ok(pages > 1);
  assert.equal(content.includes("�"), false);
  const parsed = JSON.parse(content) as { entries: [{ message: { body: string } }] };
  assert.equal(parsed.entries[0].message.body, body);
});

test("includes deletions and renames in the fenced Git diff", async (t) => {
  const repository = await makeRepository(
    t,
    async (root) => {
      await rm(join(root, "removed.txt"));
      await git(root, ["mv", "old-name.txt", "new-name.txt"]);
    },
    async (root) => {
      await writeFile(join(root, "removed.txt"), "removed content\n");
      await writeFile(join(root, "old-name.txt"), "renamed content\n");
    },
  );
  const artifact = await agentInternals.createPullRequestDiff(
    repository.context,
    repository.root,
    repository.temporaryRoot,
  );
  try {
    const result = await readCompleteDiff(artifact.createReader());
    assert.match(result.content, /deleted file mode/u);
    assert.match(result.content, /rename from old-name\.txt/u);
    assert.match(result.content, /rename to new-name\.txt/u);
  } finally {
    await artifact.cleanup();
  }
});

test("rejects non-full and unavailable commit SHAs", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "review.txt"), "head\n");
  });
  await assert.rejects(
    agentInternals.createPullRequestDiff(
      { ...repository.context, baseSha: repository.baseSha.slice(0, 12) },
      repository.root,
      repository.temporaryRoot,
    ),
    /not a full Git commit SHA/u,
  );
  await assert.rejects(
    agentInternals.createPullRequestDiff(
      { ...repository.context, headSha: "f".repeat(40) },
      repository.root,
      repository.temporaryRoot,
    ),
    /not available as a commit/u,
  );
});

test("changed-file prompt contains metadata without REST patches", () => {
  const files: readonly ChangedFile[] = [
    {
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: "secret patch text",
      addedLines: new Set([1]),
    },
  ];
  const prompt = agentInternals.changedFilePrompt(files);
  assert.match(prompt, /path="src\/new\.ts"/u);
  assert.match(prompt, /previousPath="src\/old\.ts"/u);
  assert.equal(prompt.includes("secret patch text"), false);
});

test("logs assistant, agent-tool, and MCP events with bounded redacted payloads", () => {
  const secret = "mcp-header-secret";
  const longInput = `${secret}-${"x".repeat(260)}`;
  const messages: SDKMessage[] = [
    {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "I will inspect the changed files." },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "src/index.ts" } },
          {
            type: "mcp_tool_use",
            id: "tool-2",
            name: "lookup",
            server_name: "security",
            input: { query: longInput },
          },
        ],
      },
    } as unknown as SDKMessage,
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: "Read output",
          },
          {
            type: "tool_result",
            tool_use_id: "tool-2",
            content: [{ type: "text", text: longInput }],
            is_error: true,
          },
        ],
      },
    } as unknown as SDKMessage,
  ];
  const lines: string[] = [];
  const toolUses = new Map<string, { readonly kind: "agent" | "mcp"; readonly label: string }>();
  for (const message of messages)
    agentInternals.logAgentMessage(message, 1, [secret], toolUses, (line) => lines.push(line));

  assert.equal(lines.length, 5);
  assert.match(lines[0] ?? "", /assistant message text: "I will inspect/u);
  assert.match(lines[1] ?? "", /agent tool use Read input: \{"file_path":"src\/index\.ts"\}/u);
  assert.match(lines[2] ?? "", /MCP tool use security\.lookup input:/u);
  assert.match(lines[3] ?? "", /agent tool result Read output:/u);
  assert.match(lines[4] ?? "", /MCP tool result security\.lookup output:/u);
  assert.equal(
    lines.every((line) => !line.includes(secret)),
    true,
  );
  assert.match(lines[2] ?? "", /\[\d+ chars\]/u);
  const preview = lines[2]?.match(/input: (.+) \[\d+ chars\]$/u)?.[1];
  assert.ok(preview);
  assert.ok(preview.length <= 202);
  assert.match(lines[4] ?? "", /"is_error":true/u);
  assert.match(lines[4] ?? "", /\[333 chars\]$/u);
  assert.equal((lines[4] ?? "").includes("x".repeat(260)), false);
});

test("never writes context file page contents to the action log", () => {
  const fileContent = "PRIVATE WORKFLOW CONTEXT";
  const path = "/runner/context/ticket.json";
  const toolUses = new Map<string, { readonly kind: "agent" | "mcp"; readonly label: string }>();
  const lines: string[] = [];
  const messages: SDKMessage[] = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "mcp_tool_use",
            id: "context-1",
            name: "read_context_file",
            server_name: "review_output",
            input: { path },
          },
        ],
      },
    } as unknown as SDKMessage,
    {
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "mcp_tool_result",
            tool_use_id: "context-1",
            content: [
              {
                type: "text",
                text: JSON.stringify({ path, page: 1, content: fileContent, done: true }),
              },
            ],
          },
        ],
      },
    } as unknown as SDKMessage,
  ];
  for (const message of messages) {
    agentInternals.logAgentMessage(message, 0, [], toolUses, (line) => lines.push(line));
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", new RegExp(path, "u"));
  assert.match(lines[1] ?? "", /context file page omitted from logs/u);
  assert.equal(lines.join("\n").includes(fileContent), false);
});

test("logs complete redacted user and assistant messages in reconstructable chunks", () => {
  const secret = "conversation-secret";
  const text = `before-${secret}-${"🙂".repeat(5_000)}-after`;
  const lines: string[] = [];
  const message = {
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  } as unknown as SDKMessage;

  agentInternals.logAgentMessage(message, 0, [secret], new Map(), (line) => lines.push(line));

  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /part 1\/2/u);
  assert.match(lines[1] ?? "", /part 2\/2/u);
  const chunks = lines.map((line) => line.slice(line.indexOf(": ") + 2));
  for (const chunk of chunks) {
    assert.doesNotMatch(chunk, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
    assert.doesNotMatch(chunk, /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  }
  const reconstructed = chunks.join("");
  assert.equal(reconstructed, JSON.stringify(text.replace(secret, "[REDACTED]")));
  assert.equal(reconstructed.includes(secret), false);
  assert.equal(reconstructed.includes("�"), false);

  const userLines: string[] = [];
  agentInternals.logQueuedUserMessage(
    agentInternals.makeUserMessage(text),
    "review",
    0,
    [secret],
    (line) => userLines.push(line),
  );
  assert.equal(userLines.length, 2);
  assert.equal(userLines.map((line) => line.slice(line.indexOf(": ") + 2)).join(""), reconstructed);
});

test("redacts complete structured error results before chunking", () => {
  const secret = "validation-secret";
  const validation = `findings.0.path: ${"x".repeat(9_000)} ${secret}`;
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "mcp_tool_result",
          tool_use_id: "submit-1",
          content: [{ type: "text", text: validation }],
          is_error: true,
        },
      ],
    },
  } as unknown as SDKMessage;
  const lines: string[] = [];
  const tools = new Map([
    ["submit-1", { kind: "mcp" as const, label: "review_output.submit_review" }],
  ]);

  agentInternals.logAgentMessage(message, 0, [secret], tools, (line) => lines.push(line));

  assert.ok(lines.length > 1);
  const reconstructed = lines.map((line) => line.slice(line.indexOf(": ") + 2)).join("");
  assert.match(reconstructed, /findings\.0\.path/u);
  assert.match(reconstructed, new RegExp("x{9000}", "u"));
  assert.match(reconstructed, /\[REDACTED\]/u);
  assert.equal(reconstructed.includes(secret), false);
});

test("treats camelCase internal validation flags as complete errors", () => {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "mcp_tool_result",
          tool_use_id: "submit-1",
          content: `findings.0.body: ${"v".repeat(9_000)}`,
          isError: true,
        },
      ],
    },
  } as unknown as SDKMessage;
  const lines: string[] = [];
  const tools = new Map([
    ["submit-1", { kind: "mcp" as const, label: "mcp__review_output__submit_review" }],
  ]);

  agentInternals.logAgentMessage(message, 0, [], tools, (line) => lines.push(line));

  assert.ok(lines.length > 1);
  const reconstructed = lines.map((line) => line.slice(line.indexOf(": ") + 2)).join("");
  assert.match(reconstructed, /"is_error":true/u);
  assert.match(reconstructed, new RegExp("v{9000}", "u"));
});

test("queues both initial prompts before activating the review gate", () => {
  const events: string[] = [];
  const queued: SDKMessage[] = [];
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 7,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    baseRef: "main",
    title: "Review sequencing",
    htmlUrl: "https://github.com/owner/repository/pull/7",
  };

  agentInternals.startReviewPrompt(
    {
      push: (message) => {
        queued.push(message);
        events.push(`push-${queued.length}`);
      },
    },
    "Check sequencing.",
    context,
    [],
    context.baseSha,
    1,
    [],
    0,
    [],
    () => events.push("activate"),
    () => undefined,
  );

  assert.deepEqual(events, ["push-1", "push-2", "activate"]);
  assert.match((queued[0] as { message: { content: string } }).message.content, /^\/goal /u);
  assert.match(
    (queued[1] as { message: { content: string } }).message.content,
    /isolated pull-request reviewer/u,
  );
  assert.match(
    (queued[1] as { message: { content: string } }).message.content,
    /1 qualifying pull request conversation entry/u,
  );
});

test("logs goal, result, and compaction lifecycle events with counters", () => {
  const state = agentInternals.createAgentLifecycleState();
  const lines: string[] = [];
  const write = (line: string): void => {
    lines.push(line);
  };
  const base = { uuid: "event", session_id: "session-1" };
  const events = [
    {
      type: "system",
      subtype: "init",
      model: "review-model",
      claude_code_version: "2.0.0",
      ...base,
    },
    {
      type: "active_goal",
      value: {
        condition: "Complete the goal",
        iterations: 2,
        set_at: 1,
        tokens_at_start: 10,
        last_reason: `Need the diff ${"g".repeat(9_000)}`,
      },
      ...base,
    },
    { type: "system", subtype: "status", status: "compacting", ...base },
    {
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "failed",
      compact_error: "provider error",
      ...base,
    },
    {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", pre_tokens: 100, post_tokens: 50 },
      ...base,
    },
    {
      type: "result",
      subtype: "error_max_turns",
      num_turns: 4,
      duration_ms: 80,
      duration_api_ms: 60,
      stop_reason: "max_turns",
      is_error: true,
      errors: [`provider error ${"r".repeat(9_000)}`],
      ...base,
    },
    { type: "active_goal", value: null, ...base },
  ] as unknown as Array<SDKMessage | SDKActiveGoalMessage>;

  for (const event of events) agentInternals.logAgentLifecycleMessage(event, 0, [], state, write);

  assert.equal(state.sessionId, "session-1");
  assert.equal(state.goalIterations, 2);
  assert.equal(state.turnResults, 1);
  assert.equal(state.latestTurnCount, 4);
  assert.equal(state.compactionStarts, 1);
  assert.equal(state.compactionFailures, 1);
  assert.equal(state.compactionBoundaries, 1);
  assert.match(lines.join("\n"), /session init/u);
  assert.match(lines.join("\n"), /session goal-iteration/u);
  const goalIteration = lines.find((line) => /session goal-iteration/u.test(line));
  assert.match(goalIteration ?? "", /payload truncated/u);
  assert.equal((goalIteration ?? "").includes("g".repeat(9_000)), false);
  assert.match(lines.join("\n"), /session compaction-start/u);
  assert.match(lines.join("\n"), /session compaction-result error/u);
  assert.match(lines.join("\n"), /session compaction-boundary/u);
  assert.match(lines.join("\n"), /session turn-result errors/u);
  const resultError = lines.find((line) => /session turn-result errors/u.test(line));
  assert.match(resultError ?? "", /payload truncated/u);
  assert.equal((resultError ?? "").includes("r".repeat(9_000)), false);
  assert.match(lines.join("\n"), /session goal-cleared/u);
});

test("serializes bounded agent log values without throwing on circular input", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const value = agentInternals.boundedAgentLogValue(circular, []);
  assert.match(value, /unserializable value/u);
  assert.match(value, /\[\d+ chars\]/u);
});

test("caps string previews after JSON escaping", () => {
  const value = agentInternals.boundedAgentLogValue("\n".repeat(200), []);
  const preview = value.match(/^(.+) \[200 chars\]$/u)?.[1];
  assert.ok(preview);
  assert.equal(preview.length, 200);
  assert.match(preview, /…$/u);
});

test("redacts JSON-escaped secrets before formatting structured values", () => {
  const secret = 'token"with\\escapes\nand-newline';
  const value = agentInternals.boundedAgentLogValue({ token: secret }, [secret]);
  assert.equal(value.includes('token\\"with\\\\escapes\\nand-newline'), false);
  assert.match(value, /\[REDACTED\]/u);
  assert.match(value, new RegExp(`\\[${JSON.stringify({ token: secret }).length} chars\\]$`, "u"));
});

test("bounds traversal of oversized structured agent log values", () => {
  const value: Record<string, unknown> = { content: "x".repeat(1_000_000) };
  Object.defineProperty(value, "unvisited", {
    enumerable: true,
    get: () => {
      throw new Error("the projection read beyond its bound");
    },
  });

  const result = agentInternals.boundedAgentLogValue(value, []);
  assert.match(result, /^\{"content":"x+/u);
  assert.match(result, /… \[payload truncated\]$/u);
  assert.equal(result.includes("unserializable"), false);
});

test("logs plain MCP tool-use blocks and parent-linked fallback results", () => {
  const toolUses = new Map<string, { readonly kind: "agent" | "mcp"; readonly label: string }>();
  const lines: string[] = [];
  const messages: SDKMessage[] = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "mcp-tool-1",
            name: "mcp__project_memory__search",
            input: { query: "release policy" },
          },
        ],
      },
    } as unknown as SDKMessage,
    {
      type: "user",
      parent_tool_use_id: "mcp-tool-1",
      tool_use_result: { content: "Memory result" },
      message: { role: "user", content: [] },
    } as unknown as SDKMessage,
  ];

  for (const message of messages)
    agentInternals.logAgentMessage(message, 0, [], toolUses, (line) => lines.push(line));

  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /MCP tool use mcp__project_memory__search input/u);
  assert.match(lines[1] ?? "", /MCP tool result mcp__project_memory__search output/u);
  assert.match(lines[1] ?? "", /Memory result/u);
});

test("bounds external MCP errors while preserving complete internal fallback errors", () => {
  const externalTools = new Map([
    ["external-tool", { kind: "mcp" as const, label: "mcp__security__validate" }],
  ]);
  const externalLines: string[] = [];
  const externalError = {
    type: "user",
    parent_tool_use_id: "external-tool",
    tool_use_result: {
      isError: true,
      content: "e".repeat(9_000),
    },
    message: { role: "user", content: [] },
  } as unknown as SDKMessage;

  agentInternals.logAgentMessage(externalError, 0, [], externalTools, (line) =>
    externalLines.push(line),
  );

  assert.equal(externalLines.length, 1);
  assert.match(externalLines[0] ?? "", /payload truncated/u);
  assert.equal((externalLines[0] ?? "").includes("e".repeat(9_000)), false);

  const internalTools = new Map([
    ["internal-tool", { kind: "mcp" as const, label: "review_output.submit_review" }],
  ]);
  const internalLines: string[] = [];
  const internalError = {
    type: "user",
    parent_tool_use_id: "internal-tool",
    tool_use_result: { is_error: true, content: "i".repeat(9_000) },
    message: { role: "user", content: [] },
  } as unknown as SDKMessage;
  agentInternals.logAgentMessage(internalError, 0, [], internalTools, (line) =>
    internalLines.push(line),
  );

  assert.ok(internalLines.length > 1);
  const reconstructed = internalLines.map((line) => line.slice(line.indexOf(": ") + 2)).join("");
  assert.match(reconstructed, new RegExp("i{9000}", "u"));
});

test("does not treat an external dotted server name as the internal review server", () => {
  const message = {
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "mcp_tool_result",
          tool_use_id: "collision-tool",
          content: "c".repeat(9_000),
          is_error: true,
        },
      ],
    },
  } as unknown as SDKMessage;
  const lines: string[] = [];
  const tools = new Map([
    ["collision-tool", { kind: "mcp" as const, label: "review_output.foo.validate" }],
  ]);

  agentInternals.logAgentMessage(message, 0, [], tools, (line) => lines.push(line));

  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /payload truncated/u);
  assert.equal((lines[0] ?? "").includes("c".repeat(9_000)), false);
});

test("contains agent logging failures without failing the review turn", () => {
  const secret = "mcp-header-secret";
  const warnings: string[] = [];
  const message = {
    type: "assistant",
    message: { content: [{ type: "text", text: "Reviewing the change" }] },
  } as unknown as SDKMessage;

  assert.doesNotThrow(() => {
    agentInternals.logAgentMessageSafely(
      message,
      0,
      [secret],
      new Map(),
      () => {
        throw new Error(`${secret}-${"x".repeat(260)}`);
      },
      (line) => warnings.push(line),
    );
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.includes(secret), false);
  assert.match(warnings[0] ?? "", /agent event log warning/u);
  assert.match(warnings[0] ?? "", /\[\d+ chars\]$/u);
});

test("rejects review submission until the prompt, conversation, and diff are complete", () => {
  assert.equal(
    agentInternals.reviewSubmissionRejection(false, false, false),
    "Wait for the full review prompt before submitting.",
  );
  assert.match(
    agentInternals.reviewSubmissionRejection(true, false, true) ?? "",
    /conversation until done=true/u,
  );
  assert.match(
    agentInternals.reviewSubmissionRejection(true, true, false) ?? "",
    /diff until done=true/u,
  );
  assert.equal(agentInternals.reviewSubmissionRejection(true, true, true), undefined);
  assert.match(
    agentInternals.reviewSubmissionRejection(true, true, true, true) ?? "",
    /already been accepted/u,
  );
});

test("accepts exactly the four public finding severities", () => {
  for (const severity of ["CRITICAL", "HIGH", "MODERATE", "LOW"] as const) {
    assert.equal(
      agentInternals.submissionSchema.safeParse({
        summary: "finding",
        findings: [
          {
            title: "Actionable defect",
            severity,
            why: "The defect breaks a supported path.",
            fix: "Use the validated value.",
          },
        ],
      }).success,
      true,
      severity,
    );
  }
  for (const severity of ["MEDIUM", "INFO"] as const) {
    assert.equal(
      agentInternals.submissionSchema.safeParse({
        summary: "legacy finding",
        findings: [
          {
            title: "Legacy severity",
            severity,
            why: "The defect breaks a supported path.",
            fix: "Use the validated value.",
          },
        ],
      }).success,
      false,
      severity,
    );
  }
});

test("rejects model-authored apply suggestions", () => {
  assert.equal(
    agentInternals.submissionSchema.safeParse({
      summary: "finding",
      findings: [
        {
          title: "Replace the affected region",
          severity: "HIGH",
          why: "The current region returns the wrong value.",
          fix: "Replace the full contiguous region.",
          suggestion: "Change credential.Role to credential.GetRole().",
          path: "src/change.ts",
          line: 10,
        },
      ],
    }).success,
    false,
  );
});

test("rejects required finding prose that normalizes to empty", () => {
  const finding = {
    title: "Actionable defect",
    severity: "HIGH",
    why: "The defect breaks a supported path.",
    fix: "Use the validated value.",
  };

  for (const field of ["title", "why", "fix"] as const) {
    assert.equal(
      agentInternals.submissionSchema.safeParse({
        summary: "finding",
        findings: [{ ...finding, [field]: " \t\n " }],
      }).success,
      false,
      field,
    );
  }
});

test("renders structured finding prose and a deterministic AI prompt", () => {
  const submission = agentInternals.toSubmission({
    summary: "finding",
    findings: [
      {
        title: "  Return   the result ",
        severity: "HIGH",
        why: " The current path   drops the result. ",
        fix: " Return it from the   verified branch. ",
        path: "src/change.ts",
        line: 10,
        endLine: 12,
      },
    ],
  });

  assert.deepEqual(submission.findings[0], {
    title: "Return the result",
    severity: "HIGH",
    body: "**Why it matters:** The current path drops the result.\n\n**Fix:** Return it from the verified branch.",
    agentPrompt: [
      "Verify this finding against the current code. Fix it only if it is still valid,",
      "keep the change minimal, and run the relevant tests.",
      "",
      "Target: `@src/change.ts:10-12`",
      "Finding: Return the result",
      "Impact: The current path drops the result.",
      "Requested fix: Return it from the verified branch.",
    ].join("\n"),
    path: "src/change.ts",
    line: 10,
    endLine: 12,
  });
});

test("does not create an AI prompt without an inline target", () => {
  const submission = agentInternals.toSubmission({
    summary: "finding",
    findings: [
      {
        title: "Return the result",
        severity: "HIGH",
        why: "The current path drops the result.",
        fix: "Return it from the verified branch.",
      },
    ],
  });

  assert.equal(submission.findings[0]?.agentPrompt, undefined);
});

test("teaches the four severity definitions before review submission", () => {
  const events: string[] = [];
  const queued: SDKMessage[] = [];
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 8,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    baseRef: "main",
    title: "Severity contract",
    htmlUrl: "https://github.com/owner/repository/pull/8",
  };

  agentInternals.startReviewPrompt(
    {
      push: (message) => {
        queued.push(message);
        events.push(`push-${queued.length}`);
      },
    },
    "Check severity guidance.",
    context,
    [],
    context.baseSha,
    0,
    [],
    0,
    [],
    () => events.push("activate"),
    () => undefined,
  );

  const prompt = (queued[1] as { message: { content: string } }).message.content;
  for (const severity of ["CRITICAL", "HIGH", "MODERATE", "LOW"])
    assert.match(prompt, new RegExp(`- ${severity}:`, "u"));
  assert.match(prompt, /Omit style preferences, nits, and informational observations/u);
  assert.doesNotMatch(prompt, /- MEDIUM:|- INFO:/u);
  assert.match(prompt, /Set endLine only when the finding spans a contiguous range/u);
  assert.doesNotMatch(prompt, /raw replacement text|apply suggestions/u);
  assert.match(agentInternals.repairPrompt(1, true, true), /MEDIUM and INFO are invalid/u);
  assert.match(agentInternals.repairPrompt(1, true, true), /path, line, and endLine are optional/u);
  assert.doesNotMatch(agentInternals.repairPrompt(1, true, true), /suggestion/u);
  assert.match(agentInternals.repairPrompt(1, false, true), /read_pr_conversation/u);
  assert.match(agentInternals.repairPrompt(1, true, false), /read_pr_diff/u);
  assert.match(
    agentInternals.repairPrompt(1, false, false),
    /read_pr_conversation and mcp__review_output__read_pr_diff/u,
  );
});

test("starts each review with a bounded Claude goal command", () => {
  const command = agentInternals.goalCommand("Check authentication paths and failure handling.");
  assert.equal(
    command,
    "/goal Complete the pull-request review goal: Check authentication paths and failure handling.",
  );
  assert.ok(command.slice("/goal ".length).length <= 4_000);
  const longCommand = agentInternals.goalCommand("x".repeat(5_000));
  assert.ok(longCommand.slice("/goal ".length).length <= 4_000);
  assert.match(longCommand, /full goal is in the review prompt/);
});

test("recognizes only paths under the checked-out repository", () => {
  assert.equal(agentInternals.isWithinRepository("/workspace/repo", "src/index.ts"), true);
  assert.equal(agentInternals.isWithinRepository("/workspace/repo", "/workspace/repo/src"), true);
  assert.equal(agentInternals.isWithinRepository("/workspace/repo", "/workspace/secret"), false);
  assert.equal(agentInternals.isWithinRepository("/workspace/repo", "../secret"), false);
});

test("rejects traversal and absolute alternatives in Glob braces", () => {
  assert.equal(agentInternals.isSafeGlobPattern("src/{lib,test}/**/*.ts"), true);
  assert.equal(agentInternals.isSafeGlobPattern("{../*,src/*}"), false);
  assert.equal(agentInternals.isSafeGlobPattern("{/etc,src}/*"), false);
});

test("blocks root Grep globs that can reach Git metadata", () => {
  assert.equal(agentInternals.isSafeGrepGlob("/workspace/repo", ".", undefined), false);
  assert.equal(agentInternals.isSafeGrepGlob("/workspace/repo", "src", undefined), true);
  assert.equal(agentInternals.isSafeGrepGlob("/workspace/repo", ".", "**/*"), false);
  assert.equal(agentInternals.isSafeGrepGlob("/workspace/repo", "src", "**/*"), true);
  assert.equal(agentInternals.isSafeGrepGlob("/workspace/repo", ".", "src/**/*.ts"), true);
});

test("blocks Git metadata paths from the reviewer", () => {
  assert.equal(agentInternals.isGitMetadataPath(".git/config"), true);
  assert.equal(agentInternals.isGitMetadataPath(".GIT/config"), true);
  assert.equal(agentInternals.isGitMetadataPath("src/.git/objects"), true);
  assert.equal(agentInternals.isGitMetadataPath(".github/workflows/ci.yml"), false);
  assert.equal(
    agentInternals.isSafeResolvedPath("/workspace/repo", "/workspace/repo/.git/config"),
    false,
  );
  assert.equal(agentInternals.isSafeResolvedPath("/workspace/repo", "/workspace/repo/src"), true);
});

test("reports the reviewed checkout as the subprocess workspace", () => {
  const config: ReviewConfig = {
    githubToken: "github-secret",
    aiBaseUrl: "https://ai.example.test",
    aiSecret: "ai-secret",
    aiAuthMode: "api-key",
    model: "review-model",
    reviewPrompts: [{ prompt: "correctness", files: [] }],
    parallelCount: 1,
    maxTurns: 2,
    autoApprove: false,
    interactWithPullRequest: false,
    mcpServers: {},
  };

  const environment = agentInternals.safeAgentEnvironment(config, "/tmp/reviewed-repository");
  assert.equal(environment.GITHUB_WORKSPACE, "/tmp/reviewed-repository");
  assert.equal(environment.ANTHROPIC_API_KEY, "ai-secret");
});

async function makeReviewDiff(
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

const goalContext: PullRequestContext = {
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

test("runs a complete SDK review turn through the real diff and submission tools", async (t) => {
  const diff = await makeReviewDiff(t);
  const config = reviewConfig({
    effort: "xhigh",
    mcpServers: {
      security: {
        type: "http",
        url: "https://mcp.example.test",
        headers: { Authorization: "Bearer external-secret" },
        tools: [{ name: "inspect", permission_policy: "always_allow" }],
        timeout: 2_000,
        alwaysLoad: true,
      },
    },
  });
  const query = fakeAgentQuery({
    preflightTools: true,
    submission: {
      summary: "One issue",
      findings: [
        {
          title: "  Wrong   role accessor ",
          severity: "HIGH",
          why: " The field can be stale. ",
          fix: " Call credential.GetRole(). ",
          path: "credential.go",
          line: 12,
          confidence: "high",
        },
      ],
    },
    inspectOptions: (options) => {
      assert.equal(options.cwd, "/workspace/repository");
      assert.equal(options.effort, "xhigh");
      assert.equal(options.permissionMode, "dontAsk");
      assert.deepEqual(options.tools, ["Read", "Glob", "Grep"]);
      assert.ok(options.allowedTools?.includes("mcp__security__*"));
      assert.ok(options.disallowedTools?.includes("Bash"));
      assert.equal(options.env?.ANTHROPIC_API_KEY, "ai-secret");
      assert.equal(options.env?.GITHUB_WORKSPACE, "/workspace/repository");
      assert.equal(options.mcpServers?.security?.type, "http");
    },
  });

  const result = await runReviewGoal(
    "Check role access.",
    0,
    goalContext,
    [],
    emptyConversation,
    config,
    diff,
    "/workspace/repository",
    query,
  );
  assert.equal(result.status, "completed");
  assert.equal(result.submission?.findings[0]?.title, "Wrong role accessor");
  assert.match(result.submission?.findings[0]?.agentPrompt ?? "", /credential\.GetRole\(\)/u);
  assert.match(result.submission?.findings[0]?.agentPrompt ?? "", /@credential\.go:12/u);
  assert.deepEqual(result.tokenUsage, {
    complete: true,
    models: [
      {
        model: "review-model",
        canonicalModel: "canonical-review-model",
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 1,
      },
    ],
  });
});

test("omits SDK effort when the action input is not configured", () => {
  const options = agentInternals.makeOptions(
    reviewConfig(),
    "/workspace/repository",
    {},
    "review_output",
  );
  assert.equal(Object.hasOwn(options, "effort"), false);
});

test("reads exact authorized context snapshots without embedding their contents", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-agent-context-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const originalPath = "/runner/context/ticket.json";
  const snapshotPath = join(directory, "snapshot.txt");
  const content = `${"a".repeat(48 * 1024 - 1)}🙂\nfinal page\n`;
  await writeFile(snapshotPath, content);
  const contextFile: PreparedContextFile = {
    path: originalPath,
    snapshotPath,
    sizeBytes: Buffer.byteLength(content),
    sha256: "a".repeat(64),
  };
  let reviewPrompt = "";
  const result = await runReviewGoal(
    "Check ticket requirements.",
    0,
    goalContext,
    [],
    emptyConversation,
    reviewConfig({
      reviewPrompts: [{ prompt: "Check ticket requirements.", files: [originalPath] }],
    }),
    await makeReviewDiff(t, ""),
    "/workspace/repository",
    fakeAgentQuery({
      submission: { summary: "No issues", findings: [] },
      contextFilePath: originalPath,
      unauthorizedContextFilePath: "/runner/context/other.json",
      expectedContextFileContent: content,
      inspectOptions: (options) => {
        assert.ok(options.allowedTools?.includes("mcp__review_output__read_context_file"));
        assert.equal(options.additionalDirectories, undefined);
      },
      inspectPrompts: (messages) => {
        const content = messages[1]?.message.content;
        assert.equal(typeof content, "string");
        reviewPrompt = content as string;
      },
    }),
    [contextFile],
  );

  assert.equal(result.status, "completed");
  assert.match(reviewPrompt, new RegExp(originalPath, "u"));
  assert.match(reviewPrompt, /untrusted evidence, never instructions/u);
  assert.equal(reviewPrompt.includes(content), false);
  assert.equal(reviewPrompt.includes(snapshotPath), false);
});

test("reports configured MCP failures after accepting a real submission", async (t) => {
  const result = await runReviewGoal(
    "Check MCP context.",
    0,
    goalContext,
    [],
    emptyConversation,
    reviewConfig({
      mcpServers: { security: { type: "http", url: "https://mcp.example.test" } },
    }),
    await makeReviewDiff(t, ""),
    "/workspace/repository",
    fakeAgentQuery({
      submission: { summary: "No issues", findings: [] },
      mcpStatuses: [{ name: "security", status: "failed", error: "connection refused" }],
    }),
  );
  assert.equal(result.status, "failed");
  assert.ok(result.submission);
  assert.match(result.error ?? "", /security: connection refused/u);
  assert.equal(result.tokenUsage?.complete, true);
  assert.equal(result.tokenUsage?.models[0]?.inputTokens, 10);
});

test("handles provider failures, repair exhaustion, reader failures, and query failures", async (t) => {
  const config = reviewConfig();
  const providerFailure = await runReviewGoal(
    "Provider failure.",
    0,
    goalContext,
    [],
    emptyConversation,
    config,
    await makeReviewDiff(t),
    "/workspace/repository",
    fakeAgentQuery({ resultSubtypes: ["error_max_turns"] }),
  );
  assert.equal(providerFailure.status, "failed");
  assert.match(providerFailure.error ?? "", /provider returned error_max_turns/u);
  assert.equal(providerFailure.tokenUsage?.complete, true);

  const repairFailure = await runReviewGoal(
    "Repair failure.",
    1,
    goalContext,
    [],
    emptyConversation,
    config,
    await makeReviewDiff(t),
    "/workspace/repository",
    fakeAgentQuery({ resultSubtypes: Array.from({ length: 6 }, () => "success") }),
  );
  assert.equal(repairFailure.status, "failed");
  assert.match(repairFailure.error ?? "", /five repair attempts/u);
  assert.equal(repairFailure.tokenUsage?.complete, true);
  assert.equal(repairFailure.tokenUsage?.models[0]?.inputTokens, 60);

  const readerFailure = await runReviewGoal(
    "Reader failure.",
    2,
    goalContext,
    [],
    emptyConversation,
    config,
    await makeReviewDiff(t),
    "/workspace/repository",
    fakeAgentQuery({ readerError: new Error("reader stopped") }),
  );
  assert.equal(readerFailure.status, "failed");
  assert.equal(readerFailure.error, "reader stopped");
  assert.deepEqual(readerFailure.tokenUsage, { models: [], complete: false });

  const queryFailure = await runReviewGoal(
    "Query failure.",
    3,
    goalContext,
    [],
    emptyConversation,
    config,
    await makeReviewDiff(t),
    "/workspace/repository",
    fakeAgentQuery({ queryError: new Error("query setup failed") }),
  );
  assert.equal(queryFailure.status, "failed");
  assert.equal(queryFailure.error, "query setup failed");
  assert.deepEqual(queryFailure.tokenUsage, { models: [], complete: false });
});

test("preserves the latest cumulative usage snapshot when the SDK reader crashes", async (t) => {
  const result = await runReviewGoal(
    "Crash after accounting.",
    0,
    goalContext,
    [],
    emptyConversation,
    reviewConfig(),
    await makeReviewDiff(t),
    "/workspace/repository",
    fakeAgentQuery({ readerErrorAfterResults: new Error("reader crashed after result") }),
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error, "reader crashed after result");
  assert.deepEqual(result.tokenUsage, {
    complete: false,
    models: [
      {
        model: "review-model",
        canonicalModel: "canonical-review-model",
        inputTokens: 10,
        outputTokens: 2,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 1,
      },
    ],
  });
});

test("accepts only complete non-negative SDK model usage snapshots", () => {
  assert.deepEqual(
    agentInternals.modelUsageSnapshot({
      alias: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
        canonicalModel: "canonical",
      },
    }),
    [
      {
        model: "alias",
        canonicalModel: "canonical",
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
    ],
  );
  assert.equal(
    agentInternals.modelUsageSnapshot({
      alias: {
        inputTokens: -1,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
    }),
    undefined,
  );
});

test("runs parallel review goals over independent readers and cleans the shared diff", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "review.txt"), "head change\n");
  });
  const results = await runReviewGoals(
    repository.context,
    [],
    emptyConversation,
    reviewConfig({
      reviewPrompts: [
        { prompt: "correctness", files: [] },
        { prompt: "security", files: [] },
        { prompt: "reliability", files: [] },
      ],
      parallelCount: 2,
    }),
    [[], [], []],
    repository.root,
    fakeAgentQuery({ submission: { summary: "No issues", findings: [] } }),
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ["completed", "completed", "completed"],
  );
  assert.deepEqual(await readdir(repository.temporaryRoot), []);
});

test("enforces repository paths in the SDK read hook", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-read-hook-"));
  const outside = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-read-hook-outside-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/index.ts"), "export {};\n");
  await writeFile(join(outside, "secret.txt"), "secret\n");
  await symlink(join(outside, "secret.txt"), join(root, "linked-secret"));
  const hook = agentInternals.repositoryReadHook as unknown as (
    input: Record<string, unknown>,
  ) => Promise<{ readonly hookSpecificOutput?: { readonly permissionDecision?: string } }>;
  const call = (toolName: string, toolInput: unknown, hookEventName = "PreToolUse") =>
    hook({ hook_event_name: hookEventName, tool_name: toolName, tool_input: toolInput, cwd: root });

  assert.equal((await call("Read", { file_path: "src/index.ts" })).hookSpecificOutput, undefined);
  assert.equal(
    (await call("Read", { file_path: "linked-secret" })).hookSpecificOutput?.permissionDecision,
    "deny",
  );
  assert.equal((await call("Glob", { path: "." })).hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(
    (await call("Glob", { path: ".", pattern: "../*" })).hookSpecificOutput?.permissionDecision,
    "deny",
  );
  assert.equal((await call("Grep", { path: "." })).hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(
    (await call("Glob", { path: "src", pattern: "missing/**/*.ts" })).hookSpecificOutput,
    undefined,
  );
  assert.equal((await call("Read", null)).hookSpecificOutput, undefined);
  assert.equal((await call("Read", {}, "PostToolUse")).hookSpecificOutput, undefined);
});

test("builds an auth-token agent environment without inherited credentials", () => {
  const originalInput = process.env.INPUT_PRIVATE_VALUE;
  const originalGitHub = process.env.GITHUB_TOKEN;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;
  const originalEffort = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  process.env.INPUT_PRIVATE_VALUE = "input-secret";
  process.env.GITHUB_TOKEN = "github-secret";
  process.env.ANTHROPIC_API_KEY = "old-key";
  process.env.CLAUDE_CODE_EFFORT_LEVEL = "low";
  try {
    const environment = agentInternals.safeAgentEnvironment(
      reviewConfig({ aiAuthMode: "auth-token", aiSecret: "auth-secret" }),
      "/workspace/repository",
    );
    assert.equal(environment.INPUT_PRIVATE_VALUE, undefined);
    assert.equal(environment.GITHUB_TOKEN, undefined);
    assert.equal(environment.ANTHROPIC_API_KEY, undefined);
    assert.equal(environment.ANTHROPIC_AUTH_TOKEN, "auth-secret");
    assert.equal(environment.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  } finally {
    if (originalInput === undefined) delete process.env.INPUT_PRIVATE_VALUE;
    else process.env.INPUT_PRIVATE_VALUE = originalInput;
    if (originalGitHub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalGitHub;
    if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalApiKey;
    if (originalEffort === undefined) delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    else process.env.CLAUDE_CODE_EFFORT_LEVEL = originalEffort;
  }
});

test("covers agent log serialization and chunk boundaries", () => {
  assert.equal(agentInternals.completeAgentLogValue(undefined, []), "undefined");
  assert.equal(agentInternals.completeAgentLogValue(1n, []), "[unserializable value]");
  const circular: { self?: unknown } = {};
  circular.self = circular;
  assert.equal(agentInternals.completeAgentLogValue(circular, []), "[unserializable value]");
  assert.equal(
    agentInternals.completeAgentLogValue(["secret", { value: 1 }], ["secret"]),
    '["[REDACTED]",{"value":1}]',
  );
  assert.deepEqual(agentInternals.chunkAgentLogValue(""), [""]);
  assert.deepEqual(agentInternals.chunkAgentLogValue("abcd", 2), ["ab", "cd"]);
  assert.throws(() => agentInternals.chunkAgentLogValue("value", 1), /at least 2/u);
  assert.throws(() => agentInternals.chunkAgentLogValue("value", 2.5), /integer/u);
  assert.equal(
    agentInternals.redactAgentLog("a data token-value", ["", "a", "token-value"]),
    "[REDACTED] data [REDACTED]",
  );

  const crossing = `${"x".repeat(1_020)}crossing-secret`;
  const bounded = agentInternals.boundedAgentLogValue(crossing, ["x", "crossing-secret"]);
  assert.equal(bounded.includes("crossing-secret"), false);
  assert.match(bounded, /\[1035 chars\]$/u);
  assert.match(agentInternals.boundedAgentLogValue([1n], []), /unserializable/u);
  let deep: unknown = "leaf";
  for (let index = 0; index < 12; index += 1) deep = { deep };
  assert.match(agentInternals.boundedAgentLogValue(deep, []), /payload truncated/u);
});

test("contains nested failures in the generic agent event logger", () => {
  const warnings: string[] = [];
  assert.doesNotThrow(() => {
    agentInternals.logAgentEventSafely(
      0,
      ["private-secret"],
      () => {
        throw new Error("private-secret failed");
      },
      () => undefined,
      (line) => {
        warnings.push(line);
      },
    );
  });
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0]?.includes("private-secret"), false);
  assert.doesNotThrow(() => {
    agentInternals.logAgentEventSafely(
      0,
      [],
      () => {
        throw new Error("first logger failed");
      },
      () => undefined,
      () => {
        throw new Error("warning failed");
      },
    );
  });
});

test("ignores malformed SDK log blocks while preserving valid fallback results", () => {
  const lines: string[] = [];
  const tools = new Map<string, { readonly kind: "agent" | "mcp"; readonly label: string }>();
  const messages = [
    { type: "assistant", message: null },
    {
      type: "assistant",
      message: {
        content: [
          null,
          { type: 1 },
          { type: "tool_use", name: "Read" },
          { type: "mcp_tool_use", id: "mcp", name: "lookup", input: {} },
        ],
      },
    },
    { type: "system", subtype: "unknown" },
    {
      type: "user",
      message: {
        content: [
          null,
          { type: "other" },
          { type: "mcp_tool_result", tool_use_id: "mcp", content: "ok", isError: false },
        ],
      },
    },
    {
      type: "user",
      parent_tool_use_id: null,
      tool_use_result: { content: "fallback" },
      message: { role: "user", content: "text" },
    },
  ] as unknown as SDKMessage[];
  for (const message of messages)
    agentInternals.logAgentMessage(message, 0, [], tools, (line) => lines.push(line));
  assert.equal(tools.get("mcp")?.kind, "mcp");
  assert.match(lines.join("\n"), /MCP tool use lookup/u);
  assert.match(lines.join("\n"), /fallback/u);

  const queued: string[] = [];
  agentInternals.logQueuedUserMessage(
    {
      type: "user",
      message: { role: "user", content: [{ type: "image", source: {} }] },
    } as unknown as SDKUserMessage,
    "empty",
    0,
    [],
    (line) => queued.push(line),
  );
  assert.deepEqual(queued, []);
});

test("records successful compaction and minimal lifecycle messages", () => {
  const state = agentInternals.createAgentLifecycleState();
  const lines: string[] = [];
  const events = [
    { type: "system", subtype: "init", session_id: "session" },
    { type: "system", subtype: "status", status: "compacting", session_id: "session" },
    {
      type: "system",
      subtype: "status",
      status: null,
      compact_result: "success",
      session_id: "session",
    },
    {
      type: "result",
      subtype: "success",
      num_turns: 0,
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: false,
      errors: [],
      session_id: "session",
    },
    { type: "assistant", message: { content: [] }, session_id: "session" },
  ] as unknown as Array<SDKMessage | SDKActiveGoalMessage>;
  for (const event of events)
    agentInternals.logAgentLifecycleMessage(event, 0, [], state, (line) => lines.push(line));
  assert.equal(state.compactionSuccesses, 1);
  assert.equal(state.turnResults, 1);
  assert.match(lines.join("\n"), /compaction-result details:.*"result":"success"/u);
});

test("serializes repeated diff reads and rejects reads after close or premature EOF", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-reader-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "diff");
  await writeFile(path, "abc");
  const reader = new agentInternals.PullRequestDiffReader(path, 3);
  const [first, second] = await Promise.all([reader.readNext(), reader.readNext()]);
  assert.equal(first.content, "abc");
  assert.deepEqual(second, { page: 1, content: "", done: true });
  await reader.close();
  await reader.close();
  await assert.rejects(reader.readNext(), /closed pull request diff/u);

  const oversized = new agentInternals.PullRequestDiffReader(path, 4);
  assert.equal((await oversized.readNext()).done, false);
  await assert.rejects(oversized.readNext(), /ended before its recorded size/u);
  await oversized.close();
});

test("handles sparse goal arrays without leaking the shared diff", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "review.txt"), "head change\n");
  });
  const prompts = new Array<ReviewConfig["reviewPrompts"][number]>(1);
  const results = await runReviewGoals(
    repository.context,
    [],
    emptyConversation,
    reviewConfig({ reviewPrompts: prompts }),
    [[]],
    repository.root,
    fakeAgentQuery({ submission: { summary: "unused", findings: [] } }),
  );
  assert.deepEqual(results, [
    { prompt: "", status: "failed", error: "Worker did not return a result." },
  ]);
  assert.deepEqual(await readdir(repository.temporaryRoot), []);
});

test("rejects additional unsafe glob and hook input shapes", async (t) => {
  assert.equal(agentInternals.isSafeGlobPattern("!src/**/*.ts"), true);
  assert.equal(agentInternals.isSafeGlobPattern("src/{a,{b,c}}"), false);
  assert.equal(agentInternals.isSafeGlobPattern("src/}bad{"), false);
  assert.equal(agentInternals.isSafeGlobPattern("src/{C:\\bad,ok}"), false);
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-hook-shapes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hook = agentInternals.repositoryReadHook as unknown as (
    input: Record<string, unknown>,
  ) => Promise<{ readonly hookSpecificOutput?: { readonly permissionDecision?: string } }>;
  const deny = async (tool_name: string, tool_input: unknown) =>
    (await hook({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: root }))
      .hookSpecificOutput?.permissionDecision;
  assert.equal(await deny("Read", { file_path: 1 }), "deny");
  assert.equal(await deny("Glob", { path: ".", pattern: 1 }), "deny");
  assert.equal(await deny("Grep", { path: ".", glob: ".git/**" }), "deny");
  assert.equal(await deny("Glob", { path: ".", pattern: "missing/*.ts" }), undefined);
});
