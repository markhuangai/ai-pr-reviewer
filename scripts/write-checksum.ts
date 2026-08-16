import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export async function writeChecksum(archive: string): Promise<string> {
  const digest = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(`${archive}.sha256`, `${digest}  ${archive.split(/[\\/]/).at(-1)}\n`);
  return digest;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  const archive = process.argv[2];
  if (!archive) throw new Error("Usage: node scripts/write-checksum.ts <archive>");
  console.log(`${await writeChecksum(archive)}  ${archive}`);
}
