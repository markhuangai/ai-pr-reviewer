import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { agentInternals } from "../src/runtime/agent.js";
import type { ChangedFile, PullRequestContext } from "../src/lib/types.js";

const execFileAsync = promisify(execFile);

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
  assert.match(lines[4] ?? "", /is_error/u);
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

test("rejects review submission until the prompt is active and the diff reaches EOF", () => {
  assert.equal(
    agentInternals.reviewSubmissionRejection(false, false),
    "Wait for the full review prompt before submitting.",
  );
  assert.match(agentInternals.reviewSubmissionRejection(true, false) ?? "", /done=true/u);
  assert.equal(agentInternals.reviewSubmissionRejection(true, true), undefined);
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
