import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { isSafeArchiveEntryPath, isSafeArchiveSymlink } from "../src/lib/bootstrap/archive.js";
import {
  aliasAcceptsRelease,
  isCompatibleRuntimeManifest,
  parseActionReleaseReference,
  parseActionReleaseTag,
} from "../src/lib/bootstrap/version.js";
import { bootstrapInternals, bootstrapRuntime, resolveActionRelease } from "../src/bootstrap.js";

const execFileAsync = promisify(execFile);

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

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
    resolveActionRelease("v1", fetcher({ object: { type: "tag", sha: aliasObject } }, null, {})),
    /invalid metadata/i,
  );
  await assert.rejects(
    resolveActionRelease(
      "v1",
      fetcher(
        { object: { type: "tag", sha: aliasObject } },
        { tag: "wrong-alias", message: "v1.6.1", object: { type: "commit", sha: releaseCommit } },
        {},
      ),
    ),
    /invalid metadata/i,
  );
  await assert.rejects(
    resolveActionRelease(
      "v1",
      fetcher(
        { object: { type: "tag", sha: aliasObject } },
        { tag: "v1", message: "invalid", object: { type: "commit", sha: releaseCommit } },
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
        { tag: "v1", message: "v1.6.1", object: { type: "tag", sha: releaseCommit } },
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

test("downloads, verifies, extracts, and executes a runtime bundle", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-bootstrap-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, "source");
  const output = join(root, "runtime-output.txt");
  const archive = join(root, "runtime.tar.gz");
  const assetName = bootstrapInternals.platformAssetName();
  const sourceCommit = "a".repeat(40);
  await mkdir(join(bundle, "runtime"), { recursive: true });
  await writeFile(
    join(bundle, "runtime/index.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(output)}, process.env.AI_PR_REVIEWER_BUILD_ID ?? "missing");\n`,
  );
  await writeFile(
    join(bundle, "runtime/manifest.json"),
    JSON.stringify({
      artifactTag: "v1.1.1-rc.0",
      stableTag: "v1.1.1",
      asset: assetName,
      nodeMajor: 24,
      sdkVersion: "1.2.3",
      cliVersion: "4.5.6",
      sourceCommit,
    }),
  );
  await execFileAsync("tar", ["-czf", archive, "-C", bundle, "."]);
  const bytes = await readFile(archive);
  const digest = bootstrapInternals.sha256(bytes);

  const server = createServer((request, response) => {
    if (request.url === "/runtime.sha256") {
      response.end(`${digest}  ${assetName}\n`);
      return;
    }
    if (request.url === "/runtime") {
      response.setHeader("content-length", String(bytes.byteLength));
      response.end(bytes);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const { port } = server.address() as AddressInfo;
  const assetUrl = `http://127.0.0.1:${port}/runtime`;
  const code = await bootstrapRuntime({
    releaseRef: "v1.1.1-rc.0",
    temporaryRoot: root,
    getJson: <T>(): Promise<T> =>
      Promise.resolve({
        tag_name: "v1.1.1-rc.0",
        draft: false,
        prerelease: true,
        assets: [
          {
            name: assetName,
            browser_download_url: assetUrl,
            size: bytes.byteLength,
          },
        ],
      } as T),
  });

  assert.equal(code, 0);
  assert.equal(await readFile(output, "utf8"), sourceCommit);
});

test("validates bootstrap asset metadata, headers, checksums, and HTTP failures", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-bootstrap-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.throws(() => bootstrapInternals.readAsset(null), /invalid asset record/u);
  assert.deepEqual(
    bootstrapInternals.readAsset({
      name: "runtime.tar.gz",
      browser_download_url: "https://example.test/runtime",
    }),
    {
      name: "runtime.tar.gz",
      browser_download_url: "https://example.test/runtime",
    },
  );
  assert.deepEqual(
    bootstrapInternals.readAsset({
      name: "runtime.tar.gz",
      browser_download_url: "https://example.test/runtime",
      digest: `sha256:${"A".repeat(64)}`,
      size: 10,
    }),
    {
      name: "runtime.tar.gz",
      browser_download_url: "https://example.test/runtime",
      digest: `sha256:${"A".repeat(64)}`,
      size: 10,
    },
  );
  assert.equal(
    bootstrapInternals.expectedDigest({ digest: `sha256:${"A".repeat(64)}` }, undefined),
    "a".repeat(64),
  );
  assert.equal(
    bootstrapInternals.expectedDigest({}, `${"b".repeat(64)}  runtime.tar.gz\n`),
    "b".repeat(64),
  );
  assert.throws(() => bootstrapInternals.expectedDigest({}, undefined), /no verifiable SHA-256/u);
  assert.equal(
    bootstrapInternals.expectedDigest(
      { digest: "sha256:not-a-digest" },
      `${"c".repeat(64)}  runtime.tar.gz`,
    ),
    "c".repeat(64),
  );
  assert.equal(bootstrapInternals.gitObject(null, "commit"), undefined);
  assert.equal(bootstrapInternals.gitObject({ object: null }, "commit"), undefined);
  assert.equal(
    bootstrapInternals.gitObject({ object: { type: "tag", sha: "a".repeat(40) } }, "commit"),
    undefined,
  );
  assert.equal(
    bootstrapInternals.gitObject({ object: { type: "commit", sha: "invalid" } }, "commit"),
    undefined,
  );
  assert.equal(
    bootstrapInternals.gitObject({ object: { type: "commit", sha: "a".repeat(40) } }, "commit"),
    "a".repeat(40),
  );

  const originalToken = process.env["INPUT_GITHUB-PAT"];
  delete process.env["INPUT_GITHUB-PAT"];
  assert.equal(bootstrapInternals.apiRequestHeaders().has("authorization"), false);
  process.env["INPUT_GITHUB-PAT"] = "bootstrap-token";
  t.after(() => {
    if (originalToken === undefined) delete process.env["INPUT_GITHUB-PAT"];
    else process.env["INPUT_GITHUB-PAT"] = originalToken;
  });
  assert.equal(
    bootstrapInternals.apiRequestHeaders().get("authorization"),
    "Bearer bootstrap-token",
  );
  assert.equal(bootstrapInternals.requestHeaders().has("authorization"), false);

  const server = createServer((request, response) => {
    if (request.url === "/json") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/small") {
      response.write("small payload");
      response.end();
      return;
    }
    if (request.url === "/checksum") {
      response.end(`${"d".repeat(64)}  runtime.tar.gz\n`);
      return;
    }
    if (request.url === "/missing") {
      response.statusCode = 404;
      response.end();
      return;
    }
    if (request.url === "/oversized") {
      response.setHeader("content-length", String(601 * 1024 * 1024));
      response.end();
      return;
    }
    response.statusCode = 503;
    response.end("unavailable");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  assert.deepEqual(await bootstrapInternals.fetchJson(`${base}/json`), { ok: true });
  await assert.rejects(bootstrapInternals.fetchJson(`${base}/error`), /lookup failed \(503\)/u);
  assert.equal(
    await bootstrapInternals.readChecksum(`${base}/checksum`),
    `${"d".repeat(64)}  runtime.tar.gz\n`,
  );
  assert.equal(await bootstrapInternals.readChecksum(`${base}/missing`), undefined);
  await assert.rejects(
    bootstrapInternals.readChecksum(`${base}/error`),
    /download failed \(503\)/u,
  );
  await assert.rejects(
    bootstrapInternals.download(`${base}/error`, join(tmpdir(), "unused-runtime")),
    /asset download failed \(503\)/u,
  );
  await assert.rejects(
    bootstrapInternals.download(`${base}/oversized`, join(tmpdir(), "unused-runtime")),
    /larger than the safety limit/u,
  );
  const downloaded = await bootstrapInternals.download(`${base}/small`, join(root, "small.bin"));
  assert.equal(Buffer.from(downloaded).toString("utf8"), "small payload");
  assert.equal(await readFile(join(root, "small.bin"), "utf8"), "small payload");
});

test("rejects unsafe archives and reports runtime process outcomes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-bootstrap-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const unsafeArchive = join(root, "unsafe.tar.gz");
  await mkdir(join(source, "runtime"), { recursive: true });
  await symlink("../../outside", join(source, "runtime/link"));
  await execFileAsync("tar", ["-czf", unsafeArchive, "-C", source, "."]);
  await assert.rejects(
    bootstrapInternals.extract(unsafeArchive, join(root, "unsafe-output")),
    /unsafe path/u,
  );
  const invalidArchive = join(root, "invalid.tar.gz");
  await writeFile(invalidArchive, "not a tar archive");
  await assert.rejects(
    bootstrapInternals.extract(invalidArchive, join(root, "invalid-output")),
    /archive listing failed/u,
  );

  const missing = join(root, "missing-runtime");
  await mkdir(missing);
  await assert.rejects(bootstrapInternals.runRuntime(missing), /missing runtime\/index\.js/u);

  const failing = join(root, "failing-runtime");
  await mkdir(join(failing, "runtime"), { recursive: true });
  await writeFile(join(failing, "runtime/index.js"), "process.exitCode = 7;\n");
  assert.equal(await bootstrapInternals.runRuntime(failing), 7);

  const signaled = join(root, "signaled-runtime");
  await mkdir(join(signaled, "runtime"), { recursive: true });
  await writeFile(join(signaled, "runtime/index.js"), 'process.kill(process.pid, "SIGTERM");\n');
  assert.equal(await bootstrapInternals.runRuntime(signaled), 1);
});

test("rejects release and manifest mismatches before runtime execution", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-bootstrap-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetName = bootstrapInternals.platformAssetName();
  const invalidRelease = (value: Record<string, unknown>) =>
    bootstrapRuntime({
      releaseRef: "v1.1.1-rc.0",
      temporaryRoot: root,
      getJson: <T>(): Promise<T> => Promise.resolve(value as T),
    });
  await assert.rejects(
    invalidRelease({ tag_name: "v1.1.1", draft: false, prerelease: true, assets: [] }),
    /does not match the requested action version/u,
  );
  await assert.rejects(
    invalidRelease({
      tag_name: "v1.1.1-rc.0",
      draft: false,
      prerelease: true,
      assets: [],
    }),
    new RegExp(`no asset for ${assetName.replaceAll(".", "\\.")}`, "u"),
  );
  await assert.rejects(
    invalidRelease({
      tag_name: "v1.1.1-rc.0",
      draft: false,
      prerelease: true,
      assets: [
        {
          name: assetName,
          browser_download_url: "https://example.test/runtime",
          size: 601 * 1024 * 1024,
        },
      ],
    }),
    /larger than the safety limit/u,
  );
});
