/* eslint-disable max-lines, @typescript-eslint/require-await, @typescript-eslint/prefer-promise-reject-errors, @typescript-eslint/only-throw-error */

import { strict as assert } from "node:assert";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { isSafeArchiveEntryPath, isSafeArchiveSymlink } from "../src/lib/bootstrap/archive.js";
import {
  cancellationReason,
  CancellationError,
  installCancellationHandlers,
} from "../src/lib/bootstrap/cancellation.js";
import {
  aliasAcceptsRelease,
  isCompatibleRuntimeManifest,
  parseActionReleaseReference,
  parseActionReleaseTag,
} from "../src/lib/bootstrap/version.js";
import { bootstrapInternals, bootstrapRuntime, resolveActionRelease } from "../src/bootstrap.js";
import { DiagnosticLogger } from "../src/lib/diagnostics.js";

const execFileAsync = promisify(execFile);

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${path}.`);
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
  const diagnosticLines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "bootstrap",
    secrets: ["signed-secret"],
    write: (line) => diagnosticLines.push(line),
  });
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
    if (request.url?.includes(".sha256")) {
      response.end(`${digest}  ${assetName}\n`);
      return;
    }
    if (request.url?.startsWith("/runtime")) {
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
  const assetUrl = `http://127.0.0.1:${port}/runtime?signature=signed-secret`;
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
    diagnostics,
  });

  assert.equal(code, 0);
  assert.equal(await readFile(output, "utf8"), sourceCommit);
  const records = diagnosticLines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  assert.equal(
    records.some((record) => record.operation === "github.asset.download"),
    true,
  );
  assert.equal(
    records.some((record) => record.operation === "archive.verify"),
    true,
  );
  assert.equal(
    records.some((record) => record.operation === "runtime.cleanup"),
    true,
  );
  assert.equal(JSON.stringify(records).includes("signed-secret"), false);
  assert.equal(JSON.stringify(records).includes("signature="), false);
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
  t.after(() => {
    if (originalToken === undefined) delete process.env["INPUT_GITHUB-PAT"];
    else process.env["INPUT_GITHUB-PAT"] = originalToken;
  });
  delete process.env["INPUT_GITHUB-PAT"];
  assert.equal(bootstrapInternals.apiRequestHeaders().has("authorization"), false);
  process.env["INPUT_GITHUB-PAT"] = "bootstrap-token";
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

test("checks bootstrap HTTP status before consuming non-success bodies", async (t) => {
  const previous = globalThis.fetch;
  let consumed = 0;
  globalThis.fetch = async () =>
    ({
      ok: false,
      status: 503,
      headers: new Headers({ "content-length": "11", "x-github-request-id": "bootstrap-503" }),
      text: async () => {
        consumed += 1;
        throw new Error("body should not be consumed");
      },
    }) as unknown as Response;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "bootstrap",
    write: (line) => lines.push(line),
  });
  await assert.rejects(
    bootstrapInternals.fetchJson("https://api.example.test/release", undefined, diagnostics),
    /lookup failed \(503\)/u,
  );
  assert.equal(consumed, 0);

  globalThis.fetch = async () =>
    ({
      ok: false,
      status: 404,
      headers: new Headers(),
      text: async () => {
        consumed += 1;
        throw new Error("checksum body should not be consumed");
      },
    }) as unknown as Response;
  assert.equal(
    await bootstrapInternals.readChecksum(
      "https://api.example.test/checksum",
      undefined,
      diagnostics,
    ),
    undefined,
  );
  assert.equal(consumed, 0);
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  assert.equal(
    records.some((record) => record.operation === "github.request" && record.outcome === "failure"),
    true,
  );
  const failed = records.find(
    (record) => record.operation === "github.request" && record.outcome === "failure",
  );
  assert.ok(failed);
  assert.equal((failed.details as Record<string, unknown>).request_id, "bootstrap-503");
  assert.equal((failed.details as Record<string, unknown>).required_permission, "contents:read");
  assert.equal(
    records.some(
      (record) => record.operation === "github.asset.checksum" && record.outcome === "skipped",
    ),
    true,
  );
});

test("sanitizes malformed successful bootstrap JSON diagnostics", async (t) => {
  const previous = globalThis.fetch;
  const sentinel = "malformed-bootstrap-response-sentinel";
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => `{"release":"${sentinel}`,
    }) as unknown as Response;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "bootstrap",
    write: (line) => lines.push(line),
  });
  await assert.rejects(
    bootstrapInternals.fetchJson("https://api.example.test/malformed", undefined, diagnostics),
    (error: unknown) => error instanceof SyntaxError,
  );
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  assert.equal(JSON.stringify(records).includes(sentinel), false);
  const terminal = records.find((record) => record.event === "operation.finished");
  assert.ok(terminal);
  assert.equal(
    ((terminal.details as Record<string, unknown>).error as Record<string, unknown>).message,
    "GitHub release metadata JSON parsing failed.",
  );
});

