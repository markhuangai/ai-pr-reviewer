import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function copyBootstrap(source = "build", destination = "dist"): Promise<void> {
  await mkdir(destination, { recursive: true });
  await mkdir(join(destination, "lib/bootstrap"), { recursive: true });
  await cp(join(source, "bootstrap.js"), join(destination, "bootstrap.js"));
  await cp(join(source, "lib/bootstrap/archive.js"), join(destination, "lib/bootstrap/archive.js"));
  await cp(join(source, "lib/bootstrap/version.js"), join(destination, "lib/bootstrap/version.js"));
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await copyBootstrap();
