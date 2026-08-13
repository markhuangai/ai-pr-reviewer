import { strict as assert } from "node:assert";
import test from "node:test";

import { selectReleaseAlias } from "../scripts/select-release-alias.js";

function release(tag: string) {
  return {
    tag_name: tag,
    draft: false,
    prerelease: tag.includes("-rc."),
    published_at: "2026-08-13T00:00:00Z",
  };
}

test("selects the latest stable release without crossing major versions", () => {
  const releases = [
    release("v2.0.0"),
    release("v1.10.0"),
    release("v1.9.9"),
    release("v1.11.0-rc.0"),
  ];
  assert.deepEqual(selectReleaseAlias("v1.9.9", releases), {
    alias_tag: "v1",
    release_tag: "v1.10.0",
  });
});

test("selects the latest release candidate for the requested major", () => {
  const releases = [
    release("v1.6.1-rc.7"),
    release("v1.6.1-rc.6"),
    release("v1.6.0"),
    release("v2.0.0-rc.0"),
  ];
  assert.deepEqual(selectReleaseAlias("v1.6.1-rc.6", [releases]), {
    alias_tag: "v1-prerelease",
    release_tag: "v1.6.1-rc.7",
  });
});

test("requires the requested exact release to be published in the same channel", () => {
  const releases = [release("v1.0.0-rc.0")];
  assert.throws(() => selectReleaseAlias("v1.0.0-rc.1", releases), /not a published release/i);
  assert.throws(() => selectReleaseAlias("v1", releases), /exact vX\.Y\.Z/i);
});

test("ignores drafts and releases with inconsistent channel flags", () => {
  const releases = [
    release("v1.0.0-rc.0"),
    { ...release("v1.0.0-rc.1"), draft: true },
    { ...release("v1.0.0-rc.2"), prerelease: false },
  ];
  assert.deepEqual(selectReleaseAlias("v1.0.0-rc.0", releases), {
    alias_tag: "v1-prerelease",
    release_tag: "v1.0.0-rc.0",
  });
});
