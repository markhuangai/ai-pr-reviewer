export interface ActionReleaseVersion {
  readonly tag: string;
  readonly stableTag: string;
  readonly prerelease: boolean;
}

export interface ActionReleaseAlias {
  readonly tag: string;
  readonly major: number;
  readonly prerelease: boolean;
}

export type ActionReleaseReference = ActionReleaseVersion | ActionReleaseAlias;

const VERSION_TAG_PATTERN =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.(0|[1-9][0-9]*))?$/;
const ALIAS_TAG_PATTERN = /^v(0|[1-9][0-9]*)(-prerelease)?$/;

export function parseActionReleaseTag(value: string | undefined): ActionReleaseVersion | undefined {
  if (value === undefined) return undefined;
  const match = VERSION_TAG_PATTERN.exec(value);
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  const stableTag = `v${match[1]}.${match[2]}.${match[3]}`;
  return {
    tag: value,
    stableTag,
    prerelease: match[4] !== undefined,
  };
}

export function parseActionReleaseReference(
  value: string | undefined,
): ActionReleaseReference | undefined {
  const exact = parseActionReleaseTag(value);
  if (exact) return exact;
  if (value === undefined) return undefined;
  const match = ALIAS_TAG_PATTERN.exec(value);
  if (!match?.[1]) return undefined;
  return {
    tag: value,
    major: Number(match[1]),
    prerelease: match[2] !== undefined,
  };
}

export function aliasAcceptsRelease(
  alias: ActionReleaseAlias,
  release: ActionReleaseVersion,
): boolean {
  const major = /^v(0|[1-9][0-9]*)\./u.exec(release.stableTag)?.[1];
  return (
    major !== undefined && Number(major) === alias.major && release.prerelease === alias.prerelease
  );
}

export function isCompatibleRuntimeManifest(
  release: ActionReleaseVersion,
  artifactTag: unknown,
  stableTag: unknown,
): boolean {
  if (typeof artifactTag !== "string" || typeof stableTag !== "string") return false;
  const artifact = parseActionReleaseTag(artifactTag);
  if (!artifact?.prerelease || artifact.stableTag !== stableTag) return false;
  return release.prerelease
    ? release.tag === artifactTag && release.stableTag === stableTag
    : release.tag === stableTag;
}
