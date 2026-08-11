import { strict as assert } from "node:assert";
import test from "node:test";

import { agentInternals } from "../src/runtime/agent.js";
import type { ChangedFile } from "../src/lib/types.js";

function patchWithContextLines(count: number): string {
  return `@@ -1,${count + 1} +1,${count + 1} @@\n-old\n+new\n${" context\n".repeat(count)}`;
}

test("keeps every changed-file header when patch excerpts exceed the budget", () => {
  const files: readonly ChangedFile[] = [
    {
      path: "src/large.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: patchWithContextLines(4_000),
      addedLines: new Set([1]),
    },
    {
      path: "src/later.ts",
      status: "added",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: "+later",
      addedLines: new Set([1]),
    },
  ];
  const prompt = agentInternals.changedFilePrompt(files);
  assert.match(prompt, /### src\/large\.ts \[modified\]/);
  assert.match(prompt, /### src\/later\.ts \[added\]/);
  assert.match(prompt, /patch excerpt truncated/);
});

test("preserves deleted-file patches ahead of the ordinary patch budget", () => {
  const prompt = agentInternals.changedFilePrompt([
    {
      path: "src/large.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: patchWithContextLines(4_000),
      addedLines: new Set([1]),
    },
    {
      path: "src/removed.ts",
      status: "removed",
      additions: 0,
      deletions: 1,
      changes: 1,
      patch: "@@ -1 +0,0 @@\n-removed",
      addedLines: new Set(),
    },
  ]);
  assert.match(prompt, /### src\/removed\.ts \[removed\][\s\S]*-removed/);
  assert.match(prompt, /### src\/large\.ts \[modified\][\s\S]*patch excerpt truncated/);
});

test("preserves the source path for renamed files", () => {
  const prompt = agentInternals.changedFilePrompt([
    {
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
      additions: 0,
      deletions: 0,
      changes: 0,
      addedLines: new Set(),
    },
  ]);
  assert.match(prompt, /src\/new\.ts \(renamed from src\/old\.ts\) \[renamed\]/);
});

test("reports deleted diffs that cannot be supplied to a read-only reviewer", () => {
  assert.deepEqual(
    agentInternals.unavailableDiffs([
      {
        path: "src/binary.bin",
        status: "removed",
        additions: 0,
        deletions: 1,
        changes: 1,
        addedLines: new Set(),
      },
      {
        path: "src/large.bin",
        status: "deleted",
        additions: 0,
        deletions: 1,
        changes: 1,
        patch: "x".repeat(30_001),
        addedLines: new Set(),
      },
    ]),
    ["src/binary.bin", "src/large.bin"],
  );
});

test("fails closed when an ordinary changed-file patch is omitted", () => {
  assert.deepEqual(
    agentInternals.unavailableDiffs([
      {
        path: "src/changed.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: patchWithContextLines(3_000),
        addedLines: new Set([1]),
      },
      {
        path: "src/later.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "+later",
        addedLines: new Set([1]),
      },
    ]),
    ["src/later.ts"],
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
