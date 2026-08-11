import { cp, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });
await cp("build/bootstrap.js", "dist/bootstrap.js");
