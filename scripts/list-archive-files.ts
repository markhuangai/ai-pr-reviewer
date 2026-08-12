import { lstat, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const rootArgument = process.argv[2];
if (!rootArgument) throw new Error("Usage: node scripts/list-archive-files.ts <directory>");
const root = resolve(rootArgument);
const names: string[] = [];

async function collect(current: string): Promise<void> {
  const stats = await lstat(current);
  const relativeName = relative(root, current).replaceAll("\\", "/");
  names.push(relativeName.length === 0 ? "." : `./${relativeName}`);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return;
  const children = (await readdir(current)).sort();
  for (const child of children) await collect(join(current, child));
}

await collect(root);
names.sort();
process.stdout.write(`${names.join("\0")}\0`);
