import { chmod, lstat, lutimes, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function normalizeArchive(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    await lutimes(path, 0, 0);
    return;
  }
  await utimes(path, 0, 0);
  if (stats.isDirectory()) {
    await chmod(path, 0o755);
    const children = await readdir(path);
    for (const child of children.sort()) await normalizeArchive(join(path, child));
    return;
  }
  await chmod(path, stats.mode & 0o111 ? 0o755 : 0o644);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const root = process.argv[2];
  if (!root) throw new Error("Usage: node scripts/normalize-archive.ts <directory>");
  await normalizeArchive(root);
}
