import { main } from "../index.js";
import { pathToFileURL } from "node:url";

export async function runRuntimeEntry(run: () => Promise<void> = main): Promise<void> {
  await run();
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await runRuntimeEntry();