test("retains bootstrap response metadata when the response body read fails", async (t) => {
  const previous = globalThis.fetch;
  const bodyError = new Error("bootstrap-body-read-sentinel");
  globalThis.fetch = async () =>
    ({
      ok: true,
      status: 502,
      headers: new Headers({ "x-github-request-id": "bootstrap-body-read" }),
      text: async () => {
        throw bodyError;
      },
    }) as unknown as Response;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "bootstrap",
    write: (line) => lines.push(line),
  });
  await assert.rejects(
    bootstrapInternals.fetchJson("https://api.example.test/body-read", undefined, diagnostics),
    (error: unknown) => error === bodyError,
  );
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const terminal = records.find((record) => record.event === "operation.finished");
  assert.ok(terminal);
  const details = terminal.details as Record<string, unknown>;
  assert.equal(details.status, 502);
  assert.equal(details.request_id, "bootstrap-body-read");
  assert.equal(details.required_permission, "contents:read");
  assert.equal(
    (details.error as Record<string, unknown>).message,
    "GitHub release response body read failed.",
  );
  assert.equal(JSON.stringify(records).includes("bootstrap-body-read-sentinel"), false);
});

test("sanitizes immutable and primitive bootstrap body-read rejections", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const failures: readonly [string, unknown][] = [
    ["bootstrap-frozen-body-sentinel", Object.freeze(new Error("bootstrap-frozen-body-sentinel"))],
    ["bootstrap-primitive-body-sentinel", "bootstrap-primitive-body-sentinel"],
  ];
  for (const [index, [sentinel, bodyError]] of failures.entries()) {
    const requestId = `bootstrap-immutable-${index}`;
    globalThis.fetch = async () =>
      ({
        ok: true,
        status: 502,
        headers: new Headers({ "x-github-request-id": requestId }),
        text: async () => Promise.reject(bodyError),
      }) as unknown as Response;
    const lines: string[] = [];
    const diagnostics = new DiagnosticLogger({
      component: "bootstrap",
      write: (line) => lines.push(line),
    });
    await assert.rejects(
      bootstrapInternals.fetchJson(
        `https://api.example.test/body-read/${String(index)}`,
        undefined,
        diagnostics,
      ),
      (error: unknown) => error === bodyError,
    );
    const records = lines.map(
      (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
    );
    const terminal = records.find((record) => record.event === "operation.finished");
    assert.ok(terminal);
    assert.equal(
      ((terminal.details as Record<string, unknown>).error as Record<string, unknown>).message,
      "GitHub release response body read failed.",
    );
    assert.equal(JSON.stringify(records).includes(sentinel), false);
  }
});

test("keeps immutable body-read failures redacted through bootstrap lifecycle spans", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const failures: readonly [string, unknown][] = [
    [
      "bootstrap-lifecycle-frozen-sentinel",
      Object.freeze(new Error("bootstrap-lifecycle-frozen-sentinel")),
    ],
    ["bootstrap-lifecycle-primitive-sentinel", "bootstrap-lifecycle-primitive-sentinel"],
  ];
  for (const [index, [sentinel, bodyError]] of failures.entries()) {
    globalThis.fetch = async () =>
      ({
        ok: true,
        status: 502,
        headers: new Headers({ "x-github-request-id": `bootstrap-lifecycle-${index}` }),
        text: async () => Promise.reject(bodyError),
      }) as unknown as Response;
    const lines: string[] = [];
    const diagnostics = new DiagnosticLogger({
      component: "bootstrap",
      write: (line) => lines.push(line),
    });
    await assert.rejects(
      bootstrapRuntime({ releaseRef: "v1.1.1-rc.0", diagnostics }),
      (error: unknown) => error === bodyError,
    );
    const records = lines.map(
      (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
    );
    const terminal = records.find(
      (record) => record.operation === "runtime.bootstrap" && record.event === "operation.finished",
    );
    assert.ok(terminal);
    assert.equal(
      ((terminal.details as Record<string, unknown>).error as Record<string, unknown>).message,
      "GitHub release response body read failed.",
    );
    assert.equal(JSON.stringify(records).includes(sentinel), false);
  }
});

