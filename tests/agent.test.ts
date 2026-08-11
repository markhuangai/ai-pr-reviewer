import { strict as assert } from "node:assert";
import test from "node:test";

import { agentInternals } from "../src/runtime/agent.js";
import type { ChangedFile } from "../src/lib/types.js";

test("keeps every changed-file header when patch excerpts exceed the budget", () => {
  const files: readonly ChangedFile[] = [
    {
      path: "src/large.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: "x".repeat(30_001),
      addedLines: new Set([1]),
    },
    {
      path: "src/later.ts",
      status: "added",
      additions: 1,
      deletions: 0,
      changes: 1,
      patch: "+later",
      addedLines: new Set([1]),
    },
  ];
  const prompt = agentInternals.changedFilePrompt(files);
  assert.match(prompt, /### src\/large\.ts \[modified\]/);
  assert.match(prompt, /### src\/later\.ts \[added\]/);
  assert.match(prompt, /patch excerpt truncated/);
});

test("recognizes only paths under the checked-out repository", () => {
  assert.equal(agentInternals.isWithinRepository("/workspace/repo", "src/index.ts"), true);
  assert.equal(agentInternals.isWithinRepository("/workspace/repo", "/workspace/repo/src"), true);
  assert.equal(agentInternals.isWithinRepository("/workspace/repo", "/workspace/secret"), false);
  assert.equal(agentInternals.isWithinRepository("/workspace/repo", "../secret"), false);
});
