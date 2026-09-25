import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { checkPackageAge, checkPackageAgeFile } from "../scripts/check-package-age.js";
import {
  reproducibleBuildInternals,
  verifyReproducibleBuild,
} from "../scripts/check-reproducible-build.js";
import { copyBootstrap } from "../scripts/copy-bootstrap.js";
import { archiveFileListOutput, listArchiveFiles } from "../scripts/list-archive-files.js";
import { normalizeArchive } from "../scripts/normalize-archive.js";
import { prepareRuntime } from "../scripts/prepare-runtime.js";
import { selectReleaseAliasCli } from "../scripts/select-release-alias.js";
import { validateReleaseCli } from "../scripts/validate-release.js";
import { writeChecksum } from "../scripts/write-checksum.js";
import { prepareReplayRuntime, runReplay } from "../scripts/run-replay.js";
import {
  parseReplayCase,
  replayCase,
  serializeReplayOutput,
  validateReplayOutputPath,
  writeReplayOutput,
  type ReplayCase,
  type ReplayRunner,
} from "../scripts/replay-review.js";
import { runRuntimeEntry } from "../src/runtime/index.js";
import type { GoalResult } from "../src/lib/types.js";
import { commitFixtureSnapshot, makeReplayRepository } from "./git-test-helpers.js";

const execFileAsync = promisify(execFile);

async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

test("copies bootstrap files, lists archive entries, normalizes modes, and writes checksums", async (t) => {
  const root = await temporaryDirectory("ai-pr-reviewer-scripts-");
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = join(root, "build");
  const destination = join(root, "dist");
  await mkdir(join(source, "lib/bootstrap"), { recursive: true });
  await writeFile(join(source, "bootstrap.js"), "bootstrap\n");
  await writeFile(join(source, "lib/bootstrap/archive.js"), "archive\n");
  await writeFile(join(source, "lib/bootstrap/cancellation.js"), "cancellation\n");
  await writeFile(join(source, "lib/diagnostics.js"), "diagnostics\n");
  await writeFile(join(source, "lib/bootstrap/version.js"), "version\n");
  await copyBootstrap(source, destination);
  assert.equal(await readFile(join(destination, "bootstrap.js"), "utf8"), "bootstrap\n");
  assert.equal(await readFile(join(destination, "lib/bootstrap/archive.js"), "utf8"), "archive\n");
  assert.equal(
    await readFile(join(destination, "lib/bootstrap/cancellation.js"), "utf8"),
    "cancellation\n",
  );
  assert.equal(await readFile(join(destination, "lib/diagnostics.js"), "utf8"), "diagnostics\n");

  const archiveRoot = join(root, "archive");
  await mkdir(join(archiveRoot, "nested"), { recursive: true });
  const executable = join(archiveRoot, "nested/run.sh");
  const plain = join(archiveRoot, "plain.txt");
  await writeFile(executable, "#!/bin/sh\nexit 0\n");
  await writeFile(plain, "payload");
  await chmod(executable, 0o700);
  await chmod(plain, 0o666);
  await symlink("nested", join(archiveRoot, "nested-link"));

  assert.deepEqual(await listArchiveFiles(archiveRoot), [
    ".",
    "./nested",
    "./nested-link",
    "./nested/run.sh",
    "./plain.txt",
  ]);
  assert.equal(
    await archiveFileListOutput(archiveRoot),
    ".\0./nested\0./nested-link\0./nested/run.sh\0./plain.txt\0",
  );

  await normalizeArchive(archiveRoot);
  assert.equal((await stat(archiveRoot)).mode & 0o777, 0o755);
  assert.equal((await stat(executable)).mode & 0o777, 0o755);
  assert.equal((await stat(plain)).mode & 0o777, 0o644);
  assert.equal((await lstat(join(archiveRoot, "nested-link"))).isSymbolicLink(), true);

  const digest = await writeChecksum(plain);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(await readFile(`${plain}.sha256`, "utf8"), `${digest}  plain.txt\n`);
});

