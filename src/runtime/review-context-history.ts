import { createReadStream } from "node:fs";
import { glob, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { isRecord } from "./agent-logging.js";
import { isWithinRepository } from "./agent-review-tools.js";
import type { ReviewContextPacket } from "./review-context-packets.js";

export interface ReviewContextTranscript {
  readonly sessionId: string;
  readonly path?: string;
  readonly executor: "claude" | "codex";
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part: unknown) =>
    isRecord(part) &&
    (part.type === "text" || part.type === "input_text") &&
    typeof part.text === "string"
      ? [part.text]
      : [],
  );
}

export class ReviewContextHistory {
  private readonly byText: ReadonlyMap<string, string>;
  private transcript: ReviewContextTranscript | undefined;
  private lastVersion = "";
  private lastConfirmed: ReadonlySet<string> = new Set();

  constructor(
    private readonly home: string,
    packets: readonly ReviewContextPacket[],
  ) {
    this.byText = new Map(packets.map(({ id, text }) => [text, id]));
  }

  attach(transcript: ReviewContextTranscript): void {
    if (this.transcript !== undefined && this.transcript.sessionId !== transcript.sessionId) return;
    this.transcript = transcript;
  }

  async confirmed(): Promise<ReadonlySet<string> | undefined> {
    const transcript = this.transcript;
    if (transcript === undefined) return undefined;
    try {
      let candidate = transcript.path;
      if (candidate === undefined && /^[0-9a-f-]{36}$/iu.test(transcript.sessionId)) {
        const pattern =
          transcript.executor === "codex"
            ? `sessions/**/*${transcript.sessionId}.jsonl`
            : `projects/**/${transcript.sessionId}.jsonl`;
        for await (const relative of glob(pattern, { cwd: this.home })) {
          candidate = join(this.home, relative);
          this.transcript = { ...transcript, path: candidate };
          break;
        }
      }
      if (candidate === undefined) return undefined;
      const path = await realpath(candidate);
      if (
        !isWithinRepository(await realpath(this.home), path) ||
        !basename(path).endsWith(`${transcript.sessionId}.jsonl`)
      )
        return undefined;
      const info = await stat(path);
      const version = `${path}:${info.ino}:${info.size}:${info.mtimeMs}`;
      if (version === this.lastVersion) return this.lastConfirmed;
      if (!info.isFile() || info.size === 0) return undefined;
      const confirmed = new Set<string>();
      const pending = new Set<string>();
      const acknowledge = () => {
        for (const id of pending) confirmed.add(id);
        pending.clear();
      };
      const user = (content: unknown) => {
        for (const text of textBlocks(content)) {
          const id = this.byText.get(text);
          if (id !== undefined) pending.add(id);
        }
      };
      const reset = () => {
        confirmed.clear();
        pending.clear();
      };
      let correctSession = transcript.executor === "claude";
      const codexItem = (item: unknown) => {
        if (!isRecord(item)) return;
        if (item.type === "message" && item.role === "user") user(item.content);
        if (
          (item.type === "message" && item.role === "assistant") ||
          item.type === "function_call" ||
          item.type === "custom_tool_call" ||
          item.type === "mcp_call"
        )
          acknowledge();
      };
      const stream = createReadStream(path, { end: info.size - 1 });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          let entry: unknown;
          try {
            entry = JSON.parse(line);
          } catch {
            return undefined;
          }
          if (!isRecord(entry)) continue;
          if (transcript.executor === "codex") {
            if (entry.type === "session_meta" && isRecord(entry.payload)) {
              if (!correctSession && entry.payload.id !== transcript.sessionId) return undefined;
              correctSession = true;
            } else if (correctSession && entry.type === "response_item") codexItem(entry.payload);
            else if (correctSession && entry.type === "compacted" && isRecord(entry.payload)) {
              reset();
              if (Array.isArray(entry.payload.replacement_history))
                for (const item of entry.payload.replacement_history) codexItem(item);
            }
          } else if (entry.type === "system" && entry.subtype === "compact_boundary") {
            reset();
          } else if (
            isRecord(entry.message) &&
            entry.isSidechain !== true &&
            entry.isSynthetic !== true
          ) {
            if (
              entry.type === "user" &&
              entry.message.role === "user" &&
              entry.isCompactSummary !== true
            )
              user(entry.message.content);
            if (
              entry.type === "assistant" &&
              entry.message.role === "assistant" &&
              entry.isApiErrorMessage !== true &&
              entry.message.model !== "<synthetic>"
            )
              acknowledge();
          }
        }
      } finally {
        lines.close();
        stream.destroy();
      }
      if (!correctSession) return undefined;
      this.lastVersion = version;
      this.lastConfirmed = confirmed;
      return confirmed;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      throw new Error("Could not verify the native review context transcript.");
    }
  }
}
