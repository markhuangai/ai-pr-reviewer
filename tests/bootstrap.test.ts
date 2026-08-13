import { strict as assert } from "node:assert";
import test from "node:test";

import { isSafeArchiveEntryPath, isSafeArchiveSymlink } from "../src/lib/bootstrap/archive.js";
import {
  aliasAcceptsRelease,
  isCompatibleRuntimeManifest,
  parseActionReleaseReference,
  parseActionReleaseTag,
} from "../src/lib/bootstrap/version.js";
import { resolveActionRelease } from "../src/bootstrap.js";

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

test("parses stable and prerelease major aliases", () => {
  assert.deepEqual(parseActionReleaseReference("v1"), {
    tag: "v1",
    major: 1,
    prerelease: false,
  });
  assert.deepEqual(parseActionReleaseReference("v2-prerelease"), {
    tag: "v2-prerelease",
    major: 2,
    prerelease: true,
  });
  for (const value of ["v01", "v1-rc", "v1-beta", "main", undefined]) {
    assert.equal(parseActionReleaseReference(value), undefined);
  }
});

test("keeps aliases inside their major version and channel", () => {
  const stableAlias = parseActionReleaseReference("v1");
  const prereleaseAlias = parseActionReleaseReference("v1-prerelease");
  const stable = parseActionReleaseTag("v1.6.1");
  const prerelease = parseActionReleaseTag("v1.6.1-rc.7");
  const nextMajor = parseActionReleaseTag("v2.0.0");
  assert.ok(stableAlias && !("stableTag" in stableAlias));
  assert.ok(prereleaseAlias && !("stableTag" in prereleaseAlias));
  assert.ok(stable);
  assert.ok(prerelease);
  assert.ok(nextMajor);
  assert.equal(aliasAcceptsRelease(stableAlias, stable), true);
  assert.equal(aliasAcceptsRelease(stableAlias, prerelease), false);
  assert.equal(aliasAcceptsRelease(stableAlias, nextMajor), false);
  assert.equal(aliasAcceptsRelease(prereleaseAlias, prerelease), true);
});

test("resolves annotated aliases to matching exact release tags", async () => {
  const aliasTagObject = "a".repeat(40);
  const releaseCommit = "b".repeat(40);
  const responses = new Map<string, unknown>([
    [
      "https://api.github.com/repos/markhuangai/ai-pr-reviewer/git/ref/tags/v1-prerelease",
      { object: { type: "tag", sha: aliasTagObject } },
    ],
    [
      `https://api.github.com/repos/markhuangai/ai-pr-reviewer/git/tags/${aliasTagObject}`,
      {
        tag: "v1-prerelease",
        message: "v1.6.1-rc.7",
        object: { type: "commit", sha: releaseCommit },
      },
    ],
    [
      "https://api.github.com/repos/markhuangai/ai-pr-reviewer/git/ref/tags/v1.6.1-rc.7",
      { object: { type: "commit", sha: releaseCommit } },
    ],
  ]);
  const getJson = <T>(url: string): Promise<T> => {
    if (!responses.has(url)) throw new Error(`Unexpected URL: ${url}`);
    return Promise.resolve(responses.get(url) as T);
  };

  assert.deepEqual(await resolveActionRelease("v1-prerelease", getJson), {
    tag: "v1.6.1-rc.7",
    stableTag: "v1.6.1",
    prerelease: true,
  });
});

test("rejects lightweight, wrong-channel, and mismatched alias targets", async () => {
  const aliasObject = "a".repeat(40);
  const releaseCommit = "b".repeat(40);
  const otherCommit = "c".repeat(40);
  const fetcher = (ref: unknown, tag: unknown, exact: unknown) => {
    const responses = [ref, tag, exact];
    let index = 0;
    return <T>(): Promise<T> => Promise.resolve(responses[index++] as T);
  };

  await assert.rejects(
    resolveActionRelease("v1", fetcher({ object: { type: "commit", sha: releaseCommit } }, {}, {})),
    /not an annotated Git tag/i,
  );
  await assert.rejects(
    resolveActionRelease(
      "v1",
      fetcher(
        { object: { type: "tag", sha: aliasObject } },
        {
          tag: "v1",
          message: "v1.6.1-rc.7",
          object: { type: "commit", sha: releaseCommit },
        },
        {},
      ),
    ),
    /incompatible exact version/i,
  );
  await assert.rejects(
    resolveActionRelease(
      "v1",
      fetcher(
        { object: { type: "tag", sha: aliasObject } },
        {
          tag: "v1",
          message: "v1.6.1",
          object: { type: "commit", sha: releaseCommit },
        },
        { object: { type: "commit", sha: otherCommit } },
      ),
    ),
    /different commits/i,
  );
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
