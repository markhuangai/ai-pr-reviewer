import { strict as assert } from "node:assert";
import test from "node:test";

import { isSafeArchiveEntryPath, isSafeArchiveSymlink } from "../src/lib/bootstrap/archive.js";

test("allows npm bin symlinks that resolve inside the archive", () => {
  assert.equal(isSafeArchiveEntryPath("runtime/node_modules/.bin/claude"), true);
  assert.equal(
    isSafeArchiveSymlink("runtime/node_modules/.bin/claude", "../@anthropic-ai/cli/bin/run"),
    true,
  );
});

test("rejects archive paths and symlinks that escape the bundle", () => {
  assert.equal(isSafeArchiveEntryPath("../../etc/passwd"), false);
  assert.equal(isSafeArchiveEntryPath("C:payload"), false);
  assert.equal(isSafeArchiveEntryPath("C:..\\outside"), false);
  assert.equal(isSafeArchiveSymlink("runtime/link", "../../../../etc/passwd"), false);
  assert.equal(isSafeArchiveSymlink("runtime/link", "/etc/passwd"), false);
  assert.equal(isSafeArchiveSymlink("runtime/link", "C:payload"), false);
  assert.equal(isSafeArchiveSymlink("runtime/link", "C:..\\outside"), false);
});
