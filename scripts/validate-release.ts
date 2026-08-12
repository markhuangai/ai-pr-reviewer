import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export interface ReleaseRecord {
  readonly id?: unknown;
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly published_at?: unknown;
}

export interface TagRecord {
  readonly ref?: unknown;
}

interface Version {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly rc?: number;
}

interface ReleaseState {
  readonly stable?: Version;
  readonly active?: Version;
}

interface PublishedRelease extends ReleaseRecord {
  readonly tag_name: string;
  readonly published_at: string;
}

export interface ValidationResult {
  readonly release_tag: string;
  readonly stable_tag: string;
  readonly prerelease: boolean;
  readonly source_rc_tag: string;
}

const VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.(0|[1-9][0-9]*))?$/;

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseVersion(value: string): Version | undefined {
  const match = VERSION_PATTERN.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const parts = [match[1], match[2], match[3], match[4]]
    .filter((part): part is string => part !== undefined)
    .map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return undefined;
  const [major, minor, patch, rc] = parts;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return { major, minor, patch, ...(rc === undefined ? {} : { rc }) };
}

function parseVersionTag(value: string): Version | undefined {
  return value.startsWith("v") ? parseVersion(value.slice(1)) : undefined;
}

function tag(version: Version): string {
  const stable = `v${version.major}.${version.minor}.${version.patch}`;
  return version.rc === undefined ? stable : `${stable}-rc.${version.rc}`;
}

function stableTag(version: Version): string {
  return `v${version.major}.${version.minor}.${version.patch}`;
}

function sameBase(left: Version, right: Version): boolean {
  return left.major === right.major && left.minor === right.minor && left.patch === right.patch;
}

function isNextStable(current: Version, candidate: Version): boolean {
  return (
    (candidate.major === current.major &&
      candidate.minor === current.minor &&
      candidate.patch === current.patch + 1) ||
    (candidate.major === current.major &&
      candidate.minor === current.minor + 1 &&
      candidate.patch === 0) ||
    (candidate.major === current.major + 1 && candidate.minor === 0 && candidate.patch === 0)
  );
}

function readRecords<T>(value: unknown, name: string): T[] {
  if (!Array.isArray(value)) fail(`${name} must be a JSON array.`);
  const pages = value.every(Array.isArray) ? value.flat() : value;
  if (!pages.every(isRecord)) fail(`${name} contained an invalid record.`);
  return pages as T[];
}

function readReleaseHistory(value: unknown): PublishedRelease[] {
  const releases: PublishedRelease[] = [];
  for (const release of readRecords<ReleaseRecord>(value, "Release history")) {
    const releaseTag = release.tag_name;
    if (typeof releaseTag !== "string" || parseVersionTag(releaseTag) === undefined) continue;
    if (typeof release.draft !== "boolean") {
      fail(`${releaseTag} has no boolean draft flag.`);
    }
    if (release.draft) continue;
    if (typeof release.published_at !== "string") {
      fail(`${releaseTag} has no publication timestamp.`);
    }
    releases.push({ ...release, tag_name: releaseTag, published_at: release.published_at });
  }
  return releases.sort((left, right) => {
    const timeOrder = left.published_at.localeCompare(right.published_at);
    if (timeOrder !== 0) return timeOrder;
    const leftId = typeof left.id === "number" ? left.id : 0;
    const rightId = typeof right.id === "number" ? right.id : 0;
    return leftId - rightId;
  });
}

