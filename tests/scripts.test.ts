import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
import { runRuntimeEntry } from "../src/runtime/index.js";

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

test("runs the guarded runtime entry worker", async () => {
  let calls = 0;
  await runRuntimeEntry(() => {
    calls += 1;
    return Promise.resolve();
  });
  assert.equal(calls, 1);
});
