import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

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

function validatePrerelease(
  version: string,
  releases: unknown,
  tags: unknown,
): ReturnType<typeof validateReleaseRequest> {
  return validateReleaseRequest(version, "main", "prerelease", releases, tags);
}

function validateStable(
  version: string,
  releases: unknown,
  tags: unknown,
): ReturnType<typeof validateReleaseRequest> {
  return validateReleaseRequest(version, "main", "stable", releases, tags);
}

test("keeps every release workflow upload artifact for one day", async () => {
  const workflow = parse(await readFile(".github/workflows/release.yml", "utf8")) as {
    jobs?: Record<string, { steps?: Array<{ uses?: string; with?: Record<string, unknown> }> }>;
  };
  const uploadSteps = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => step.uses?.startsWith("actions/upload-artifact@"));

  assert.ok(uploadSteps.length > 0);
  for (const step of uploadSteps) assert.equal(step.with?.["retention-days"], 1);
});

test("exposes explicit release channels and forwards them to every validation", async () => {
  const workflowText = await readFile(".github/workflows/release.yml", "utf8");
  const workflow = parse(workflowText) as {
    on?: {
      workflow_dispatch?: {
        inputs?: Record<string, Record<string, unknown>>;
      };
    };
  };
  const channel = workflow.on?.workflow_dispatch?.inputs?.channel;

  assert.equal(channel?.required, true);
  assert.equal(channel?.default, "prerelease");
  assert.equal(channel?.type, "choice");
  assert.deepEqual(channel?.options, ["prerelease", "stable"]);
  assert.equal(workflowText.match(/node scripts\/validate-release\.ts/g)?.length, 3);
  assert.equal(workflowText.match(/REQUESTED_CHANNEL: \$\{\{ inputs\.channel \}\}/g)?.length, 3);
  assert.equal(workflowText.match(/--channel "\$\{REQUESTED_CHANNEL\}"/g)?.length, 3);
});

test("targets pull request automation only at main with one grouped update pull request", async () => {
  const [ciText, dependabotText, codeRabbitText] = await Promise.all([
    readFile(".github/workflows/ci.yml", "utf8"),
    readFile(".github/dependabot.yml", "utf8"),
    readFile(".coderabbit.yaml", "utf8"),
  ]);
  const ci = parse(ciText) as {
    on?: { pull_request?: { branches?: string[] } };
  };
  const dependabot = parse(dependabotText) as {
    "multi-ecosystem-groups"?: Record<
      string,
      {
        "target-branch"?: string;
        "open-pull-requests-limit"?: number;
      }
    >;
    updates?: Array<{
      "target-branch"?: string;
      "open-pull-requests-limit"?: number;
      cooldown?: { "default-days"?: number };
      patterns?: string[];
      "multi-ecosystem-group"?: string;
    }>;
  };
  const codeRabbit = parse(codeRabbitText) as {
    reviews?: { auto_review?: { base_branches?: string[] } };
  };

  assert.deepEqual(ci.on?.pull_request?.branches, ["main"]);
  assert.deepEqual(dependabot["multi-ecosystem-groups"]?.dependencies?.["target-branch"], "main");
  assert.deepEqual(
    dependabot["multi-ecosystem-groups"]?.dependencies?.["open-pull-requests-limit"],
    1,
  );
  assert.deepEqual(
    dependabot.updates?.map((update) => update["target-branch"]),
    [undefined, undefined],
  );
  assert.deepEqual(
    dependabot.updates?.map((update) => update["open-pull-requests-limit"]),
    [undefined, undefined],
  );
  assert.equal(dependabot.updates?.[0]?.cooldown?.["default-days"], 7);
  assert.deepEqual(
    dependabot.updates?.map((update) => update.patterns),
    [["*"], ["*"]],
  );
  assert.deepEqual(
    dependabot.updates?.map((update) => update["multi-ecosystem-group"]),
    ["dependencies", "dependencies"],
  );
  assert.deepEqual(codeRabbit.reviews?.auto_review?.base_branches, ["^main$"]);
});

test("starts the release stream at 1.0.0-rc.0", () => {
  assert.deepEqual(validatePrerelease("1.0.0-rc.0", [[]], [[]]), {
    release_tag: "v1.0.0-rc.0",
    stable_tag: "v1.0.0",
    prerelease: true,
    source_rc_tag: "",
  });
  assert.throws(
    () => validatePrerelease("1.0.1-rc.0", [], []),
    /first release must be v1\.0\.0-rc\.0/i,
  );
});

