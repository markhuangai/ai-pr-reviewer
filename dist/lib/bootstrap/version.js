const VERSION_TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.(0|[1-9][0-9]*))?$/;
const ALIAS_TAG_PATTERN = /^v(0|[1-9][0-9]*)(-prerelease)?$/;
export function parseActionReleaseTag(value) {
    if (value === undefined)
        return undefined;
    const match = VERSION_TAG_PATTERN.exec(value);
    if (!match?.[1] || !match[2] || !match[3])
        return undefined;
    if ([match[1], match[2], match[3], match[4]].some((part) => part !== undefined && !Number.isSafeInteger(Number(part))))
        return undefined;
    const stableTag = `v${match[1]}.${match[2]}.${match[3]}`;
    return {
        tag: value,
        stableTag,
        prerelease: match[4] !== undefined,
    };
}
export function parseActionReleaseReference(value) {
    const exact = parseActionReleaseTag(value);
    if (exact)
        return exact;
    if (value === undefined)
        return undefined;
    const match = ALIAS_TAG_PATTERN.exec(value);
    if (!match?.[1])
        return undefined;
    return {
        tag: value,
        major: Number(match[1]),
        prerelease: match[2] !== undefined,
    };
}
export function aliasAcceptsRelease(alias, release) {
    const major = /^v(0|[1-9][0-9]*)\./u.exec(release.stableTag)?.[1];
    return (major !== undefined && Number(major) === alias.major && release.prerelease === alias.prerelease);
}
export function isCompatibleRuntimeManifest(release, artifactTag, stableTag) {
    if (typeof artifactTag !== "string" || typeof stableTag !== "string")
        return false;
    const artifact = parseActionReleaseTag(artifactTag);
    if (!artifact?.prerelease || artifact.stableTag !== stableTag)
        return false;
    if (release.prerelease)
        return release.tag === artifactTag && release.stableTag === stableTag;
    const [major, minor] = artifact.stableTag.slice(1).split(".");
    return (release.tag === stableTag ||
        release.tag === `v${major}.${Number(minor) + 1}.0` ||
        release.tag === `v${Number(major) + 1}.0.0`);
}