test("checks package ages through a local registry and reports every invalid entry", async (t) => {
  const requests: string[] = [];
  const now = Date.parse("2026-08-16T00:00:00.000Z");
  const server = createServer((request, response) => {
    const name = decodeURIComponent((request.url ?? "/").slice(1));
    requests.push(name);
    response.setHeader("content-type", "application/json");
    const time: Record<string, string> = {
      old: "2020-01-01T00:00:00.000Z",
      "@scope/pkg": "2026-08-15T00:00:00.000Z",
      invalid: "not-a-date",
    };
    response.end(JSON.stringify({ time: { "1.0.0": time[name] } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const { port } = server.address() as AddressInfo;
  const registry = `http://127.0.0.1:${port}/`;
  const lock = {
    packages: {
      "": { version: "1.0.0" },
      "node_modules/old": {
        version: "1.0.0",
        resolved: "https://registry.test/old.tgz",
        integrity: "sha512-old",
      },
      "node_modules/nested/node_modules/old": {
        name: "old",
        version: "1.0.0",
        resolved: "https://registry.test/old.tgz",
        integrity: "sha512-old",
      },
      "node_modules/@scope/pkg": {
        version: "1.0.0",
        resolved: "https://registry.test/scope.tgz",
        integrity: "sha512-scope",
      },
      "node_modules/missing": {
        version: "1.0.0",
        resolved: "https://registry.test/missing.tgz",
        integrity: "sha512-missing",
      },
      "node_modules/invalid": {
        version: "1.0.0",
        resolved: "https://registry.test/invalid.tgz",
        integrity: "sha512-invalid",
      },
      "node_modules/no-hash": {
        version: "2.0.0",
        resolved: "https://registry.test/no-hash.tgz",
      },
      "node_modules/not-a-package": { version: 1 },
    },
  };

  const result = await checkPackageAge(lock, now, registry);
  assert.equal(result.checked, 4);
  assert.deepEqual(requests.sort(), ["@scope/pkg", "invalid", "missing", "old"]);
  assert.equal(result.failures.length, 4);
  assert.match(result.failures.join("\n"), /no-hash@2\.0\.0: lockfile entry has no integrity/u);
  assert.match(result.failures.join("\n"), /@scope\/pkg@1\.0\.0: published/u);
  assert.match(result.failures.join("\n"), /missing@1\.0\.0: registry did not provide/u);
  assert.match(result.failures.join("\n"), /invalid@1\.0\.0: published not-a-date/u);

  const root = await temporaryDirectory("ai-pr-reviewer-package-age-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "package-lock.json");
  await writeFile(lockPath, JSON.stringify({ packages: {} }));
  assert.deepEqual(await checkPackageAgeFile(lockPath, now, registry), {
    checked: 0,
    failures: [],
  });
  await assert.rejects(checkPackageAge({}), /no packages mapping/u);
});

test("fails package-age checks when the registry request fails", async (t) => {
  const server = createServer((_request, response) => {
    response.statusCode = 503;
    response.end("unavailable");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const { port } = server.address() as AddressInfo;
  await assert.rejects(
    checkPackageAge(
      {
        packages: {
          "node_modules/unavailable": {
            version: "1.0.0",
            resolved: "https://registry.test/unavailable.tgz",
            integrity: "sha512-value",
          },
        },
      },
      Date.now(),
      `http://127.0.0.1:${port}`,
    ),
    /unavailable@1\.0\.0 \(503\)/u,
  );
});

async function createRuntimeFixture(root: string): Promise<void> {
  await mkdir(join(root, "build/lib"), { recursive: true });
  await mkdir(join(root, "build/runtime"), { recursive: true });
  await mkdir(join(root, "node_modules/@anthropic-ai/claude-agent-sdk"), { recursive: true });
  await mkdir(join(root, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64"), {
    recursive: true,
  });
  await writeFile(join(root, "build/index.js"), "export {};\n");
  await writeFile(join(root, "build/lib/value.js"), "export const value = 1;\n");
  await writeFile(join(root, "build/runtime/index.js"), "export {};\n");
  await writeFile(
    join(root, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
    JSON.stringify({ version: "1.2.3", claudeCodeVersion: "4.5.6" }),
  );
  await writeFile(
    join(root, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/package.json"),
    JSON.stringify({ version: "1.2.3", os: ["linux"], cpu: ["x64"], libc: ["glibc"] }),
  );
}

test("prepares a validated runtime bundle from real files", async (t) => {
  const root = await temporaryDirectory("ai-pr-reviewer-prepare-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await createRuntimeFixture(root);
  const result = await prepareRuntime(
    [
      "release",
      "runtime-linux-x64.tar.gz",
      "v1.1.1-rc.0",
      "v1.1.1",
      "a".repeat(40),
      "linux",
      "x64",
      "glibc",
    ],
    root,
  );
  const manifest = JSON.parse(
    await readFile(join(result.bundle, "runtime/manifest.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(result.asset, "runtime-linux-x64.tar.gz");
  assert.equal(manifest.artifactTag, "v1.1.1-rc.0");
  assert.equal(manifest.stableTag, "v1.1.1");
  assert.equal(manifest.sdkVersion, "1.2.3");
  assert.equal(manifest.cliVersion, "4.5.6");
  assert.equal(
    await readFile(join(result.bundle, "lib/value.js"), "utf8"),
    "export const value = 1;\n",
  );
});

test("rejects inconsistent runtime metadata before copying a bundle", async (t) => {
  const root = await temporaryDirectory("ai-pr-reviewer-prepare-invalid-");
  t.after(() => rm(root, { recursive: true, force: true }));
  await createRuntimeFixture(root);
  const base = [
    "release",
    "runtime-linux-x64.tar.gz",
    "v1.1.1-rc.0",
    "v1.1.1",
    "a".repeat(40),
    "linux",
    "x64",
    "glibc",
  ] as const;
  await assert.rejects(
    prepareRuntime([base[0], base[1], base[2], "v1.1.2", ...base.slice(4)], root),
    /matching RC\/stable/u,
  );
  await assert.rejects(
    prepareRuntime([...base.slice(0, 5), "freebsd", "x64", ""], root),
    /Unsupported runtime target/u,
  );
  await assert.rejects(
    prepareRuntime([base[0], "wrong.tar.gz", ...base.slice(2)], root),
    /does not match target/u,
  );
  await writeFile(
    join(root, "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/package.json"),
    JSON.stringify({ version: "9.9.9", os: ["linux"], cpu: ["x64"], libc: ["glibc"] }),
  );
  await assert.rejects(prepareRuntime(base, root), /native package does not match/u);
  await writeFile(
    join(root, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
    JSON.stringify({ claudeCodeVersion: "4.5.6" }),
  );
  await assert.rejects(prepareRuntime(base, root), /metadata has no version/u);
  await writeFile(join(root, "node_modules/@anthropic-ai/claude-agent-sdk/package.json"), "[]");
  await assert.rejects(prepareRuntime(base, root), /Package metadata is invalid/u);
});

async function createBuildPackage(root: string, script: string): Promise<void> {
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ type: "module", scripts: { build: "node build.mjs" } }),
  );
  await writeFile(join(root, "build.mjs"), script);
}

test("verifies deterministic builds and detects changed output", async (t) => {
  const deterministic = await temporaryDirectory("ai-pr-reviewer-repro-good-");
  const changing = await temporaryDirectory("ai-pr-reviewer-repro-bad-");
  t.after(() => rm(deterministic, { recursive: true, force: true }));
  t.after(() => rm(changing, { recursive: true, force: true }));
  await createBuildPackage(
    deterministic,
    'import { mkdir, writeFile } from "node:fs/promises"; await mkdir("build/nested", { recursive: true }); await writeFile("build/index.js", "same\\n"); await writeFile("build/nested/value.js", "same\\n");',
  );
  assert.equal(await verifyReproducibleBuild(deterministic), 2);

  await createBuildPackage(
    changing,
    'import { mkdir, readFile, writeFile } from "node:fs/promises"; const count = Number(await readFile("counter", "utf8").catch(() => "0")) + 1; await writeFile("counter", String(count)); await mkdir("build", { recursive: true }); await writeFile("build/index.js", String(count));',
  );
  await assert.rejects(verifyReproducibleBuild(changing), /Compiled runtime is not reproducible/u);
  await assert.rejects(
    reproducibleBuildInternals.run(process.execPath, ["-e", "process.exit(3)"], changing),
    /failed \(3\)/u,
  );
});

test("runs release CLI workers with real files and output records", async (t) => {
  const root = await temporaryDirectory("ai-pr-reviewer-release-cli-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const releasesPath = join(root, "releases.json");
  const tagsPath = join(root, "tags.json");
  const aliasOutput = join(root, "alias-output.txt");
  const releaseOutput = join(root, "release-output.txt");
  const release = {
    tag_name: "v1.0.0-rc.0",
    draft: false,
    prerelease: true,
    published_at: "2026-08-16T00:00:00Z",
  };
  await writeFile(releasesPath, JSON.stringify([release]));
  await writeFile(tagsPath, "[]");
  assert.deepEqual(
    await selectReleaseAliasCli(
      ["--release-tag", "v1.0.0-rc.0", "--releases", releasesPath],
      aliasOutput,
    ),
    { alias_tag: "v1-prerelease", release_tag: "v1.0.0-rc.0" },
  );
  assert.match(await readFile(aliasOutput, "utf8"), /alias_tag=v1-prerelease/u);
  assert.deepEqual(
    await validateReleaseCli(
      [
        "--version",
        "1.0.0-rc.0",
        "--branch",
        "main",
        "--channel",
        "prerelease",
        "--releases",
        tagsPath,
        "--tags",
        tagsPath,
      ],
      releaseOutput,
    ),
    {
      release_tag: "v1.0.0-rc.0",
      stable_tag: "v1.0.0",
      prerelease: true,
      source_rc_tag: "",
    },
  );
  assert.match(await readFile(releaseOutput, "utf8"), /release_tag=v1\.0\.0-rc\.0/u);
  await assert.rejects(selectReleaseAliasCli([], undefined), /Missing required --release-tag/u);
  await assert.rejects(validateReleaseCli([], undefined), /Missing required --version/u);
});

test("replays a frozen case without publishing, switching revisions, or exposing labels", async (t) => {
  const {
    root: checkout,
    temporaryRoot: results,
    baseSha,
    headSha,
  } = await makeReplayRepository(t);
  const canonicalCheckout = await realpath(checkout);
  const mergeBaseSha = baseSha;
  const changedPath = "review.txt";
  const context = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 123,
    baseSha,
    headSha,
    baseRef: "main",
    title: "Example mcp-replay-credential",
    body: "PR body replay-secret",
    htmlUrl: "https://github.com/owner/repository/pull/123",
  };
  const input: ReplayCase = parseReplayCase({
    version: 1,
    caseId: "case-replay-secret",
    labels: { expected: ["known-defect"], private: "replay-secret" },
    context,
    config: {
      aiBaseUrl: "https://api.example.test",
      model: "consumer-model-id",
      systemPrompt: "Consumer replacement prompt.",
      reviewPrompts: [{ prompt: "Review the changed behavior." }],
      parallelCount: 1,
      maxTurns: 25,
      interactWithPullRequest: false,
      mcpServers: {
        security: {
          type: "http",
          url: "https://mcp.example.test",
          headers: {
            "X-MCP-Key": "mcp-replay-credential",
            "X-Path-Secret": changedPath,
            "X-Repository-Secret": context.repository,
            "X-Base-Secret": baseSha,
            "X-Head-Secret": headSha,
            "X-Merge-Base-Secret": mergeBaseSha,
          },
        },
      },
    },
    conversation: {
      digest: "conversation-digest",
      entries: [
        {
          kind: "pr_comment",
          id: 1,
          createdAt: "2026-09-23T00:00:00Z",
          message: {
            id: 1,
            authorRole: "human",
            body: "Discussion mcp-replay-credential replay-secret",
            createdAt: "2026-09-23T00:00:00Z",
            updatedAt: "2026-09-23T00:00:00Z",
          },
        },
      ],
    },
    briefing: {
      linkedIssues: [
        {
          number: 321,
          title: "Issue mcp-replay-credential",
          state: "OPEN",
          body: "Issue body replay-secret",
          htmlUrl: "https://github.com/owner/repository/issues/321",
        },
      ],
      linkedIssueReferencesTruncated: false,
    },
  });
  assert.throws(() =>
    parseReplayCase({
      ...input,
      config: {
        ...input.config,
        reviewPrompts: [{ prompt: "Review", files: ["relative/context.txt"] }],
      },
    }),
  );

  const previousSecret = process.env.AI_PR_REVIEWER_SECRET;
  process.env.AI_PR_REVIEWER_SECRET = "replay-secret";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.AI_PR_REVIEWER_SECRET;
    else process.env.AI_PR_REVIEWER_SECRET = previousSecret;
  });
  const beforeHead = await git(checkout, ["rev-parse", "HEAD"]);
  const beforeBranch = await git(checkout, ["branch", "--show-current"]);
  let observedCalls = 0;
  let replayFindingPath = "";
  let replayFindingLine = 0;
  const runner: ReplayRunner = (
    replayContext,
    files,
    conversation,
    config,
    contextFiles,
    replayCheckout,
    _queryAgent,
    _abortController,
    briefing,
  ): Promise<readonly GoalResult[]> => {
    observedCalls += 1;
    assert.equal(replayContext.headSha, headSha);
    assert.equal(replayContext.title, "Example [REDACTED]");
    assert.equal(replayContext.body, "PR body [REDACTED]");
    assert.equal(replayCheckout, canonicalCheckout);
    assert.doesNotMatch(JSON.stringify(conversation), /mcp-replay-credential|replay-secret/u);
    assert.ok(briefing);
    assert.equal(briefing.linkedIssues[0]?.title, "Issue [REDACTED]");
    assert.equal(briefing.linkedIssues[0]?.body, "Issue body [REDACTED]");
    const changedFile = files[0];
    assert.ok(changedFile);
    assert.equal(files.length, 1);
    assert.equal(changedFile.path, changedPath);
    assert.deepEqual([...changedFile.addedLines], [2]);
    replayFindingPath = changedFile.path;
    replayFindingLine = 2;
    assert.equal(contextFiles[0]?.length, 0);
    assert.equal(config.reviewPrompts[0]?.prompt, "Review the changed behavior.");
    assert.equal(JSON.stringify(config).includes("known-defect"), false);
    return Promise.resolve([
      {
        inspection: {
          observedPaths: [
            ...files.flatMap((file) => [
              file.path,
              ...(file.previousPath === undefined ? [] : [file.previousPath]),
            ]),
          ],
          missingPaths: [],
        },
        prompt: "Review the changed behavior.",
        status: "completed",
        diagnostics: {
          submissionAttempts: 2,
          repairAttempts: 1,
          evidenceReferences: 3,
          rejectionCounts: { "replay-secret": 1 },
          termination: "replay-secret",
        },
        submission: {
          summary: "Found a replay-secret example.",
          findings: [
            {
              title: "replay-secret defect",
              severity: "MODERATE",
              body: "The replay-secret value is dropped.",
              path: replayFindingPath,
              line: replayFindingLine,
            },
          ],
          limitations: [],
        },
      },
    ]);
  };
  const output = await replayCase(input, checkout, runner);
  assert.equal(observedCalls, 1);
  assert.equal(output.version, 2);
  assert.equal(output.caseId, "case-[REDACTED]");
  assert.deepEqual(output.labels, { expected: ["known-defect"], private: "[REDACTED]" });
  assert.equal(output.partial, false);
  assert.deepEqual(output.goals[0]?.diagnostics, {
    submissionAttempts: 2,
    repairAttempts: 1,
    evidenceReferences: 3,
    rejectionCounts: { "[REDACTED]": 1 },
    termination: "[REDACTED]",
  });
  assert.equal(output.findings instanceof Array, true);
  assert.equal(output.repository, "[REDACTED]");
  assert.equal(output.baseSha, "[REDACTED]");
  assert.equal(output.mergeBaseSha, "[REDACTED]");
  assert.equal(output.headSha, "[REDACTED]");
  assert.equal(JSON.stringify(output).includes("replay-secret"), false);
  assert.equal(JSON.stringify(output).includes("mcp-replay-credential"), false);
  assert.equal(JSON.stringify(output).includes(changedPath), false);
  for (const secret of [context.repository, baseSha, mergeBaseSha, headSha])
    assert.equal(JSON.stringify(output).includes(secret), false);
  assert.equal("prompt" in (output.goals[0] ?? {}), false);
  assert.equal(serializeReplayOutput(output), serializeReplayOutput(output));

  const nonIdentityInput: ReplayCase = parseReplayCase({
    ...input,
    config: {
      ...input.config,
      mcpServers: {
        security: {
          type: "http",
          url: "https://mcp.example.test",
          headers: {
            "X-MCP-Key": "mcp-replay-credential",
            "X-Path-Secret": changedPath,
          },
        },
      },
    },
  });
  const ordinaryOutput = await replayCase(nonIdentityInput, checkout, runner);
  assert.equal(ordinaryOutput.repository, context.repository);
  assert.equal(ordinaryOutput.baseSha, baseSha);
  assert.equal(ordinaryOutput.mergeBaseSha, mergeBaseSha);
  assert.equal(ordinaryOutput.headSha, headSha);
  assert.equal(observedCalls, 2);

  await assert.rejects(
    validateReplayOutputPath(join(checkout, "result.json"), checkout),
    /outside the checkout/u,
  );

  const outputPath = join(results, "case-001.json");
  await writeReplayOutput(output, outputPath, checkout);
  const outputText = await readFile(outputPath, "utf8");
  assert.equal(outputText, serializeReplayOutput(output));
  assert.equal(outputText.includes("replay-secret"), false);
  await assert.rejects(writeReplayOutput(output, outputPath, checkout), /already exists/u);
  assert.equal(await git(checkout, ["rev-parse", "HEAD"]), beforeHead);
  assert.equal(await git(checkout, ["branch", "--show-current"]), beforeBranch);
  assert.equal(
    await git(checkout, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=matching",
    ]),
    "",
  );

  await writeFile(join(checkout, "ignored.tmp"), "ignored workspace content\n");
  await assert.rejects(replayCase(input, checkout, runner), /must be pristine/u);
  await rm(join(checkout, "ignored.tmp"));
  await assert.rejects(
    replayCase({ ...input, context: { ...input.context, headSha: baseSha } }, checkout, runner),
    /does not match case head/u,
  );
});

test("accepts Action-supported replay limits and reserves the internal MCP server", () => {
  const context = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 1,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    baseRef: "main",
    title: "Review case",
    htmlUrl: "https://github.com/owner/repository/pull/1",
  };
  const supported = parseReplayCase({
    version: 1,
    caseId: "supported-boundaries",
    context,
    config: {
      model: "consumer-model-id",
      reviewPrompts: Array.from({ length: 50 }, (_, index) => ({
        prompt: index === 0 ? "x".repeat(12_000) : "Review the change.",
        files: Array.from({ length: 25 }, (_, fileIndex) => `/tmp/context-${fileIndex}.txt`),
      })),
      parallelCount: 10,
      maxTurns: 500,
      mcpServers: {},
    },
  });
  assert.equal(supported.config.reviewPrompts.length, 50);
  assert.equal(supported.config.reviewPrompts[0]?.prompt.length, 12_000);
  assert.equal(supported.config.reviewPrompts[0]?.files.length, 25);
  const maxRunFiles = parseReplayCase({
    ...supported,
    config: {
      ...supported.config,
      reviewPrompts: Array.from({ length: 4 }, (_, goalIndex) => ({
        prompt: "Review the change.",
        files: Array.from(
          { length: 25 },
          (_, fileIndex) => `/tmp/run-${goalIndex * 25 + fileIndex}.txt`,
        ),
      })),
    },
  });
  assert.equal(maxRunFiles.config.reviewPrompts.flatMap((goal) => goal.files).length, 100);
  assert.throws(() =>
    parseReplayCase({
      ...maxRunFiles,
      config: {
        ...maxRunFiles.config,
        reviewPrompts: Array.from({ length: 5 }, (_, goalIndex) => ({
          prompt: "Review the change.",
          files: Array.from(
            { length: 25 },
            (_, fileIndex) => `/tmp/over-limit-${goalIndex * 25 + fileIndex}.txt`,
          ),
        })),
      },
    }),
  );
  assert.throws(() =>
    parseReplayCase({
      ...supported,
      config: { ...supported.config, reviewPrompts: [{ prompt: "x".repeat(12_001) }] },
    }),
  );
  assert.throws(() =>
    parseReplayCase({
      ...supported,
      config: {
        ...supported.config,
        mcpServers: {
          review_output: { type: "http", url: "https://mcp.example.test" },
        },
      },
    }),
  );
});

test("keeps replay independent of shallow, deletion-only, and symlinked callers", async (t) => {
  const { root, temporaryRoot, headSha } = await makeReplayRepository(t);
  const shallow = join(temporaryRoot, "shallow");
  await git(root, ["clone", "--quiet", "--depth=1", pathToFileURL(root).href, shallow]);
  assert.equal(await git(shallow, ["rev-parse", "--is-shallow-repository"]), "true");
  await assert.rejects(git(shallow, ["rev-parse", "--verify", "HEAD^"]));
  await rm(join(root, "review.txt"));
  const deletedHead = await commitFixtureSnapshot(root, temporaryRoot, headSha);
  assert.equal(await git(root, ["diff", "--numstat", headSha, deletedHead]), "0\t2\treview.txt");
  const linkedTemporary = join(temporaryRoot, "linked-temp");
  const actualTemporary = join(temporaryRoot, "actual-temp");
  await mkdir(actualTemporary);
  await symlink(
    actualTemporary,
    linkedTemporary,
    process.platform === "win32" ? "junction" : "dir",
  );
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  for (const [name, cwd, temporary] of [
    ["shallow", shallow, actualTemporary],
    ["deletion-only", root, actualTemporary],
    ["symlinked temp", root, linkedTemporary],
  ] as const) {
    await t.test(name, async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--test",
          "--test-reporter=spec",
          "--test-name-pattern=^replays a frozen case ",
          fileURLToPath(import.meta.url),
        ],
        {
          cwd,
          encoding: "utf8",
          env: { ...childEnvironment, TMPDIR: temporary, TEMP: temporary, TMP: temporary },
        },
      );
      assert.match(stdout, /replays a frozen case/u);
      assert.match(stdout, /pass 1/u);
    });
  }
});

test("builds replay outside its pristine package checkout and cleans success and failure", async (t) => {
  const source = fileURLToPath(new URL("../../", import.meta.url));
  const { root, temporaryRoot, context } = await makeReplayRepository(t, async (checkout) => {
    for (const path of ["src", "scripts", "package.json", "tsconfig.json", "tsconfig.replay.json"])
      await cp(join(source, path), join(checkout, path), { recursive: true });
  });
  await symlink(
    join(source, "node_modules"),
    join(root, "../node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const initialTemporary = await readdir(temporaryRoot);
  const canonicalRoot = await realpath(root);
  const status = () =>
    git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]);
  assert.equal(await status(), "");
  const input = parseReplayCase({
    version: 1,
    caseId: "self-replay",
    context,
    config: { model: "consumer-model-id", reviewPrompts: [{ prompt: "Review" }] },
  });
  const previousSecret = process.env.AI_PR_REVIEWER_SECRET;
  process.env.AI_PR_REVIEWER_SECRET = "replay-secret";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.AI_PR_REVIEWER_SECRET;
    else process.env.AI_PR_REVIEWER_SECRET = previousSecret;
  });
  const runtime = await prepareReplayRuntime(root, root, temporaryRoot);
  t.after(runtime.cleanup);
  assert.ok(runtime.entry.startsWith(await realpath(temporaryRoot)));
  const replay = (await import(pathToFileURL(runtime.entry).href)) as {
    replayCase: typeof replayCase;
  };
  let calls = 0;
  const runner: ReplayRunner = (_context, files, _conversation, _config, _files, checkout) => {
    calls += 1;
    assert.equal(checkout, canonicalRoot);
    assert.deepEqual(
      files.map((file) => file.path),
      ["review.txt"],
    );
    return Promise.resolve([
      {
        prompt: "Review",
        status: "completed",
        inspection: { observedPaths: ["review.txt"], missingPaths: [] },
        submission: { summary: "Complete", findings: [], limitations: [] },
      },
    ]);
  };
  const output = await replay.replayCase(input, root, runner);
  assert.equal(calls, 1);
  assert.equal(output.partial, false);
  assert.equal(await status(), "");
  await writeFile(join(root, "ignored.tmp"), "unrelated ignored artifact\n");
  assert.match(await status(), /!! ignored\.tmp/u);
  await assert.rejects(replay.replayCase(input, root, runner), /must be pristine/u);
  assert.equal(calls, 1);
  await rm(join(root, "ignored.tmp"));
  await runtime.cleanup();
  assert.deepEqual(await readdir(temporaryRoot), initialTemporary);

  const casePath = join(temporaryRoot, "case.json");
  await writeFile(casePath, JSON.stringify(input));
  const beforeCli = await readdir(temporaryRoot);
  await assert.rejects(
    execFileAsync(
      "npm",
      [
        "run",
        "replay:review",
        "--",
        "--case",
        casePath,
        "--checkout",
        root,
        "--output",
        join(temporaryRoot, "result.json"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          TMPDIR: temporaryRoot,
          TEMP: temporaryRoot,
          TMP: temporaryRoot,
          AI_PR_REVIEWER_SECRET: "",
          ANTHROPIC_API_KEY: "",
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error && "stderr" in error && typeof error.stderr === "string");
      assert.match(error.stderr, /Set AI_PR_REVIEWER_SECRET or ANTHROPIC_API_KEY/u);
      assert.doesNotMatch(error.stderr, /must be pristine|ERR_MODULE_NOT_FOUND/u);
      return true;
    },
  );
  assert.equal(await status(), "");
  assert.deepEqual(await readdir(temporaryRoot), beforeCli);
  await assert.rejects(prepareReplayRuntime(root, root, root), /must be outside/u);
  const link = join(temporaryRoot, "checkout-link");
  await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareReplayRuntime(root, root, link), /must be outside/u);
  await writeFile(join(root, "tsconfig.replay.json"), "invalid json");
  const beforeFailure = await readdir(temporaryRoot);
  await assert.rejects(prepareReplayRuntime(root, root, temporaryRoot), /Command failed/u);
  assert.deepEqual(await readdir(temporaryRoot), beforeFailure);
});

test("rejects missing replay checkout arguments before building", async () => {
  for (const args of [[], ["--checkout"], ["--checkout", "--output", "result.json"]])
    await assert.rejects(runReplay(args), /Usage: npm run replay:review/u);
});

test("runs the guarded runtime entry worker", async () => {
  let calls = 0;
  await runRuntimeEntry(() => {
    calls += 1;
    return Promise.resolve();
  });
  assert.equal(calls, 1);
});
