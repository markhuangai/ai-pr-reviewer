import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { isSafeArchiveEntryPath, isSafeArchiveSymlink } from "./lib/bootstrap/archive.js";
import {
  cancellationReason,
  cancellationInternals,
  installCancellationHandlers,
  throwIfAborted,
} from "./lib/bootstrap/cancellation.js";
import {
  aliasAcceptsRelease,
  isCompatibleRuntimeManifest,
  parseActionReleaseReference,
  parseActionReleaseTag,
  type ActionReleaseAlias,
  type ActionReleaseReference,
  type ActionReleaseVersion,
} from "./lib/bootstrap/version.js";
import { DiagnosticLogger, type DiagnosticDescriptor } from "./lib/diagnostics.js";

const RELEASE_REPOSITORY = "markhuangai/ai-pr-reviewer";
const MAX_ARCHIVE_BYTES = 600 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const BOOTSTRAP_GITHUB_PERMISSION = "contents:read";

interface ReleaseAsset {
  readonly name?: unknown;
  readonly browser_download_url?: unknown;
  readonly digest?: unknown;
  readonly size?: unknown;
}

interface ReleasePayload {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly assets?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withDiagnosticMessage(error: unknown, message: string): unknown {
  if (error instanceof Error) {
    try {
      Object.defineProperty(error, "diagnosticMessage", {
        configurable: true,
        enumerable: false,
        value: message,
        writable: true,
      });
    } catch {
      // Preserve the original parser error when its properties cannot be changed.
    }
  }
  return error;
}

function parseJson(text: string, diagnosticMessage: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw withDiagnosticMessage(error, diagnosticMessage);
  }
}

function platformAssetName(): string {
  const platform = process.platform;
  const arch = process.arch;
  const supported =
    (platform === "linux" && (arch === "x64" || arch === "arm64")) ||
    (platform === "win32" && (arch === "x64" || arch === "arm64")) ||
    (platform === "darwin" && (arch === "x64" || arch === "arm64"));
  if (!supported) throw new Error(`Unsupported runner platform: ${platform}/${arch}.`);
  return `runtime-${platform}-${arch}.tar.gz`;
}

function requestHeaders(): Headers {
  return new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  });
}

