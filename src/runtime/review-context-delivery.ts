import { throwIfAborted } from "../lib/bootstrap/cancellation.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CodexRpcError } from "./codex-app-server.js";
import type { ReviewEvidenceLedger } from "./review-assessment.js";
import type { ReviewBriefingReader } from "./review-briefing.js";
import { ReviewContextHistory } from "./review-context-history.js";
import {
  ADVANCE_REVIEW_CONTEXT_CALL,
  REVIEW_CONTEXT_WIRE_BYTES,
  type ReviewContextPacket,
  type SharedReviewContext,
} from "./review-context-packets.js";
import { tool } from "./review-tool.js";

export const STARTUP_PRELOAD_PACKETS = 2;
export const STARTUP_PRELOAD_WIRE_BYTES = STARTUP_PRELOAD_PACKETS * REVIEW_CONTEXT_WIRE_BYTES;

export class ReviewContextDelivery {
  readonly history: ReviewContextHistory;
  private readonly confirmed = new Set<string>();
  private readonly everConfirmed = new Set<string>();
  private readonly inFlight = new Map<string, ReviewContextPacket>();
  private startupPackets = 0;
  private startupWireBytes = 0;
  private readonly attempted = new Set<string>();
  private readonly replayed = new Set<string>();
  private readonly deferred = new Set<string>();
  private refreshOperation: Promise<void> = Promise.resolve();
  private cueSent = false;
  private packetBoundaryPending = false;
  advanceRequested = false;
  handoffs = 0;

  constructor(
    private readonly prepared: SharedReviewContext,
    home: string,
    private readonly briefing: ReviewBriefingReader,
    private readonly ledger: ReviewEvidenceLedger,
    private readonly log: (event: string, detail: Record<string, unknown>) => void,
    private readonly onEvidenceReset?: () => void,
  ) {
    this.history = new ReviewContextHistory(home, prepared.packets);
  }

  get pending(): boolean {
    return this.prepared.packets.some(
      ({ id }) => !this.confirmed.has(id) && !this.deferred.has(id),
    );
  }

  get sweeping(): boolean {
    return this.inFlight.size > 0 || this.pending;
  }

  get hasUnstagedPackets(): boolean {
    return this.nextUnstagedPacket() !== undefined;
  }

  get needsBoundary(): boolean {
    return this.packetBoundaryPending || this.sweeping || this.advanceRequested;
  }

  stage(): ReviewContextPacket | undefined {
    if (this.inFlight.size > 0) return undefined;
    const packet = this.nextUnstagedPacket();
    if (packet === undefined) return undefined;
    return this.queue(packet);
  }

  stageStartupPacket(
    maxPackets = STARTUP_PRELOAD_PACKETS,
    maxWireBytes = STARTUP_PRELOAD_WIRE_BYTES,
  ): ReviewContextPacket | undefined {
    if (this.startupPackets >= Math.min(maxPackets, STARTUP_PRELOAD_PACKETS)) return undefined;
    const packet = this.nextUnstagedPacket();
    if (
      packet === undefined ||
      this.startupWireBytes + packet.wireBytes > Math.min(maxWireBytes, STARTUP_PRELOAD_WIRE_BYTES)
    )
      return undefined;
    this.startupPackets++;
    this.startupWireBytes += packet.wireBytes;
    return this.queue(packet);
  }

  deferInFlight(packetId: string, reason = "no-native-receipt"): void {
    const packet = this.inFlight.get(packetId);
    if (packet === undefined) return;
    this.inFlight.delete(packetId);
    this.defer(packet, reason);
  }

  private nextUnstagedPacket(): ReviewContextPacket | undefined {
    return this.prepared.packets.find(
      ({ id }) => !this.confirmed.has(id) && !this.deferred.has(id) && !this.inFlight.has(id),
    );
  }

  private queue(packet: ReviewContextPacket): ReviewContextPacket {
    this.inFlight.set(packet.id, packet);
    this.packetBoundaryPending = true;
    const replay = this.attempted.has(packet.id) || this.everConfirmed.has(packet.id);
    if (replay) this.replayed.add(packet.id);
    this.log("context-packet-queued", {
      snapshot: this.prepared.snapshot,
      run: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      packet: packet.id,
      bytes: packet.sourceBytes,
      wireBytes: packet.wireBytes,
      replay,
    });
    this.attempted.add(packet.id);
    return packet;
  }