test("does not suppress colliding bootstrap body-read failures", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const scenarios: readonly {
    readonly operation: string;
    readonly error: Error;
    readonly invoke: (diagnostics: DiagnosticLogger) => Promise<unknown>;
    readonly response: () => Response;
  }[] = [
    {
      operation: "github.request",
      error: new Error("Runtime release lookup failed (503): release-body-sentinel"),
      invoke: (diagnostics) =>
        bootstrapInternals.fetchJson(
          "https://api.example.test/release-body",
          undefined,
          diagnostics,
        ),
      response: () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "x-github-request-id": "bootstrap-colliding-release" }),
          text: async () => Promise.reject(scenarios[0]?.error),
        }) as unknown as Response,
    },
    {
      operation: "github.asset.download",
      error: new Error("Runtime asset download failed (503): asset-body-sentinel"),
      invoke: (diagnostics) =>
        bootstrapInternals.download(
          "https://api.example.test/asset-body",
          join(tmpdir(), "bootstrap-colliding-asset"),
          undefined,
          diagnostics,
        ),
      response: () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "x-github-request-id": "bootstrap-colliding-asset" }),
          arrayBuffer: async () => Promise.reject(scenarios[1]?.error),
        }) as unknown as Response,
    },
    {
      operation: "github.asset.checksum",
      error: new Error("Runtime checksum download failed (503): checksum-body-sentinel"),
      invoke: (diagnostics) =>
        bootstrapInternals.readChecksum(
          "https://api.example.test/checksum-body",
          undefined,
          diagnostics,
        ),
      response: () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "x-github-request-id": "bootstrap-colliding-checksum" }),
          text: async () => Promise.reject(scenarios[2]?.error),
        }) as unknown as Response,
    },
  ];
  for (const scenario of scenarios) {
    globalThis.fetch = async () => scenario.response();
    const lines: string[] = [];
    const diagnostics = new DiagnosticLogger({
      component: "bootstrap",
      write: (line) => lines.push(line),
    });
    await assert.rejects(
      scenario.invoke(diagnostics),
      (error: unknown) => error === scenario.error,
    );
    const records = lines.map(
      (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
    );
    const terminal = records.find(
      (record) => record.operation === scenario.operation && record.event === "operation.finished",
    );
    assert.ok(terminal);
    assert.equal(
      ((terminal.details as Record<string, unknown>).error as Record<string, unknown>).message,
      scenario.operation === "github.request"
        ? "GitHub release response body read failed."
        : scenario.operation === "github.asset.download"
          ? "Runtime asset response body read failed."
          : "Runtime checksum response body read failed.",
    );
    assert.equal(JSON.stringify(records).includes(scenario.error.message), false);
  }
});

test("retains bootstrap response metadata when cancellation interrupts a body read", async (t) => {
  const previous = globalThis.fetch;
  const entered = new Promise<void>((resolve) => {
    globalThis.fetch = async (_input, init) => {
      resolve();
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "x-github-request-id": "bootstrap-cancelled" }),
        text: async () => {
          await new Promise<void>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener(
              "abort",
              () => {
                reject(signal.reason);
              },
              { once: true },
            );
          });
          return "";
        },
      } as unknown as Response;
    };
  });
  t.after(() => {
    globalThis.fetch = previous;
  });
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "bootstrap",
    write: (line) => lines.push(line),
  });
  const controller = new AbortController();
  const reason = new CancellationError("SIGTERM");
  const pending = bootstrapInternals.fetchJson(
    "https://api.example.test/cancelled",
    controller.signal,
    diagnostics,
  );
  await entered;
  controller.abort(reason);
  await assert.rejects(pending, (error: unknown) => error === reason);
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const terminal = records.find((record) => record.event === "operation.cancelled");
  assert.ok(terminal);
  const details = terminal.details as Record<string, unknown>;
  assert.equal(details.status, 200);
  assert.equal(details.request_id, "bootstrap-cancelled");
  assert.equal(details.required_permission, "contents:read");
});

test("redacts the bootstrap PAT in default diagnostics", async (t) => {
  const previousToken = process.env["INPUT_GITHUB-PAT"];
  process.env["INPUT_GITHUB-PAT"] = "bootstrap-secret-token";
  t.after(() => {
    if (previousToken === undefined) delete process.env["INPUT_GITHUB-PAT"];
    else process.env["INPUT_GITHUB-PAT"] = previousToken;
  });
  const output: string[] = [];
  t.mock.method(console, "log", (line: unknown) => {
    output.push(String(line));
  });
  await assert.rejects(
    bootstrapRuntime({
      releaseRef: "v1",
      getJson: async () => {
        throw new Error("bootstrap-secret-token was rejected");
      },
    }),
    /bootstrap-secret-token/u,
  );
  const rendered = output.join("\n");
  assert.equal(rendered.includes("bootstrap-secret-token"), false);
  assert.equal(rendered.includes("[REDACTED]"), true);
});