function apiRequestHeaders(): Headers {
  const headers = requestHeaders();
  const token = process.env["INPUT_GITHUB-PAT"]?.trim();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function bootstrapDescriptor(operation: string, purpose: string): DiagnosticDescriptor {
  return { component: "bootstrap", phase: "bootstrap", operation, purpose };
}

function bootstrapRequestDetails(url: string): Readonly<Record<string, unknown>> {
  return { method: "GET", url, required_permission: BOOTSTRAP_GITHUB_PERMISSION };
}

function responseStatusText(response: Response): string | undefined {
  const value = (response as Response & { readonly statusText?: unknown }).statusText;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function bootstrapResponseDetails(
  response: Response,
  responseBytes?: number,
): Readonly<Record<string, unknown>> {
  const requestId = response.headers.get("x-github-request-id");
  const statusText = responseStatusText(response);
  return {
    status: response.status,
    ...(statusText === undefined ? {} : { status_text: statusText }),
    ...(responseBytes === undefined ? {} : { response_bytes: responseBytes }),
    ...(requestId === null ? {} : { request_id: requestId }),
    required_permission: BOOTSTRAP_GITHUB_PERMISSION,
    response_headers: Object.fromEntries(response.headers.entries()),
  };
}

type DiagnosticJsonFetcher = <T>(
  url: string,
  signal?: AbortSignal,
  diagnostics?: DiagnosticLogger,
  descriptor?: DiagnosticDescriptor,
) => Promise<T>;

async function fetchJson<T>(
  url: string,
  signal?: AbortSignal,
  diagnostics = new DiagnosticLogger({ component: "bootstrap" }),
  descriptor = bootstrapDescriptor("github.request", "read GitHub release metadata"),
): Promise<T> {
  const span = diagnostics.start(descriptor, bootstrapRequestDetails(url));
  let responseMetadata: Readonly<Record<string, unknown>> | undefined;
  let bodyReadAttempted = false;
  let bodyRead = false;
  try {
    throwIfAborted(signal);
    const response = await fetch(url, {
      headers: apiRequestHeaders(),
      ...(signal === undefined ? {} : { signal }),
    });
    responseMetadata = bootstrapResponseDetails(response);
    if (!response.ok) {
      const error = new Error(`Runtime release lookup failed (${response.status}).`);
      span.failure(error, {
        ...responseMetadata,
        content_length: response.headers.get("content-length") ?? undefined,
      });
      throw error;
    }
    bodyReadAttempted = true;
    const text = await response.text();
    bodyRead = true;
    let payload: T;
    try {
      payload = parseJson(text, "GitHub release metadata JSON parsing failed.") as T;
    } catch (error) {
      span.failure(error, {
        ...responseMetadata,
        response_bytes: Buffer.byteLength(text),
      });
      throw error;
    }
    span.success({ ...responseMetadata, response_bytes: Buffer.byteLength(text) });
    return payload;
  } catch (error) {
    const bodyReadFailure = responseMetadata !== undefined && bodyReadAttempted && !bodyRead;
    if (bodyReadFailure)
      diagnostics.registerSafeDiagnosticError(error, "GitHub release response body read failed.");
    const diagnosticError = bodyReadFailure
      ? new Error("GitHub release response body read failed.")
      : error;
    if (signal?.aborted) span.cancelled(diagnosticError, responseMetadata);
    else {
      span.failure(diagnosticError, responseMetadata);
    }
    throw error;
  }
}

type JsonFetcher = DiagnosticJsonFetcher;

async function getJsonWithDiagnostics<T>(
  getJson: JsonFetcher,
  url: string,
  signal: AbortSignal | undefined,
  diagnostics: DiagnosticLogger | undefined,
  descriptor: DiagnosticDescriptor,
): Promise<T> {
  if (diagnostics === undefined) return getJson<T>(url, signal);
  if (getJson === fetchJson) return getJson<T>(url, signal, diagnostics, descriptor);
  return diagnostics.withSpan(
    descriptor,
    () => getJson<T>(url, signal, diagnostics, descriptor),
    bootstrapRequestDetails(url),
  );
}

function gitObject(value: unknown, expectedType: "commit" | "tag"): string | undefined {
  if (!isRecord(value) || !isRecord(value.object)) return undefined;
  const sha = value.object.sha;
  return value.object.type === expectedType &&
    typeof sha === "string" &&
    /^[a-f0-9]{40}$/iu.test(sha)
    ? sha
    : undefined;
}

async function resolveAlias(
  alias: ActionReleaseAlias,
  getJson: JsonFetcher,
  signal?: AbortSignal,
  diagnostics?: DiagnosticLogger,
): Promise<ActionReleaseVersion> {
  const ref = await getJsonWithDiagnostics<unknown>(
    getJson,
    `https://api.github.com/repos/${RELEASE_REPOSITORY}/git/ref/tags/${encodeURIComponent(alias.tag)}`,
    signal,
    diagnostics,
    bootstrapDescriptor("github.release.alias-ref", "resolve the requested runtime release alias"),
  );
  const tagObjectSha = gitObject(ref, "tag");
  if (!tagObjectSha) throw new Error("The action release alias is not an annotated Git tag.");
  const tagObject = await getJsonWithDiagnostics<unknown>(
    getJson,
    `https://api.github.com/repos/${RELEASE_REPOSITORY}/git/tags/${tagObjectSha}`,
    signal,
    diagnostics,
    bootstrapDescriptor("github.release.alias-tag", "read the annotated runtime release alias"),
  );
  if (
    !isRecord(tagObject) ||
    tagObject.tag !== alias.tag ||
    typeof tagObject.message !== "string"
  ) {
    throw new Error("The action release alias contains invalid metadata.");
  }
  const release = parseActionReleaseTag(tagObject.message.trim());
  const commitSha = gitObject(tagObject, "commit");
  if (!release || !commitSha || !aliasAcceptsRelease(alias, release)) {
    throw new Error("The action release alias targets an incompatible exact version.");
  }
  const exactRef = await getJsonWithDiagnostics<unknown>(
    getJson,
    `https://api.github.com/repos/${RELEASE_REPOSITORY}/git/ref/tags/${encodeURIComponent(release.tag)}`,
    signal,
    diagnostics,
    bootstrapDescriptor("github.release.exact-ref", "verify the exact runtime release commit"),
  );
  if (gitObject(exactRef, "commit") !== commitSha) {
    throw new Error("The action release alias and exact version resolve to different commits.");
  }
  return release;
}

export async function resolveActionRelease(
  value: string | undefined,
  getJson: JsonFetcher = fetchJson,
  signal?: AbortSignal,
  diagnostics?: DiagnosticLogger,
): Promise<ActionReleaseVersion> {
  throwIfAborted(signal);
  const reference: ActionReleaseReference | undefined = parseActionReleaseReference(value);
  if (!reference) {
    throw new Error(
      "This action must be referenced by vN, vN-prerelease, or an exact tag such as v1.0.0 or v1.0.0-rc.0.",
    );
  }
  return "stableTag" in reference
    ? reference
    : resolveAlias(reference, getJson, signal, diagnostics);
}

function readAsset(value: unknown): ReleaseAsset {
  if (
    !isRecord(value) ||
    typeof value.name !== "string" ||
    typeof value.browser_download_url !== "string"
  ) {
    throw new Error("Runtime release contained an invalid asset record.");
  }
  return {
    name: value.name,
    browser_download_url: value.browser_download_url,
    ...(typeof value.digest === "string" ? { digest: value.digest } : {}),
    ...(typeof value.size === "number" ? { size: value.size } : {}),
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function download(
  url: string,
  destination: string,
  signal?: AbortSignal,
  diagnostics = new DiagnosticLogger({ component: "bootstrap" }),
): Promise<Uint8Array> {
  const span = diagnostics.start(
    bootstrapDescriptor("github.asset.download", "download the verified runtime archive"),
    { ...bootstrapRequestDetails(url), destination },
  );
  let responseMetadata: Readonly<Record<string, unknown>> | undefined;
  let bodyReadAttempted = false;
  let bodyRead = false;
  try {
    throwIfAborted(signal);
    const response = await fetch(url, {
      headers: requestHeaders(),
      ...(signal === undefined ? {} : { signal }),
    });
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    const responseHeaders = Object.fromEntries(response.headers.entries());
    responseMetadata = {
      ...bootstrapResponseDetails(response),
      content_length: Number.isFinite(contentLength) ? contentLength : undefined,
    };
    if (!response.ok) {
      const error = new Error(`Runtime asset download failed (${response.status}).`);
      span.failure(error, {
        ...responseMetadata,
      });
      throw error;
    }
    if (contentLength > MAX_ARCHIVE_BYTES) {
      const error = new Error("Runtime asset is larger than the safety limit.");
      span.failure(error, {
        ...responseMetadata,
      });
      throw error;
    }
    bodyReadAttempted = true;
    const bytes = new Uint8Array(await response.arrayBuffer());
    bodyRead = true;
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
      const error = new Error("Runtime asset is larger than the safety limit.");
      span.failure(error, {
        ...responseMetadata,
        response_bytes: bytes.byteLength,
      });
      throw error;
    }
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { signal });
    span.success({
      ...responseMetadata,
      response_bytes: bytes.byteLength,
      response_headers: responseHeaders,
    });
    return bytes;
  } catch (error) {
    const bodyReadFailure = responseMetadata !== undefined && bodyReadAttempted && !bodyRead;
    if (bodyReadFailure)
      diagnostics.registerSafeDiagnosticError(error, "Runtime asset response body read failed.");
    const diagnosticError = bodyReadFailure
      ? new Error("Runtime asset response body read failed.")
      : error;
    if (signal?.aborted) span.cancelled(diagnosticError, responseMetadata);
    else {
      span.failure(diagnosticError, responseMetadata);
    }
    throw error;
  }
}

function expectedDigest(asset: ReleaseAsset, checksumText: string | undefined): string {
  if (typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/i.test(asset.digest))
    return asset.digest.slice("sha256:".length).toLowerCase();
  const match = checksumText?.match(/\b([a-f0-9]{64})\b/i);
  if (!match?.[1]) throw new Error("Runtime release asset has no verifiable SHA-256 digest.");
  return match[1].toLowerCase();
}

async function readChecksum(
  url: string,
  signal?: AbortSignal,
  diagnostics = new DiagnosticLogger({ component: "bootstrap" }),
): Promise<string | undefined> {
  const span = diagnostics.start(
    bootstrapDescriptor("github.asset.checksum", "read the optional runtime archive checksum"),
    bootstrapRequestDetails(url),
  );
  let responseMetadata: Readonly<Record<string, unknown>> | undefined;
  let bodyReadAttempted = false;
  let bodyRead = false;
  try {
    throwIfAborted(signal);
    const response = await fetch(url, {
      headers: requestHeaders(),
      ...(signal === undefined ? {} : { signal }),
    });
    responseMetadata = bootstrapResponseDetails(response);
    if (response.status === 404) {
      span.skipped({
        ...responseMetadata,
        reason: "optional checksum is absent",
        content_length: response.headers.get("content-length") ?? undefined,
      });
      return undefined;
    }
    if (!response.ok) {
      const error = new Error(`Runtime checksum download failed (${response.status}).`);
      span.failure(error, {
        ...responseMetadata,
        content_length: response.headers.get("content-length") ?? undefined,
      });
      throw error;
    }
    bodyReadAttempted = true;
    const text = await response.text();
    bodyRead = true;
    const responseHeaders = Object.fromEntries(response.headers.entries());
    span.success({
      ...responseMetadata,
      response_bytes: Buffer.byteLength(text),
      response_headers: responseHeaders,
    });
    return text;
  } catch (error) {
    const bodyReadFailure = responseMetadata !== undefined && bodyReadAttempted && !bodyRead;
    if (bodyReadFailure)
      diagnostics.registerSafeDiagnosticError(error, "Runtime checksum response body read failed.");
    const diagnosticError = bodyReadFailure
      ? new Error("Runtime checksum response body read failed.")
      : error;
    if (signal?.aborted) span.cancelled(diagnosticError, responseMetadata);
    else {
      span.failure(diagnosticError, responseMetadata);
    }
    throw error;
  }
}

async function extract(archive: string, destination: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await mkdir(destination, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-tvzf", archive], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      signal,
    });
    let listing = "";
    child.stdout.on("data", (chunk: Buffer) => {
      listing += chunk.toString("utf8");
      if (listing.length > 1_000_000) child.kill();
    });
    child.once("error", (error) => {
      if (signal?.aborted) {
        reject(cancellationReason(signal));
        return;
      }
      reject(error);
    });
    child.once("exit", (code) => {
      if (signal?.aborted) {
        reject(cancellationReason(signal));
        return;
      }
      if (code !== 0) {
        reject(new Error("Runtime archive listing failed."));
        return;
      }
      let extractedBytes = 0;
      const entries = listing.split(/\r?\n/).filter((item) => item.length > 0);
      if (entries.length > MAX_ARCHIVE_ENTRIES) {
        reject(new Error("Runtime archive contains too many entries."));
        return;
      }
      for (const entry of entries) {
        const fields = entry.trim().split(/\s+/);
        const dateIndex = fields.findIndex(
          (field) =>
            /^\d{4}-\d{2}-\d{2}$/.test(field) ||
            /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(field),
        );
        if (dateIndex < 1) {
          reject(new Error("Runtime archive contains invalid listing metadata."));
          return;
        }
        const size = Number(fields[dateIndex - 1]);
        if (!Number.isSafeInteger(size) || size < 0 || size > MAX_EXTRACTED_BYTES) {
          reject(new Error("Runtime archive contains an oversized entry."));
          return;
        }
        extractedBytes += size;
        if (extractedBytes > MAX_EXTRACTED_BYTES) {
          reject(new Error("Runtime archive exceeds the extracted-size safety limit."));
          return;
        }
        const dateField = fields[dateIndex] ?? "";
        const pathIndex = dateIndex + (/^\d{4}-\d{2}-\d{2}$/.test(dateField) ? 2 : 3);
        const normalized = fields.slice(pathIndex).join(" ").replaceAll("\\", "/");
        const linkSeparator = normalized.indexOf(" -> ");
        const entryPath = linkSeparator < 0 ? normalized : normalized.slice(0, linkSeparator);
        const linkTarget = linkSeparator < 0 ? undefined : normalized.slice(linkSeparator + 4);
        if (
          !isSafeArchiveEntryPath(entryPath) ||
          (linkTarget !== undefined && !isSafeArchiveSymlink(entryPath, linkTarget))
        ) {
          reject(new Error("Runtime archive contains an unsafe path."));
          return;
        }
      }
      resolve();
    });
  });
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "tar",
      ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", destination],
      {
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
        signal,
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8").slice(0, 2_000);
    });
    child.once("error", (error) => {
      if (signal?.aborted) {
        reject(cancellationReason(signal));
        return;
      }
      reject(error);
    });
    child.once("exit", (code) => {
      if (signal?.aborted) {
        reject(cancellationReason(signal));
        return;
      }
      if (code === 0) resolve();
      else
        reject(
          new Error(`Runtime archive extraction failed (${code ?? "unknown"}): ${stderr.trim()}`),
        );
    });
  });
}

