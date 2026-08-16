import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function listArchiveFiles(rootArgument: string): Promise<readonly string[]> {
  const root = resolve(rootArgument);
  const names: string[] = [];
  const collect = async (current: string): Promise<void> => {
    const stats = await lstat(current);
    const relativeName = relative(root, current).replaceAll("\\", "/");
    names.push(relativeName.length === 0 ? "." : `./${relativeName}`);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    const children = (await readdir(current)).sort();
    for (const child of children) await collect(join(current, child));
  };
  await collect(root);
  return names.sort();
}

export async function archiveFileListOutput(rootArgument: string): Promise<string> {
  return `${(await listArchiveFiles(rootArgument)).join("\0")}\0`;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const rootArgument = process.argv[2];
  if (!rootArgument) throw new Error("Usage: node scripts/list-archive-files.ts <directory>");
  process.stdout.write(await archiveFileListOutput(rootArgument));
}
