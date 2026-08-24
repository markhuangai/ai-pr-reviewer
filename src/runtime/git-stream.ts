import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { cancellationReason, throwIfAborted } from "../lib/bootstrap/cancellation.js";

const MAX_GIT_STDERR_BYTES = 64 * 1024;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function streamGitToFile(
  cwd: string,
  args: readonly string[],
  outputPath: string,
  failureLabel: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const child = spawn("git", args, {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
    ...(signal === undefined ? {} : { signal }),
  });
  const stderr: Buffer[] = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_GIT_STDERR_BYTES) return;
    const bounded = chunk.subarray(0, MAX_GIT_STDERR_BYTES - stderrBytes);
    stderr.push(bounded);
    stderrBytes += bounded.length;
  });
  const exited = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveExit, rejectExit) => {
    child.once("error", (error) => {
      if (signal?.aborted) {
        rejectExit(cancellationReason(signal));
        return;
      }
      rejectExit(error);
    });
    child.once("close", (code, childSignal) => {
      resolveExit({ code, signal: childSignal });
    });
  });
  const output = createWriteStream(outputPath, { flags: "wx", mode: 0o600 });
  const streamed = (
    signal === undefined
      ? pipeline(child.stdout, output)
      : pipeline(child.stdout, output, { signal })
  ).catch((error: unknown) => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  });
  const [streamOutcome, exitOutcome] = await Promise.allSettled([streamed, exited]);
  throwIfAborted(signal);
  const failures: string[] = [];
  if (streamOutcome.status === "rejected") failures.push(errorMessage(streamOutcome.reason));
  if (exitOutcome.status === "rejected") failures.push(errorMessage(exitOutcome.reason));
  else if (exitOutcome.value.code !== 0) {
    const details = Buffer.concat(stderr).toString("utf8").trim();
    const status =
      exitOutcome.value.signal === null
        ? `exit code ${String(exitOutcome.value.code)}`
        : `signal ${exitOutcome.value.signal}`;
    failures.push(
      `${failureLabel} failed with ${status}${details.length === 0 ? "." : `: ${details}`}`,
    );
  }
  if (failures.length > 0) throw new Error([...new Set(failures)].join("; "));
}