async function runRuntime(
  runtimeDirectory: string,
  buildId = process.env.AI_PR_REVIEWER_BUILD_ID ?? "source",
  signal?: AbortSignal,
  diagnostics = new DiagnosticLogger({ component: "bootstrap" }),
): Promise<number> {
  const span = diagnostics.start(
    bootstrapDescriptor("runtime.launch", "launch the verified runtime bundle"),
    { build_id: buildId },
  );
  try {
    throwIfAborted(signal);
    const entry = join(runtimeDirectory, "runtime", "index.js");
    const entryStats = await stat(entry).catch(() => undefined);
    if (!entryStats?.isFile()) throw new Error("Runtime bundle is missing runtime/index.js.");
    const child = spawn(process.execPath, [entry], {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        AI_PR_REVIEWER_BUILD_ID: buildId,
      },
      windowsHide: false,
    });
    const code = await new Promise<number>((resolve, reject) => {
      const cancelRuntime = (): void => {
        if (!child.connected) return;
        child.send(cancellationInternals.cancellationMessage(signal?.reason), () => undefined);
      };
      const cleanup = (): void => {
        signal?.removeEventListener("abort", cancelRuntime);
      };
      signal?.addEventListener("abort", cancelRuntime, { once: true });
      if (signal?.aborted) cancelRuntime();
      child.once("error", (error) => {
        cleanup();
        if (signal?.aborted) {
          reject(cancellationReason(signal));
          return;
        }
        reject(error);
      });
      child.once("exit", (exitCode, childSignal) => {
        cleanup();
        resolve(exitCode ?? (childSignal ? 1 : 0));
      });
    });
    if (signal?.aborted) span.cancelled(cancellationReason(signal), { exit_code: code });
    else if (code === 0) span.success({ exit_code: code });
    else span.failure(new Error(`Runtime exited with code ${code}.`), { exit_code: code });
    return code;
  } catch (error) {
    if (signal?.aborted) span.cancelled(error);
    else span.failure(error);
    throw error;
  }
}

