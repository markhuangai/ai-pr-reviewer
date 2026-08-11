import { chmod, lstat, lutimes, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("Usage: node scripts/normalize-archive.mjs <directory>");

async function normalize(path) {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    await lutimes(path, 0, 0);
    return;
  }
  await utimes(path, 0, 0);
  if (stats.isDirectory()) {
    await chmod(path, 0o755);
    const children = await readdir(path);
    for (const child of children.sort()) await normalize(join(path, child));
    return;
  }
  await chmod(path, stats.mode & 0o111 ? 0o755 : 0o644);
}

await normalize(root);
