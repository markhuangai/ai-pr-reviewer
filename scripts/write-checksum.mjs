import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const archive = process.argv[2];
if (!archive) throw new Error("Usage: node scripts/write-checksum.mjs <archive>");
const digest = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
await writeFile(`${archive}.sha256`, `${digest}  ${archive.split(/[\\/]/).at(-1)}\n`);
console.log(`${digest}  ${archive}`);