  refresh(claudeToolSession?: string): Promise<void> {
    const result = this.refreshOperation.then(async () => {
      const verified = await this.history.confirmed(
        this.inFlight.size > 0 ? claudeToolSession : undefined,
      );
      const lost = new Set([...this.confirmed].filter((id) => !verified?.has(id)));
      if (lost.size > 0) {
        this.log(
          verified === undefined
            ? "context-packet-verification-unavailable"
            : "context-packet-compacted",
          { snapshot: this.prepared.snapshot },
        );
        this.ledger.resetDelivery();
        this.briefing.resetDelivery();
        this.confirmed.clear();
        this.cueSent = false;
        this.packetBoundaryPending = true;
        for (const packet of this.prepared.packets) {
          if (!this.replayed.has(packet.id) || !lost.has(packet.id)) continue;
          this.defer(packet, "replay-limit");
        }
      }
      for (const packet of this.prepared.packets) {
        if (!verified?.has(packet.id) || this.confirmed.has(packet.id)) continue;
        const before = this.ledger.uniqueSourceBytes;
        this.ledger.confirmContextRanges(packet.id, packet.ranges);
        for (const page of packet.pages)
          if (page.kind === "briefing") this.briefing.confirmPage(page.page.page);
        this.confirmed.add(packet.id);
        this.deferred.delete(packet.id);
        this.inFlight.delete(packet.id);
        const confirmedBytes = this.ledger.uniqueSourceBytes - before;
        const repeatedBytes = this.everConfirmed.has(packet.id)
          ? packet.sourceBytes
          : packet.sourceBytes - confirmedBytes;
        this.everConfirmed.add(packet.id);
        this.log("context-packet-confirmed", {
          snapshot: this.prepared.snapshot,
          run: process.env.GITHUB_RUN_ID,
          attempt: process.env.GITHUB_RUN_ATTEMPT,
          packet: packet.id,
          confirmedBytes,
          repeatedBytes,
          inherited: !this.attempted.has(packet.id),
          missingPaths: this.ledger.inspection.missingPaths,
        });
      }
      if (lost.size > 0) this.onEvidenceReset?.();
    });
    this.refreshOperation = result.catch(() => undefined);
    return result;
  }

  async boundary(): Promise<boolean> {
    const wasSweeping = this.needsBoundary;
    await this.refresh();
    for (const id of this.inFlight.keys()) this.deferInFlight(id);
    const continueSweep = wasSweeping || this.needsBoundary;
    this.packetBoundaryPending = false;
    return continueSweep;
  }

  private defer(packet: ReviewContextPacket, reason: string): void {
    this.deferred.add(packet.id);
    this.log("context-packet-unconfirmed", {
      snapshot: this.prepared.snapshot,
      run: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      packet: packet.id,
      unreadBytes: packet.sourceBytes,
      fallback: "paged tools",
      reason,
    });
  }

  nextMessage(): { text: string; packet: boolean } | undefined {
    this.advanceRequested = false;
    const packet = this.stage();
    if (packet !== undefined) {
      this.cueSent = false;
      this.handoffs++;
      this.log("context-packet-handoff", {
        snapshot: this.prepared.snapshot,
        run: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
        handoffs: this.handoffs,
      });
      return { text: packet.text, packet: true };
    }
    if (this.cueSent) return undefined;
    this.cueSent = true;
    return { text: this.submissionCue(), packet: false };
  }

  advanceTool(isActive: () => boolean, signal?: AbortSignal) {
    return tool(
      ADVANCE_REVIEW_CONTEXT_CALL.tool,
      "Confirm you have considered the current shared packet and ask the host to continue the same review with the next unread packet. Do not combine with other calls. When the sweep ends, complete outstanding checks and call submit_review.",
      {},
      async () => {
        throwIfAborted(signal);
        await this.refresh();
        if (!isActive())
          return {
            isError: true,
            content: [{ type: "text", text: "There is no active review context sweep." }],
          };
        if (this.advanceRequested)
          return { content: [{ type: "text", text: "The next packet is already scheduled." }] };
        if (!this.sweeping) {
          this.cueSent = true;
          return { content: [{ type: "text", text: this.submissionCue() }] };
        }
        this.advanceRequested = true;
        return {
          content: [
            {
              type: "text",
              text: "Context advance acknowledged. Wait for the host to deliver the next unread packet.",
            },
          ],
          _meta: { "claude/endTurn": true, context_advance: true },
        };
      },
      { alwaysLoad: true },
    );
  }

  private submissionCue(): string {
    const checks = [
      ...(this.briefing.complete ? [] : ["finish unread briefing pages with read_review_briefing"]),
      ...(this.ledger.inspection.missingPaths.length === 0
        ? []
        : ["finish unread changed ranges with read_pr_diff remaining=true"]),
      "verify relevant callers, tests and prior discussion before reporting findings",
    ];
    return `Shared context sweep ended. Outstanding checks: ${checks.join("; ")}. Use read_review_state for exact gaps or evidence references as needed. Then call submit_review for this same goal, even when findings are empty.`;
  }
}

export async function injectCodexContextPackets(
  delivery: ReviewContextDelivery,
  forked: boolean,
  inject: (text: string) => Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  await delivery.refresh();
  const stage = () => (forked ? delivery.stageStartupPacket() : delivery.stage());
  for (let packet = stage(); packet !== undefined; packet = stage()) {
    try {
      throwIfAborted(signal);
      await inject(packet.text);
    } catch (error) {
      if (!(error instanceof CodexRpcError)) throw error;
      throwIfAborted(signal);
      delivery.deferInFlight(packet.id);
      break;
    }
  }
}

export function appendCodexToolAdvisory(
  result: CallToolResult,
  toolName: string,
  advisory: string | undefined,
): CallToolResult {
  if (
    advisory === undefined ||
    ["submit_review", ADVANCE_REVIEW_CONTEXT_CALL.tool, "finish_discovery"].includes(toolName)
  )
    return result;
  return { ...result, content: [...result.content, { type: "text", text: advisory }] };
}
