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
  readonly forkedFrom?: string;
  readonly endByteOffset?: number;
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
    private readonly packets: readonly ReviewContextPacket[],
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
      const end = transcript.endByteOffset ?? info.size;
      const version = `${path}:${info.ino}:${end}:${info.mtimeMs}`;
      if (version === this.lastVersion) return this.lastConfirmed;
      if (!info.isFile() || end <= 0 || end > info.size) return undefined;
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
      let correctSession = false;
      let responsePending = false;
      let activeTurn: string | undefined;
      const codexItem = (item: unknown): boolean | undefined => {
        if (!isRecord(item)) return undefined;
        if (item.type === "message" && item.role === "user") {
          user(item.content);
          return false;
        }
        if (
          (item.type === "message" && item.role === "assistant") ||
          item.type === "function_call" ||
          item.type === "custom_tool_call" ||
          item.type === "mcp_call"
        )
          return true;
        return undefined;
      };
      const stream = createReadStream(path, { end: end - 1 });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      const readState: { error?: Error } = {};
      lines.on("error", (error: Error) => {
        readState.error = error;
        lines.close();
      });
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
            const payload = entry.payload;
            if (entry.type === "session_meta" && isRecord(entry.payload)) {
              if (entry.payload.id !== transcript.sessionId) return undefined;
              if (!correctSession && transcript.forkedFrom !== undefined) {
                const ancestry = entry.payload.history_base;
                if (
                  isRecord(ancestry) &&
                  ancestry.thread_id === transcript.forkedFrom &&
                  entry.payload.forked_from_id === transcript.forkedFrom &&
                  Number.isSafeInteger(ancestry.end_ordinal_exclusive) &&
                  ancestry.end_ordinal_exclusive === entry.payload.forked_from_ordinal_exclusive &&
                  typeof ancestry.end_byte_offset === "number" &&
                  Number.isSafeInteger(ancestry.end_byte_offset) &&
                  ancestry.end_byte_offset > 0
                ) {
                  const parent = new ReviewContextHistory(this.home, this.packets);
                  parent.attach({
                    executor: "codex",
                    sessionId: transcript.forkedFrom,
                    endByteOffset: ancestry.end_byte_offset,
                  });
                  for (const id of (await parent.confirmed()) ?? []) confirmed.add(id);
                }
              }
              correctSession = true;
            } else if (correctSession && entry.type === "response_item") {
              responsePending = codexItem(entry.payload) ?? responsePending;
            } else if (
              correctSession &&
              entry.type === "token_usage_record" &&
              responsePending &&
              activeTurn !== undefined &&
              isRecord(payload) &&
              payload.turn_id === activeTurn &&
              payload.thread_id === transcript.sessionId &&
              payload.session_id === transcript.sessionId &&
              typeof payload.response_id === "string"
            ) {
              acknowledge();
              responsePending = false;
            } else if (
              correctSession &&
              entry.type === "event_msg" &&
              isRecord(entry.payload) &&
              ["error", "task_started", "task_complete", "turn_aborted"].includes(
                String(entry.payload.type),
              )
            ) {
              responsePending = false;
              if (
                entry.payload.type === "task_started" &&
                typeof entry.payload.turn_id === "string"
              )
                activeTurn = entry.payload.turn_id;
              else if (entry.payload.type !== "error" && entry.payload.turn_id === activeTurn)
                activeTurn = undefined;
            } else if (correctSession && entry.type === "compacted" && isRecord(entry.payload)) {
              const previouslyConfirmed = new Set(confirmed);
              reset();
              if (Array.isArray(entry.payload.replacement_history))
                for (const item of entry.payload.replacement_history)
                  if (isRecord(item) && item.type === "message" && item.role === "user")
                    user(item.content);
              for (const id of pending)
                if (previouslyConfirmed.has(id)) {
                  confirmed.add(id);
                  pending.delete(id);
                }
              responsePending = false;
            }
          } else if (entry.sessionId === transcript.sessionId) {
            correctSession = true;
            if (entry.type === "system" && entry.subtype === "compact_boundary") reset();
            else if (
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
        }
      } finally {
        lines.close();
        stream.destroy();
      }
      if (readState.error !== undefined) throw readState.error;
      if (!correctSession) return undefined;
      this.lastVersion = version;
      this.lastConfirmed = confirmed;
      return confirmed;
    } catch (error) {
      if (
        isRecord(error) &&
        ["ENOENT", "EACCES", "EPERM", "EIO", "ENOTDIR", "ESTALE", "EMFILE"].includes(
          String(error.code),
        )
      )
        return undefined;
      throw new Error("Could not verify the native review context transcript.", { cause: error });
    }
  }
}
