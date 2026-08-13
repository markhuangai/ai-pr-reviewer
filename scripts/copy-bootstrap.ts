import { cp, mkdir } from "node:fs/promises";

const destination = "dist";
await mkdir(destination, { recursive: true });
await mkdir(`${destination}/lib/bootstrap`, { recursive: true });
await cp("build/bootstrap.js", `${destination}/bootstrap.js`);
await cp("build/lib/bootstrap/archive.js", `${destination}/lib/bootstrap/archive.js`);
await cp("build/lib/bootstrap/version.js", `${destination}/lib/bootstrap/version.js`);
