import { strict as assert } from "node:assert";
import test from "node:test";

import {
  validateReleaseRequest,
  type ReleaseRecord,
  type TagRecord,
} from "../scripts/validate-release.js";

function release(tag: string, order: number): ReleaseRecord {
  return {
    id: order,
    tag_name: tag,
    draft: false,
    prerelease: tag.includes("-rc."),
    published_at: new Date(order * 1_000).toISOString(),
  };
}

function history(...tags: string[]): ReleaseRecord[] {
  return tags.map((tag, index) => release(tag, index + 1));
}

function tagRecords(...tags: string[]): TagRecord[] {
  return tags.map((tag) => ({ ref: `refs/tags/${tag}` }));
}

test("starts the release stream at 1.0.0-rc.0", () => {
  assert.deepEqual(validateReleaseRequest("1.0.0-rc.0", "dev", [[]], [[]]), {
    release_tag: "v1.0.0-rc.0",
    stable_tag: "v1.0.0",
    prerelease: true,
    source_rc_tag: "",
  });
  assert.throws(
    () => validateReleaseRequest("1.0.1-rc.0", "dev", [], []),
    /first release must be v1\.0\.0-rc\.0/i,
  );
});

test("requires exact channels and strict versions", () => {
  for (const invalid of ["v1.0.0", "01.0.0", "1.0.0-rc", "1.0.0-rc.01", "1.0"])
    assert.throws(() => validateReleaseRequest(invalid, "dev", [], []), /strict SemVer/);
  assert.throws(() => validateReleaseRequest("1.0.0", "dev", [], []), /dev branch only publishes/i);
  assert.throws(
    () => validateReleaseRequest("1.0.0-rc.0", "main", [], []),
    /main branch only publishes/i,
  );
  assert.throws(
    () => validateReleaseRequest("1.0.0-rc.0", "feature", [], []),
    /dev or main branch/i,
  );
});

test("increments one active RC sequence without gaps", () => {
  const releases = history("v1.0.0-rc.0", "v1.0.0-rc.1");
  assert.equal(
    validateReleaseRequest("1.0.0-rc.2", "dev", releases, []).release_tag,
    "v1.0.0-rc.2",
  );
  assert.throws(() => validateReleaseRequest("1.0.0-rc.3", "dev", releases, []), /at rc\.2/);
  assert.throws(
    () => validateReleaseRequest("1.0.1-rc.0", "dev", releases, []),
    /active v1\.0\.0 sequence/,
  );
});

test("promotes only the latest matching RC", () => {
  const releases = history("v1.0.0-rc.0", "v1.0.0-rc.1").reverse();
  assert.deepEqual(validateReleaseRequest("1.0.0", "main", releases, []), {
    release_tag: "v1.0.0",
    stable_tag: "v1.0.0",
    prerelease: false,
    source_rc_tag: "v1.0.0-rc.1",
  });
  assert.throws(
    () => validateReleaseRequest("1.0.1", "main", releases, []),
    /active matching release-candidate/i,
  );
});

test("allows only exact patch, minor, or major base increments", () => {
  const releases = history("v1.0.0-rc.0", "v1.0.0");
  for (const version of ["1.0.1-rc.0", "1.1.0-rc.0", "2.0.0-rc.0"])
    assert.equal(validateReleaseRequest(version, "dev", releases, []).release_tag, `v${version}`);
  for (const version of ["1.0.2-rc.0", "1.1.1-rc.0", "2.0.1-rc.0", "3.0.0-rc.0"])
    assert.throws(
      () => validateReleaseRequest(version, "dev", releases, []),
      /not an allowed next release/i,
    );
});

test("rejects rollback, duplicate releases, and existing tags", () => {
  const releases = history("v1.0.0-rc.0", "v1.0.0", "v1.0.1-rc.0", "v1.0.1");
  assert.throws(
    () => validateReleaseRequest("1.0.0-rc.0", "dev", releases, []),
    /already has a GitHub release/i,
  );
  assert.throws(
    () => validateReleaseRequest("1.0.2-rc.0", "dev", releases, tagRecords("v1.0.2-rc.0")),
    /already exists as a Git tag/i,
  );
  assert.throws(
    () => validateReleaseRequest("1.0.0-rc.1", "dev", releases, []),
    /not an allowed next release/i,
  );
});

test("rejects a release-candidate base below the latest stable version", () => {
  const releases = history(
    "v1.0.0-rc.0",
    "v1.0.0",
    "v1.0.1-rc.0",
    "v1.0.1",
    "v1.0.2-rc.0",
    "v1.0.2",
    "v1.0.3-rc.0",
    "v1.0.3",
    "v1.0.4-rc.0",
    "v1.0.4",
    "v1.0.5-rc.0",
    "v1.0.5",
    "v1.0.6-rc.0",
    "v1.0.6",
  );
  assert.throws(
    () => validateReleaseRequest("1.0.5-rc.1", "dev", releases, []),
    /not an allowed next release/i,
  );
});

test("blocks exact draft releases and orphan tags", () => {
  const draft = { ...release("v1.0.0-rc.0", 1), draft: true, published_at: null };
  assert.throws(
    () => validateReleaseRequest("1.0.0-rc.0", "dev", [draft], []),
    /including a possible draft/i,
  );
  assert.throws(
    () => validateReleaseRequest("1.0.0-rc.0", "dev", [], tagRecords("v1.0.0-rc.0")),
    /already exists as a Git tag/i,
  );
});

test("blocks release progress while any exact-version tag is orphaned", () => {
  const releases = history("v1.0.0-rc.0", "v1.0.0");
  const tags = tagRecords("v1.0.0-rc.0", "v1.0.0", "v1.0.1-rc.0", "runtime-v1");
  assert.throws(
    () => validateReleaseRequest("1.1.0-rc.0", "dev", releases, tags),
    /v1\.0\.1-rc\.0 exists as a Git tag without a published release/i,
  );
  assert.equal(
    validateReleaseRequest(
      "1.0.1-rc.0",
      "dev",
      releases,
      tagRecords("v1.0.0-rc.0", "v1.0.0", "runtime-v1"),
    ).release_tag,
    "v1.0.1-rc.0",
  );
});

test("fails closed on a corrupted exact-version release history", () => {
  assert.throws(
    () =>
      validateReleaseRequest(
        "1.1.0-rc.0",
        "dev",
        history("v1.0.0-rc.0", "v1.0.0", "v1.0.2-rc.0", "v1.0.2"),
        [],
      ),
    /not a valid next release/i,
  );
  const wrongFlag = { ...release("v1.0.0-rc.0", 1), prerelease: false };
  assert.throws(
    () => validateReleaseRequest("1.0.0-rc.1", "dev", [wrongFlag], []),
    /prerelease flag/i,
  );

  const missingDraft = history("v1.0.0-rc.0", "v1.0.0", "v1.1.0-rc.0", "v1.1.0").map(
    (item, index) => (index < 2 ? item : { ...item, draft: undefined }),
  );
  assert.throws(
    () => validateReleaseRequest("1.0.1-rc.0", "dev", missingDraft, []),
    /boolean draft flag/i,
  );
});
