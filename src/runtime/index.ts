import { main } from "../index.js";
import { pathToFileURL } from "node:url";

import { installCancellationHandlers } from "../lib/bootstrap/cancellation.js";

export async function runRuntimeEntry(
  run: (controller: AbortController) => Promise<void> = main,
): Promise<void> {
  const cancellation = installCancellationHandlers();
  try {
    await run(cancellation.controller);
  } finally {
    cancellation.dispose();
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) await runRuntimeEntry();