test("requires exact channels and strict versions", () => {
  for (const invalid of ["v1.0.0", "01.0.0", "1.0.0-rc", "1.0.0-rc.01", "1.0"])
    assert.throws(() => validatePrerelease(invalid, [], []), /strict SemVer/);
  assert.throws(() => validatePrerelease("1.0.0", [], []), /prerelease channel only publishes/i);
  assert.throws(() => validateStable("1.0.0-rc.0", [], []), /stable channel only publishes/i);
  assert.throws(
    () => validateReleaseRequest("1.0.0-rc.0", "main", "preview", [], []),
    /channel must be prerelease or stable/i,
  );
  assert.throws(
    () => validateReleaseRequest("1.0.0-rc.0", "dev", "prerelease", [], []),
    /only be dispatched from the main branch/i,
  );
});

test("increments one active RC sequence without gaps", () => {
  const releases = history("v1.0.0-rc.0", "v1.0.0-rc.1");
  assert.equal(validatePrerelease("1.0.0-rc.2", releases, []).release_tag, "v1.0.0-rc.2");
  assert.throws(() => validatePrerelease("1.0.0-rc.3", releases, []), /at rc\.2/);
  assert.throws(() => validatePrerelease("1.0.1-rc.0", releases, []), /active v1\.0\.0 sequence/);
});

test("promotes only the latest matching RC", () => {
  const releases = history("v1.0.0-rc.0", "v1.0.0-rc.1").reverse();
  assert.deepEqual(validateStable("1.0.0", releases, []), {
    release_tag: "v1.0.0",
    stable_tag: "v1.0.0",
    prerelease: false,
    source_rc_tag: "v1.0.0-rc.1",
  });
  assert.throws(() => validateStable("1.0.1", releases, []), /active matching release-candidate/i);
});

test("allows only exact patch, minor, or major base increments", () => {
  const releases = history("v1.0.0-rc.0", "v1.0.0");
  for (const version of ["1.0.1-rc.0", "1.1.0-rc.0", "2.0.0-rc.0"])
    assert.equal(validatePrerelease(version, releases, []).release_tag, `v${version}`);
  for (const version of ["1.0.2-rc.0", "1.1.1-rc.0", "2.0.1-rc.0", "3.0.0-rc.0"])
    assert.throws(() => validatePrerelease(version, releases, []), /not an allowed next release/i);
});

test("rejects rollback, duplicate releases, and existing tags", () => {
  const releases = history("v1.0.0-rc.0", "v1.0.0", "v1.0.1-rc.0", "v1.0.1");
  assert.throws(
    () => validatePrerelease("1.0.0-rc.0", releases, []),
    /already has a GitHub release/i,
  );
  assert.throws(
    () => validatePrerelease("1.0.2-rc.0", releases, tagRecords("v1.0.2-rc.0")),
    /already exists as a Git tag/i,
  );
  assert.throws(
    () => validatePrerelease("1.0.0-rc.1", releases, []),
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
    () => validatePrerelease("1.0.5-rc.1", releases, []),
    /not an allowed next release/i,
  );
});

test("blocks exact draft releases and orphan tags", () => {
  const draft = { ...release("v1.0.0-rc.0", 1), draft: true, published_at: null };
  assert.throws(() => validatePrerelease("1.0.0-rc.0", [draft], []), /including a possible draft/i);
  assert.throws(
    () => validatePrerelease("1.0.0-rc.0", [], tagRecords("v1.0.0-rc.0")),
    /already exists as a Git tag/i,
  );
});

test("blocks release progress while any exact-version tag is orphaned", () => {
  const releases = history("v1.0.0-rc.0", "v1.0.0");
  const tags = tagRecords("v1.0.0-rc.0", "v1.0.0", "v1.0.1-rc.0", "runtime-v1");
  assert.throws(
    () => validatePrerelease("1.1.0-rc.0", releases, tags),
    /v1\.0\.1-rc\.0 exists as a Git tag without a published release/i,
  );
  assert.equal(
    validatePrerelease("1.0.1-rc.0", releases, tagRecords("v1.0.0-rc.0", "v1.0.0", "runtime-v1"))
      .release_tag,
    "v1.0.1-rc.0",
  );
});

test("fails closed on a corrupted exact-version release history", () => {
  assert.throws(
    () =>
      validatePrerelease(
        "1.1.0-rc.0",
        history("v1.0.0-rc.0", "v1.0.0", "v1.0.2-rc.0", "v1.0.2"),
        [],
      ),
    /not a valid next release/i,
  );
  const wrongFlag = { ...release("v1.0.0-rc.0", 1), prerelease: false };
  assert.throws(() => validatePrerelease("1.0.0-rc.1", [wrongFlag], []), /prerelease flag/i);

  const missingDraft = history("v1.0.0-rc.0", "v1.0.0", "v1.1.0-rc.0", "v1.1.0").map(
    (item, index) => (index < 2 ? item : { ...item, draft: undefined }),
  );
  assert.throws(() => validatePrerelease("1.0.1-rc.0", missingDraft, []), /boolean draft flag/i);
});
