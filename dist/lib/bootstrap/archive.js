import { posix } from "node:path";
function normalized(value) {
    return value.replaceAll("\\", "/");
}
export function isSafeArchiveEntryPath(value) {
    const path = normalized(value);
    return (path.length > 0 &&
        !path.startsWith("/") &&
        !/^[A-Za-z]:\//.test(path) &&
        !path.split("/").includes(".."));
}
export function isSafeArchiveSymlink(entryPath, target) {
    const path = normalized(entryPath);
    const link = normalized(target);
    if (!isSafeArchiveEntryPath(path) || link.startsWith("/") || /^[A-Za-z]:\//.test(link)) {
        return false;
    }
    return isSafeArchiveEntryPath(posix.normalize(posix.join(posix.dirname(path), link)));
}
