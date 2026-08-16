import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface LockPackage extends Record<string, unknown> {
  readonly version: string;
  readonly resolved: string;
}

function isLockPackage(value: unknown): value is LockPackage {
  return isRecord(value) && typeof value.version === "string" && typeof value.resolved === "string";
}

export interface PackageAgeResult {
  readonly checked: number;
  readonly failures: readonly string[];
}

export async function checkPackageAge(
  lock: unknown,
  now = Date.now(),
  registryUrl = "https://registry.npmjs.org",
): Promise<PackageAgeResult> {
  const quarantineHours = 168;
  const cutoff = now - quarantineHours * 60 * 60 * 1000;
  if (!isRecord(lock) || !isRecord(lock.packages)) {
    throw new Error("package-lock.json has no packages mapping.");
  }
  const entries: Array<readonly [string, LockPackage]> = [];
  for (const [key, value] of Object.entries(lock.packages)) {
    if (key !== "" && isLockPackage(value)) entries.push([key, value]);
  }
  const seen = new Set<string>();
  const failures: string[] = [];

  for (const [key, value] of entries) {
    const keyName = (key.split("/node_modules/").at(-1) ?? "").replace(/^node_modules\//, "");
    const name =
      typeof value.name === "string" && !value.name.startsWith("node_modules/")
        ? value.name
        : keyName;
    const version = value.version;
    if (typeof value.integrity !== "string" || value.integrity.length === 0) {
      failures.push(`${name}@${version}: lockfile entry has no integrity hash`);
      continue;
    }
    const id = `${name}@${version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const encoded = name.startsWith("@") ? name.replaceAll("/", "%2F") : name;
    const response = await fetch(`${registryUrl.replace(/\/$/u, "")}/${encoded}`);
    if (!response.ok)
      throw new Error(`Could not read npm metadata for ${id} (${response.status}).`);
    const metadata: unknown = await response.json();
    const published =
      isRecord(metadata) && isRecord(metadata.time) ? metadata.time[version] : undefined;
    if (typeof published !== "string") {
      failures.push(`${id}: registry did not provide a publish timestamp`);
      continue;
    }
    const publishedAt = Date.parse(published);
    if (!Number.isFinite(publishedAt) || publishedAt > cutoff)
      failures.push(`${id}: published ${published}`);
  }

  return { checked: seen.size, failures };
}

export async function checkPackageAgeFile(
  lockPath = "package-lock.json",
  now = Date.now(),
  registryUrl = "https://registry.npmjs.org",
): Promise<PackageAgeResult> {
  const lock: unknown = JSON.parse(await readFile(lockPath, "utf8")) as unknown;
  return checkPackageAge(lock, now, registryUrl);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const result = await checkPackageAgeFile();
  console.log(`Checked ${result.checked} locked npm packages against a 168-hour quarantine.`);
  if (result.failures.length > 0) {
    console.error(result.failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("No locked package is inside the quarantine window.");
  }
}