function replayHistory(releases: readonly ReleaseRecord[]): ReleaseState {
  let stable: Version | undefined;
  let active: Version | undefined;
  const seen = new Set<string>();

  for (const release of releases) {
    const releaseTag = release.tag_name;
    if (typeof releaseTag !== "string") continue;
    const version = parseVersionTag(releaseTag);
    if (!version) continue;
    if (seen.has(releaseTag)) fail(`Release history contains duplicate ${releaseTag} releases.`);
    seen.add(releaseTag);
    const isPrerelease = version.rc !== undefined;
    if (release.prerelease !== isPrerelease) {
      fail(`${releaseTag} has a GitHub prerelease flag that does not match its version.`);
    }

    if (!stable && !active) {
      if (releaseTag !== "v1.0.0-rc.0") {
        fail("Release history must begin with v1.0.0-rc.0.");
      }
      active = version;
      continue;
    }

    if (active) {
      if (version.rc !== undefined) {
        if (!sameBase(active, version) || version.rc !== (active.rc ?? -1) + 1) {
          fail(`${releaseTag} does not continue the active ${stableTag(active)} RC sequence.`);
        }
        active = version;
        continue;
      }
      if (!sameBase(active, version)) {
        fail(`${releaseTag} does not promote the active ${stableTag(active)} RC sequence.`);
      }
      stable = version;
      active = undefined;
      continue;
    }

    if (!stable || version.rc !== 0 || !isNextStable(stable, version)) {
      fail(
        `${releaseTag} is not a valid next release after ${stable ? tag(stable) : "the initial release"}.`,
      );
    }
    active = version;
  }

  return { ...(stable ? { stable } : {}), ...(active ? { active } : {}) };
}

export function validateReleaseRequest(
  rawVersion: string,
  branch: string,
  releaseValue: unknown,
  tagValue: unknown,
): ValidationResult {
  const requested = parseVersion(rawVersion);
  if (!requested) {
    fail("Version must be strict SemVer without a v prefix: X.Y.Z or X.Y.Z-rc.N.");
  }
  if (branch !== "dev" && branch !== "main") {
    fail("Releases may only be dispatched from the dev or main branch.");
  }
  if ((branch === "dev") !== (requested.rc !== undefined)) {
    fail(
      branch === "dev"
        ? "The dev branch only publishes X.Y.Z-rc.N prereleases."
        : "The main branch only publishes stable X.Y.Z releases.",
    );
  }

  const releaseTag = tag(requested);
  const allReleases = readRecords<ReleaseRecord>(releaseValue, "Release history");
  if (allReleases.some((release) => release.tag_name === releaseTag)) {
    fail(`${releaseTag} already has a GitHub release, including a possible draft.`);
  }
  const tagRefs = readRecords<TagRecord>(tagValue, "Tag history");
  if (tagRefs.some((record) => record.ref === `refs/tags/${releaseTag}`)) {
    fail(`${releaseTag} already exists as a Git tag.`);
  }

  const state = replayHistory(readReleaseHistory(releaseValue));
  if (requested.rc !== undefined) {
    if (state.active) {
      if (!sameBase(state.active, requested) || requested.rc !== (state.active.rc ?? -1) + 1) {
        fail(
          `${releaseTag} must continue the active ${stableTag(state.active)} sequence at rc.${(state.active.rc ?? -1) + 1}.`,
        );
      }
    } else if (!state.stable) {
      if (releaseTag !== "v1.0.0-rc.0") fail("The first release must be v1.0.0-rc.0.");
    } else if (requested.rc !== 0 || !isNextStable(state.stable, requested)) {
      fail(`${releaseTag} is not an allowed next release after ${tag(state.stable)}.`);
    }
  } else {
    if (!state.active || !sameBase(state.active, requested)) {
      fail(`${releaseTag} requires an active matching release-candidate sequence.`);
    }
  }

  return {
    release_tag: releaseTag,
    stable_tag: stableTag(requested),
    prerelease: requested.rc !== undefined,
    source_rc_tag: requested.rc === undefined && state.active ? tag(state.active) : "",
  };
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) fail(`Missing required ${name} argument.`);
  return value;
}

async function main(): Promise<void> {
  const version = argument("--version");
  const branch = argument("--branch");
  const releases = JSON.parse(await readFile(argument("--releases"), "utf8")) as unknown;
  const tags = JSON.parse(await readFile(argument("--tags"), "utf8")) as unknown;
  const result = validateReleaseRequest(version, branch, releases, tags);
  const output = `${Object.entries(result)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("\n")}\n`;
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) await appendFile(outputPath, output);
  process.stdout.write(JSON.stringify(result));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await main();
