const VERSION_TAG_PATTERN = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-rc\.(0|[1-9][0-9]*))?$/;
export function parseActionReleaseTag(value) {
    if (value === undefined)
        return undefined;
    const match = VERSION_TAG_PATTERN.exec(value);
    if (!match?.[1] || !match[2] || !match[3])
        return undefined;
    const stableTag = `v${match[1]}.${match[2]}.${match[3]}`;
    return {
        tag: value,
        stableTag,
        prerelease: match[4] !== undefined,
    };
}
export function isCompatibleRuntimeManifest(release, artifactTag, stableTag) {
    if (typeof artifactTag !== "string" || typeof stableTag !== "string")
        return false;
    const artifact = parseActionReleaseTag(artifactTag);
    if (!artifact?.prerelease || artifact.stableTag !== stableTag)
        return false;
    return release.prerelease
        ? release.tag === artifactTag && release.stableTag === stableTag
        : release.tag === stableTag;
}