test("preserves undefined bootstrap failures and records a terminal failure", async () => {
  const lines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "bootstrap",
    write: (line) => lines.push(line),
  });
  let threw = false;
  let rejection: unknown;
  let returned: number | undefined;
  try {
    returned = await bootstrapRuntime({
      releaseRef: "v1.1.1-rc.0",
      getJson: async () => {
        throw undefined;
      },
      diagnostics,
    });
  } catch (error) {
    threw = true;
    rejection = error;
  }
  assert.equal(threw, true);
  assert.equal(rejection, undefined);
  assert.equal(returned, undefined);
  const records = lines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  const terminal = records.find(
    (record) => record.operation === "runtime.bootstrap" && record.event === "operation.finished",
  );
  assert.ok(terminal);
  assert.equal(terminal.outcome, "failure");
  assert.deepEqual((terminal.details as Record<string, unknown>).error, {
    name: "undefined",
    message: "undefined",
  });
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

test("turns the first process signal into graceful cancellation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-cancellation-signal-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cleaned = join(root, "cleaned.txt");
  const cancellationModule = new URL("../src/lib/bootstrap/cancellation.js", import.meta.url).href;
  const script = `
    import { writeFile } from "node:fs/promises";
    import { installCancellationHandlers } from ${JSON.stringify(cancellationModule)};
    const cancellation = installCancellationHandlers();
    const aborted = new Promise((resolve) => {
      const active = setInterval(() => undefined, 1_000);
      cancellation.controller.signal.addEventListener("abort", () => {
        clearInterval(active);
        resolve();
      }, { once: true });
    });
    process.stdout.write("ready\\n");
    await aborted;
    await writeFile(${JSON.stringify(cleaned)}, cancellation.controller.signal.reason.message);
    cancellation.dispose();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const [ready] = (await once(child.stdout, "data")) as [Buffer];
  assert.equal(ready.toString("utf8"), "ready\n");
  const processSignal: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGTERM";
  assert.equal(child.kill(processSignal), true);
  const [code, exitSignal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  assert.equal(code, 0);
  assert.equal(exitSignal, null);
  assert.match(await readFile(cleaned, "utf8"), new RegExp(processSignal, "u"));
});

test("normalizes cancellation reasons and disposes pre-cancelled handlers", () => {
  const active = new AbortController();
  assert.match(cancellationReason(active.signal).message, /cancelled/u);

  const primitive = new AbortController();
  primitive.abort("cancelled");
  assert.match(cancellationReason(primitive.signal).message, /cancelled/u);

  const reason = new CancellationError("SIGTERM");
  const cancelled = new AbortController();
  cancelled.abort(reason);
  const handlers = installCancellationHandlers(cancelled);
  handlers.dispose();
  handlers.dispose();
  assert.equal(cancellationReason(cancelled.signal), reason);
});

test("propagates bootstrap cancellation to the runtime child over IPC", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-cancellation-ipc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ready = join(root, "ready.txt");
  const cleaned = join(root, "cleaned.txt");
  const cancellationModule = new URL("../src/lib/bootstrap/cancellation.js", import.meta.url).href;
  await mkdir(join(root, "runtime"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
  await writeFile(
    join(root, "runtime/index.js"),
    `
      import { writeFile } from "node:fs/promises";
      import { installCancellationHandlers } from ${JSON.stringify(cancellationModule)};
      const cancellation = installCancellationHandlers();
      const aborted = new Promise((resolve) => cancellation.controller.signal.addEventListener("abort", resolve, { once: true }));
      await writeFile(${JSON.stringify(ready)}, "ready");
      await aborted;
      await writeFile(${JSON.stringify(cleaned)}, cancellation.controller.signal.reason.message);
      cancellation.dispose();
    `,
  );
  const controller = new AbortController();
  const diagnosticLines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "bootstrap",
    write: (line) => diagnosticLines.push(line),
  });
  const running = bootstrapInternals.runRuntime(root, "source", controller.signal, diagnostics);
  await waitForPath(ready);
  controller.abort(new CancellationError("SIGTERM"));

  assert.equal(await running, 0);
  assert.match(await readFile(cleaned, "utf8"), /SIGTERM/u);
  const records = diagnosticLines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  assert.equal(
    records.some(
      (record) => record.operation === "runtime.launch" && record.outcome === "cancelled",
    ),
    true,
  );
});

test("rejects release and manifest mismatches before runtime execution", async (t) => {
  const diagnosticLines: string[] = [];
  const diagnostics = new DiagnosticLogger({
    component: "bootstrap",
    write: (line) => diagnosticLines.push(line),
  });
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-bootstrap-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetName = bootstrapInternals.platformAssetName();
  const invalidRelease = (value: Record<string, unknown>) =>
    bootstrapRuntime({
      releaseRef: "v1.1.1-rc.0",
      temporaryRoot: root,
      diagnostics,
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
  const records = diagnosticLines.map(
    (line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>,
  );
  assert.equal(
    records.some(
      (record) => record.operation === "release.validate" && record.outcome === "failure",
    ),
    true,
  );
  assert.equal(
    records.some(
      (record) => record.operation === "release.asset.select" && record.outcome === "failure",
    ),
    true,
  );
});
