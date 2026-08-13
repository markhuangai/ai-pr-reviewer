import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isSafeArchiveEntryPath, isSafeArchiveSymlink } from "./lib/bootstrap/archive.js";
import { aliasAcceptsRelease, isCompatibleRuntimeManifest, parseActionReleaseReference, parseActionReleaseTag, } from "./lib/bootstrap/version.js";
const RELEASE_REPOSITORY = "markhuangai/ai-pr-reviewer";
const MAX_ARCHIVE_BYTES = 600 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function platformAssetName() {
    const platform = process.platform;
    const arch = process.arch;
    const supported = (platform === "linux" && (arch === "x64" || arch === "arm64")) ||
        (platform === "win32" && (arch === "x64" || arch === "arm64")) ||
        (platform === "darwin" && (arch === "x64" || arch === "arm64"));
    if (!supported)
        throw new Error(`Unsupported runner platform: ${platform}/${arch}.`);
    return `runtime-${platform}-${arch}.tar.gz`;
}
function requestHeaders() {
    return new Headers({
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    });
}
function apiRequestHeaders() {
    const headers = requestHeaders();
    const token = process.env["INPUT_GITHUB-PAT"]?.trim();
    if (token)
        headers.set("Authorization", `Bearer ${token}`);
    return headers;
}
async function fetchJson(url) {
    const response = await fetch(url, { headers: apiRequestHeaders() });
    if (!response.ok)
        throw new Error(`Runtime release lookup failed (${response.status}).`);
    return (await response.json());
}
function gitObject(value, expectedType) {
    if (!isRecord(value) || !isRecord(value.object))
        return undefined;
    const sha = value.object.sha;
    return value.object.type === expectedType &&
        typeof sha === "string" &&
        /^[a-f0-9]{40}$/iu.test(sha)
        ? sha
        : undefined;
}
async function resolveAlias(alias, getJson) {
    const ref = await getJson(`https://api.github.com/repos/${RELEASE_REPOSITORY}/git/ref/tags/${encodeURIComponent(alias.tag)}`);
    const tagObjectSha = gitObject(ref, "tag");
    if (!tagObjectSha)
        throw new Error("The action release alias is not an annotated Git tag.");
    const tagObject = await getJson(`https://api.github.com/repos/${RELEASE_REPOSITORY}/git/tags/${tagObjectSha}`);
    if (!isRecord(tagObject) ||
        tagObject.tag !== alias.tag ||
        typeof tagObject.message !== "string") {
        throw new Error("The action release alias contains invalid metadata.");
    }
    const release = parseActionReleaseTag(tagObject.message.trim());
    const commitSha = gitObject(tagObject, "commit");
    if (!release || !commitSha || !aliasAcceptsRelease(alias, release)) {
        throw new Error("The action release alias targets an incompatible exact version.");
    }
    const exactRef = await getJson(`https://api.github.com/repos/${RELEASE_REPOSITORY}/git/ref/tags/${encodeURIComponent(release.tag)}`);
    if (gitObject(exactRef, "commit") !== commitSha) {
        throw new Error("The action release alias and exact version resolve to different commits.");
    }
    return release;
}
export async function resolveActionRelease(value, getJson = fetchJson) {
    const reference = parseActionReleaseReference(value);
    if (!reference) {
        throw new Error("This action must be referenced by vN, vN-prerelease, or an exact tag such as v1.0.0 or v1.0.0-rc.0.");
    }
    return "stableTag" in reference ? reference : resolveAlias(reference, getJson);
}
function readAsset(value) {
    if (!isRecord(value) ||
        typeof value.name !== "string" ||
        typeof value.browser_download_url !== "string") {
        throw new Error("Runtime release contained an invalid asset record.");
    }
    return {
        name: value.name,
        browser_download_url: value.browser_download_url,
        ...(typeof value.digest === "string" ? { digest: value.digest } : {}),
        ...(typeof value.size === "number" ? { size: value.size } : {}),
    };
}
function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}
async function download(url, destination) {
    const response = await fetch(url, { headers: requestHeaders() });
    if (!response.ok)
        throw new Error(`Runtime asset download failed (${response.status}).`);
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (contentLength > MAX_ARCHIVE_BYTES)
        throw new Error("Runtime asset is larger than the safety limit.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_ARCHIVE_BYTES)
        throw new Error("Runtime asset is larger than the safety limit.");
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    return bytes;
}
function expectedDigest(asset, checksumText) {
    if (typeof asset.digest === "string" && /^sha256:[a-f0-9]{64}$/i.test(asset.digest))
        return asset.digest.slice("sha256:".length).toLowerCase();
    const match = checksumText?.match(/\b([a-f0-9]{64})\b/i);
    if (!match?.[1])
        throw new Error("Runtime release asset has no verifiable SHA-256 digest.");
    return match[1].toLowerCase();
}
async function readChecksum(url) {
    const response = await fetch(url, { headers: requestHeaders() });
    if (response.status === 404)
        return undefined;
    if (!response.ok)
        throw new Error(`Runtime checksum download failed (${response.status}).`);
    return response.text();
}
async function extract(archive, destination) {
    await mkdir(destination, { recursive: true });
    await new Promise((resolve, reject) => {
        const child = spawn("tar", ["-tvzf", archive], {
            stdio: ["ignore", "pipe", "ignore"],
            windowsHide: true,
        });
        let listing = "";
        child.stdout.on("data", (chunk) => {
            listing += chunk.toString("utf8");
            if (listing.length > 1_000_000)
                child.kill();
        });
        child.once("error", reject);
        child.once("exit", (code) => {
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
                const dateIndex = fields.findIndex((field) => /^\d{4}-\d{2}-\d{2}$/.test(field) ||
                    /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/.test(field));
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
                if (!isSafeArchiveEntryPath(entryPath) ||
                    (linkTarget !== undefined && !isSafeArchiveSymlink(entryPath, linkTarget))) {
                    reject(new Error("Runtime archive contains an unsafe path."));
                    return;
                }
            }
            resolve();
        });
    });
    await new Promise((resolve, reject) => {
        const child = spawn("tar", ["-xzf", archive, "--no-same-owner", "--no-same-permissions", "-C", destination], {
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString("utf8").slice(0, 2_000);
        });
        child.once("error", reject);
        child.once("exit", (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`Runtime archive extraction failed (${code ?? "unknown"}): ${stderr.trim()}`));
        });
    });
}
async function runRuntime(runtimeDirectory, buildId = process.env.AI_PR_REVIEWER_BUILD_ID ?? "source") {
    const entry = join(runtimeDirectory, "runtime", "index.js");
    const entryStats = await stat(entry).catch(() => undefined);
    if (!entryStats?.isFile())
        throw new Error("Runtime bundle is missing runtime/index.js.");
    const child = spawn(process.execPath, [entry], {
        stdio: "inherit",
        env: {
            ...process.env,
            AI_PR_REVIEWER_BUILD_ID: buildId,
        },
        windowsHide: false,
    });
    return new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            resolve(code ?? (signal ? 1 : 0));
        });
    });
}
async function main() {
    const releaseRef = process.env.GITHUB_ACTION_REF;
    const requestedRelease = await resolveActionRelease(releaseRef);
    const assetName = platformAssetName();
    const release = await fetchJson(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/tags/${encodeURIComponent(requestedRelease.tag)}`);
    if (release.tag_name !== requestedRelease.tag ||
        release.draft !== false ||
        release.prerelease !== requestedRelease.prerelease ||
        !Array.isArray(release.assets)) {
        throw new Error("The runtime release does not match the requested action version.");
    }
    const assets = release.assets.map(readAsset);
    const asset = assets.find((candidate) => candidate.name === assetName);
    if (!asset || typeof asset.browser_download_url !== "string")
        throw new Error(`Runtime release has no asset for ${assetName}.`);
    if (typeof asset.size === "number" && asset.size > MAX_ARCHIVE_BYTES)
        throw new Error("Runtime asset is larger than the safety limit.");
    const checksum = await readChecksum(`${asset.browser_download_url}.sha256`);
    const cacheRoot = join(process.env.RUNNER_TEMP ?? tmpdir(), "ai-pr-reviewer-runtime", requestedRelease.tag, assetName.replace(/[^A-Za-z0-9_.-]/g, "_"));
    const archive = join(cacheRoot, assetName);
    const bytes = await download(asset.browser_download_url, archive);
    const actualDigest = sha256(bytes);
    if (actualDigest !== expectedDigest(asset, checksum))
        throw new Error("Runtime asset SHA-256 verification failed.");
    const extracted = await mkdtemp(join(cacheRoot, `bundle-${actualDigest}-`));
    try {
        await extract(archive, extracted);
        const manifestPath = join(extracted, "runtime", "manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (!isRecord(manifest) ||
            !isCompatibleRuntimeManifest(requestedRelease, manifest.artifactTag, manifest.stableTag) ||
            manifest.asset !== assetName ||
            manifest.nodeMajor !== 24 ||
            typeof manifest.sdkVersion !== "string" ||
            typeof manifest.cliVersion !== "string" ||
            typeof manifest.sourceCommit !== "string" ||
            manifest.sourceCommit.length === 0) {
            throw new Error("Runtime bundle manifest verification failed.");
        }
        const sourceCommit = manifest.sourceCommit;
        const code = await runRuntime(extracted, sourceCommit);
        if (code !== 0)
            process.exitCode = code;
    }
    finally {
        await rm(extracted, { recursive: true, force: true });
    }
}
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
