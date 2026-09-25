import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { parseGitNameStatus } from "../lib/git-changed-files.js";
import type { DiffFileSpan } from "./agent-review-tools.js";

const execFileAsync = promisify(execFile);

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
  maxBytes?: number,
  acceptNoMatches = false,
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
  let streamedBytes = 0;
  const limiter =
    maxBytes === undefined
      ? undefined
      : new Transform({
          transform(chunk: Buffer, _encoding, callback): void {
            if (chunk.length > maxBytes - streamedBytes) {
              callback(new Error(`${failureLabel} exceeded the configured output byte limit.`));
              return;
            }
            streamedBytes += chunk.length;
            callback(null, chunk);
          },
        });
  const streamed = (
    limiter === undefined
      ? signal === undefined
        ? pipeline(child.stdout, output)
        : pipeline(child.stdout, output, { signal })
      : signal === undefined
        ? pipeline(child.stdout, limiter, output)
        : pipeline(child.stdout, limiter, output, { signal })
  ).catch((error: unknown) => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    throw error;
  });
  const [streamOutcome, exitOutcome] = await Promise.allSettled([streamed, exited]);
  throwIfAborted(signal);
  const failures: string[] = [];
  if (streamOutcome.status === "rejected") failures.push(errorMessage(streamOutcome.reason));
  if (exitOutcome.status === "rejected") failures.push(errorMessage(exitOutcome.reason));
  else if (exitOutcome.value.code !== 0 && !(acceptNoMatches && exitOutcome.value.code === 1)) {
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

export function diffArguments(mergeBaseSha: string): string[] {
  return [
    `--attr-source=${mergeBaseSha}`,
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--full-index",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--find-renames=50%",
    "-l0",
    "--submodule=short",
  ];
}

export async function indexDiff(
  cwd: string,
  mergeBaseSha: string,
  headSha: string,
  path: string,
  size: number,
  signal?: AbortSignal,
): Promise<readonly DiffFileSpan[]> {
  const { stdout } = await execFileAsync(
    "git",
    [...diffArguments(mergeBaseSha), "--raw", "--no-abbrev", "-z", mergeBaseSha, headSha, "--"],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      ...(signal === undefined ? {} : { signal }),
    },
  );
  const tokens = stdout.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const names: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const record = /^:[0-7]{6} [0-7]{6} [0-9a-f]{40,64} [0-9a-f]{40,64} ([A-Z][0-9]*)$/u.exec(
      tokens[index++] ?? "",
    );
    if (record?.[1] === undefined) throw new Error("Git returned invalid diff path metadata.");
    const count = /^[RC]/u.test(record[1]) ? 2 : 1;
    names.push(record[1]);
    for (let item = 0; item < count; item += 1) {
      const name = tokens[index++];
      if (name === undefined || name.length === 0)
        throw new Error("Git returned incomplete diff path metadata.");
      names.push(name);
    }
  }
  const files = parseGitNameStatus(names.join("\0") + (names.length === 0 ? "" : "\0"));
  const boundaries: number[] = [];
  const marker = Buffer.from("diff --git ");
  let offset = 0;
  let lineStart = 0;
  let prefix = Buffer.alloc(0);
  for await (const chunk of createReadStream(path)) {
    throwIfAborted(signal);
    const buffer = chunk as Buffer;
    for (let start = 0; start < buffer.length;) {
      const newline = buffer.indexOf(10, start);
      const end = newline < 0 ? buffer.length : newline;
      if (prefix.length < marker.length) {
        prefix = Buffer.concat([
          prefix,
          buffer.subarray(start, Math.min(end, start + marker.length - prefix.length)),
        ]);
        if (prefix.length === marker.length && prefix.equals(marker)) boundaries.push(lineStart);
      }
      if (newline < 0) break;
      prefix = Buffer.alloc(0);
      lineStart = offset + newline + 1;
      start = newline + 1;
    }
    offset += buffer.length;
  }
  if (boundaries.length !== files.length || (size > 0 && boundaries[0] !== 0))
    throw new Error("Captured diff boundaries do not match Git path metadata.");
  return files.map((file, index) => ({
    paths: [file.path, ...(file.previousPath === undefined ? [] : [file.previousPath])],
    offset: boundaries[index] as number,
    size: (boundaries[index + 1] ?? size) - (boundaries[index] as number),
  }));
}