export interface BootstrapRuntimeOptions {
  readonly releaseRef?: string;
  readonly temporaryRoot?: string;
  readonly getJson?: JsonFetcher;
  readonly signal?: AbortSignal;
  readonly diagnostics?: DiagnosticLogger;
}

export async function bootstrapRuntime(options: BootstrapRuntimeOptions = {}): Promise<number> {
  const { signal } = options;
  const bootstrapToken = process.env["INPUT_GITHUB-PAT"]?.trim();
  const diagnostics =
    options.diagnostics ??
    new DiagnosticLogger({
      component: "bootstrap",
      context: {
        action_ref: process.env.GITHUB_ACTION_REF ?? "unknown",
        build_id: process.env.AI_PR_REVIEWER_BUILD_ID ?? "source",
      },
    });
  if (bootstrapToken !== undefined && bootstrapToken.length > 0)
    diagnostics.addSecrets([bootstrapToken]);
  const runSpan = diagnostics.start(
    bootstrapDescriptor("runtime.bootstrap", "bootstrap and execute the verified runtime"),
  );
  const releaseRef = options.releaseRef ?? process.env.GITHUB_ACTION_REF;
  const getJson = options.getJson ?? fetchJson;
  let extracted: string | undefined;
  let primaryError: unknown;
  let failed = false;
  let runtimeCode: number | undefined;
  try {
    throwIfAborted(signal);
    const requestedRelease = await diagnostics.withSpan(
      bootstrapDescriptor("release.resolve", "resolve the requested action release"),
      () => resolveActionRelease(releaseRef, getJson, signal, diagnostics),
      { release_ref: releaseRef ?? "unset" },
    );
    const assetName = platformAssetName();
    const release = await getJsonWithDiagnostics<ReleasePayload>(
      getJson,
      `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/tags/${encodeURIComponent(requestedRelease.tag)}`,
      signal,
      diagnostics,
      bootstrapDescriptor("github.release.metadata", "read the exact runtime release metadata"),
    );
    const assets = await diagnostics.withSpan(
      bootstrapDescriptor("release.validate", "validate the requested runtime release metadata"),
      () => {
        const releaseAssets = release.assets;
        if (
          release.tag_name !== requestedRelease.tag ||
          release.draft !== false ||
          release.prerelease !== requestedRelease.prerelease ||
          !Array.isArray(releaseAssets)
        ) {
          throw new Error("The runtime release does not match the requested action version.");
        }
        return releaseAssets.map(readAsset);
      },
      { release_tag: requestedRelease.tag, asset: assetName },
    );
    const asset = await diagnostics.withSpan(
      bootstrapDescriptor("release.asset.select", "select and validate the platform runtime asset"),
      () => {
        const candidate = assets.find((item) => item.name === assetName);
        if (!candidate || typeof candidate.browser_download_url !== "string")
          throw new Error(`Runtime release has no asset for ${assetName}.`);
        if (typeof candidate.size === "number" && candidate.size > MAX_ARCHIVE_BYTES)
          throw new Error("Runtime asset is larger than the safety limit.");
        return candidate as ReleaseAsset & { readonly browser_download_url: string };
      },
      { asset: assetName },
    );
    const checksum = await readChecksum(
      `${asset.browser_download_url}.sha256`,
      signal,
      diagnostics,
    );
    const cacheRoot = join(
      options.temporaryRoot ?? process.env.RUNNER_TEMP ?? tmpdir(),
      "ai-pr-reviewer-runtime",
      requestedRelease.tag,
      assetName.replace(/[^A-Za-z0-9_.-]/g, "_"),
    );
    const archive = join(cacheRoot, assetName);
    const bytes = await download(asset.browser_download_url, archive, signal, diagnostics);
    const actualDigest = sha256(bytes);
    await diagnostics.withSpan(
      bootstrapDescriptor("archive.verify", "verify the downloaded runtime archive checksum"),
      () => {
        const expected = expectedDigest(asset, checksum);
        if (actualDigest !== expected)
          throw new Error("Runtime asset SHA-256 verification failed.");
      },
      { asset: assetName, actual_digest: actualDigest },
    );
    extracted = await mkdtemp(join(cacheRoot, `bundle-${actualDigest}-`));
    const extractedDirectory = extracted;
    await diagnostics.withSpan(
      bootstrapDescriptor("archive.extract", "extract and validate the runtime archive"),
      () => extract(archive, extractedDirectory, signal),
      { asset: assetName, archive_bytes: bytes.byteLength },
    );
    const manifestPath = join(extractedDirectory, "runtime", "manifest.json");
    const manifest = await diagnostics.withSpan(
      bootstrapDescriptor("manifest.verify", "verify the runtime bundle manifest"),
      async () =>
        parseJson(
          await readFile(manifestPath, { encoding: "utf8", signal }),
          "Runtime bundle manifest JSON parsing failed.",
        ),
    );
    await diagnostics.withSpan(
      bootstrapDescriptor("manifest.validate", "validate runtime bundle compatibility metadata"),
      () => {
        if (
          !isRecord(manifest) ||
          !isCompatibleRuntimeManifest(
            requestedRelease,
            manifest.artifactTag,
            manifest.stableTag,
          ) ||
          manifest.asset !== assetName ||
          manifest.nodeMajor !== 24 ||
          typeof manifest.sdkVersion !== "string" ||
          typeof manifest.cliVersion !== "string" ||
          typeof manifest.sourceCommit !== "string" ||
          manifest.sourceCommit.length === 0
        ) {
          throw new Error("Runtime bundle manifest verification failed.");
        }
      },
      { release_tag: requestedRelease.tag, asset: assetName },
    );
    if (!isRecord(manifest) || typeof manifest.sourceCommit !== "string") {
      throw new Error("Runtime bundle manifest verification failed.");
    }
    const sourceCommit = manifest.sourceCommit;
    runtimeCode = await runRuntime(extracted, sourceCommit, signal, diagnostics);
    throwIfAborted(signal);
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  if (extracted !== undefined) {
    const cleanupSpan = diagnostics.start(
      bootstrapDescriptor("runtime.cleanup", "remove the temporary runtime bundle"),
    );
    try {
      await rm(extracted, { recursive: true, force: true });
      cleanupSpan.success();
    } catch (error) {
      cleanupSpan.failure(error);
      failed = true;
      primaryError = error;
    }
  }
  if (failed) {
    if (signal?.aborted) runSpan.cancelled(primaryError);
    else runSpan.failure(primaryError);
    throw primaryError;
  }
  if (runtimeCode !== undefined && runtimeCode !== 0) {
    runSpan.failure(new Error(`Runtime exited with code ${runtimeCode}.`), {
      exit_code: runtimeCode,
    });
    return runtimeCode;
  }
  runSpan.success({ exit_code: runtimeCode ?? 0 });
  return runtimeCode ?? 0;
}

async function main(): Promise<void> {
  const cancellation = installCancellationHandlers();
  try {
    const code = await bootstrapRuntime({ signal: cancellation.controller.signal });
    if (code !== 0) process.exitCode = code;
  } catch (error) {
    if (!cancellation.controller.signal.aborted) throw error;
    console.log("Pull request review cancelled; cleanup completed.");
  } finally {
    cancellation.dispose();
  }
}

export const bootstrapInternals = {
  apiRequestHeaders,
  download,
  expectedDigest,
  extract,
  fetchJson,
  gitObject,
  platformAssetName,
  readAsset,
  readChecksum,
  requestHeaders,
  runRuntime,
  sha256,
};

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
