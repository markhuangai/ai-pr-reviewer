import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
const RELEASE_REPOSITORY = "markhuangai/ai-pr-reviewer";
const RELEASE_TAG = "runtime-v1";
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
function token() {
    const value = (process.env["INPUT_GITHUB-PAT"] ?? process.env.INPUT_GITHUB_PAT)?.trim();
    return value && value.length > 0 ? value : undefined;
}
function requestHeaders() {
    const headers = new Headers({
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    });
    const secret = token();
    if (secret)
        headers.set("Authorization", `Bearer ${secret}`);
    return headers;
}
async function fetchJson(url) {
    const response = await fetch(url, { headers: requestHeaders() });
    if (!response.ok)
        throw new Error(`Runtime release lookup failed (${response.status}).`);
    return (await response.json());
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
                if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
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
async function runRuntime(runtimeDirectory) {
    const entry = join(runtimeDirectory, "runtime", "index.js");
    const entryStats = await stat(entry).catch(() => undefined);
    if (!entryStats?.isFile())
        throw new Error("Runtime bundle is missing runtime/index.js.");
    const child = spawn(process.execPath, [entry], {
        stdio: "inherit",
        env: { ...process.env, AI_PR_REVIEWER_RUNTIME_DIR: runtimeDirectory },
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
    const override = process.env.AI_PR_REVIEWER_RUNTIME_DIR?.trim();
    if (override) {
        const code = await runRuntime(override);
        if (code !== 0)
            process.exitCode = code;
        return;
    }
    const assetName = platformAssetName();
    const release = await fetchJson(`https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/tags/${RELEASE_TAG}`);
    if (release.tag_name !== RELEASE_TAG ||
        release.draft === true ||
        release.prerelease === true ||
        !Array.isArray(release.assets)) {
        throw new Error("The runtime release is not a stable, usable release.");
    }
    const assets = release.assets.map(readAsset);
    const asset = assets.find((candidate) => candidate.name === assetName);
    if (!asset || typeof asset.browser_download_url !== "string")
        throw new Error(`Runtime release has no asset for ${assetName}.`);
    if (typeof asset.size === "number" && asset.size > MAX_ARCHIVE_BYTES)
        throw new Error("Runtime asset is larger than the safety limit.");
    const checksum = await readChecksum(`${asset.browser_download_url}.sha256`);
    const cacheRoot = join(process.env.RUNNER_TEMP ?? tmpdir(), "ai-pr-reviewer-runtime", RELEASE_TAG, assetName.replace(/[^A-Za-z0-9_.-]/g, "_"));
    const archive = join(cacheRoot, assetName);
    const bytes = await download(asset.browser_download_url, archive);
    const actualDigest = sha256(bytes);
    if (actualDigest !== expectedDigest(asset, checksum))
        throw new Error("Runtime asset SHA-256 verification failed.");
    const extracted = join(cacheRoot, "bundle");
    await extract(archive, extracted);
    const manifestPath = join(extracted, "runtime", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!isRecord(manifest) ||
        manifest.releaseTag !== RELEASE_TAG ||
        manifest.asset !== assetName ||
        manifest.nodeMajor !== 24 ||
        typeof manifest.sdkVersion !== "string" ||
        typeof manifest.cliVersion !== "string") {
        throw new Error("Runtime bundle manifest verification failed.");
    }
    const code = await runRuntime(extracted);
    if (code !== 0)
        process.exitCode = code;
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
});
