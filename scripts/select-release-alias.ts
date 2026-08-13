import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

interface ReleaseRecord {
  readonly tag_name?: unknown;
  readonly draft?: unknown;
  readonly prerelease?: unknown;
  readonly published_at?: unknown;
}

interface Version {
  readonly tag: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly rc?: number;
}

export interface ReleaseAliasSelection {
  readonly alias_tag: string;
  readonly release_tag: string;
}

const VERSION_PATTERN =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.(0|[1-9][0-9]*))?$/;

function parseVersion(value: unknown): Version | undefined {
  if (typeof value !== "string") return undefined;
  const match = VERSION_PATTERN.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const parts = [match[1], match[2], match[3], match[4]]
    .filter((part): part is string => part !== undefined)
    .map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) return undefined;
  const [major, minor, patch, rc] = parts;
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return { tag: value, major, minor, patch, ...(rc === undefined ? {} : { rc }) };
}

function compareVersions(left: Version, right: Version): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch ||
    (left.rc ?? -1) - (right.rc ?? -1)
  );
}

function releaseRecords(value: unknown): readonly ReleaseRecord[] {
  if (!Array.isArray(value)) throw new Error("Release history must be a JSON array.");
  const records = value.every(Array.isArray) ? value.flat() : value;
  if (records.some((record) => typeof record !== "object" || record === null)) {
    throw new Error("Release history contained an invalid record.");
  }
  return records as ReleaseRecord[];
}

export function selectReleaseAlias(
  requestedTag: string,
  releaseValue: unknown,
): ReleaseAliasSelection {
  const requested = parseVersion(requestedTag);
  if (!requested) throw new Error("Release alias selection requires an exact vX.Y.Z[-rc.N] tag.");
  const prerelease = requested.rc !== undefined;
  const candidates = releaseRecords(releaseValue)
    .filter(
      (release) =>
        release.draft === false &&
        release.prerelease === prerelease &&
        typeof release.published_at === "string",
    )
    .map((release) => parseVersion(release.tag_name))
    .filter(
      (version): version is Version =>
        version !== undefined &&
        version.major === requested.major &&
        (version.rc !== undefined) === prerelease,
    )
    .sort(compareVersions);
  if (!candidates.some((version) => version.tag === requested.tag)) {
    throw new Error(`${requested.tag} is not a published release in its requested channel.`);
  }
  const latest = candidates.at(-1);
  if (!latest) throw new Error(`No published releases exist for v${requested.major}.`);
  return {
    alias_tag: `v${requested.major}${prerelease ? "-prerelease" : ""}`,
    release_tag: latest.tag,
  };
}

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`Missing required ${name} argument.`);
  return value;
}

async function main(): Promise<void> {
  const requestedTag = argument("--release-tag");
  const releases = JSON.parse(await readFile(argument("--releases"), "utf8")) as unknown;
  const result = selectReleaseAlias(requestedTag, releases);
  const output = `${Object.entries(result)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) await appendFile(outputPath, output);
  process.stdout.write(JSON.stringify(result));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await main();
