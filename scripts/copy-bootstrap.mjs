import { cp, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await mkdir("dist/lib/bootstrap", { recursive: true });
await cp("build/bootstrap.js", "dist/bootstrap.js");
await cp("build/lib/bootstrap/archive.js", "dist/lib/bootstrap/archive.js");
