import { strict as assert } from "node:assert";
import test from "node:test";

import { isSafeArchiveEntryPath, isSafeArchiveSymlink } from "../src/lib/bootstrap/archive.js";
import {
  isCompatibleRuntimeManifest,
  parseActionReleaseTag,
} from "../src/lib/bootstrap/version.js";

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

test("parses only exact stable and release-candidate action tags", () => {
  assert.deepEqual(parseActionReleaseTag("v1.2.3"), {
    tag: "v1.2.3",
    stableTag: "v1.2.3",
    prerelease: false,
  });
  assert.deepEqual(parseActionReleaseTag("v1.2.3-rc.4"), {
    tag: "v1.2.3-rc.4",
    stableTag: "v1.2.3",
    prerelease: true,
  });
  for (const value of ["1.2.3", "v1", "v1.2.3-rc", "v01.2.3", "dev", undefined]) {
    assert.equal(parseActionReleaseTag(value), undefined);
  }
});

test("matches runtime manifests to exact action releases", () => {
  const candidate = parseActionReleaseTag("v1.2.3-rc.2");
  const stable = parseActionReleaseTag("v1.2.3");
  assert.ok(candidate);
  assert.ok(stable);
  assert.equal(isCompatibleRuntimeManifest(candidate, "v1.2.3-rc.2", "v1.2.3"), true);
  assert.equal(isCompatibleRuntimeManifest(stable, "v1.2.3-rc.2", "v1.2.3"), true);
  assert.equal(isCompatibleRuntimeManifest(candidate, "v1.2.3-rc.1", "v1.2.3"), false);
  assert.equal(isCompatibleRuntimeManifest(stable, "v1.2.4-rc.0", "v1.2.4"), false);
});
