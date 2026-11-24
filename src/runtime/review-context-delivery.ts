import { throwIfAborted } from "../lib/bootstrap/cancellation.js";
import type { ReviewEvidenceLedger } from "./review-assessment.js";
import type { ReviewBriefingReader } from "./review-briefing.js";
import { ReviewContextHistory } from "./review-context-history.js";
import type { ReviewContextPacket, SharedReviewContext } from "./review-context-packets.js";
import { tool } from "./review-tool.js";

export class ReviewContextDelivery {
  readonly history: ReviewContextHistory;
  private readonly confirmed = new Set<string>();
  private inFlight: ReviewContextPacket | undefined;
  private attempted = new Set<string>();
  private deferred = new Set<string>();
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
  ) {
    this.history = new ReviewContextHistory(home, prepared.packets);
  }

  get confirmedPackets(): readonly string[] {
    return [...this.confirmed];
  }

  get pending(): boolean {
    return this.prepared.packets.some(
      ({ id }) => !this.confirmed.has(id) && !this.deferred.has(id),
    );
  }

  get sweeping(): boolean {
    return this.inFlight !== undefined || this.pending;
  }

  get needsBoundary(): boolean {
    return this.packetBoundaryPending || this.sweeping || this.advanceRequested;
  }

  stage(inherited: readonly string[] = []): ReviewContextPacket | undefined {
    if (this.inFlight !== undefined) return undefined;
    const packet = this.prepared.packets.find(
      ({ id }) => !this.confirmed.has(id) && !inherited.includes(id) && !this.deferred.has(id),
    );
    if (packet === undefined) return undefined;
    this.inFlight = packet;
    this.packetBoundaryPending = true;
    this.log("context-packet-queued", {
      snapshot: this.prepared.snapshot,
      run: process.env.GITHUB_RUN_ID,
      attempt: process.env.GITHUB_RUN_ATTEMPT,
      packet: packet.id,
      bytes: packet.sourceBytes,
      wireBytes: packet.wireBytes,
      replay: this.attempted.has(packet.id),
    });
    this.attempted.add(packet.id);
    return packet;
  }

  refresh(): Promise<void> {
    const result = this.refreshOperation.then(async () => {
      const verified = await this.history.confirmed();
      if (verified === undefined) return;
      if ([...this.confirmed].some((id) => !verified.has(id))) {
        this.log("context-packet-compacted", { snapshot: this.prepared.snapshot });
        this.ledger.resetDelivery();
        this.briefing.resetDelivery();
        this.confirmed.clear();
        this.deferred.clear();
      }
      for (const packet of this.prepared.packets) {
        if (!verified.has(packet.id) || this.confirmed.has(packet.id)) continue;
        const before = this.ledger.uniqueSourceBytes;
        this.ledger.confirmContextRanges(packet.id, packet.ranges);
        for (const page of packet.pages)
          if (page.kind === "briefing") this.briefing.confirmPage(page.page.page);
        this.confirmed.add(packet.id);
        this.deferred.delete(packet.id);
        if (this.inFlight?.id === packet.id) this.inFlight = undefined;
        const confirmedBytes = this.ledger.uniqueSourceBytes - before;
        this.log("context-packet-confirmed", {
          snapshot: this.prepared.snapshot,
          run: process.env.GITHUB_RUN_ID,
          attempt: process.env.GITHUB_RUN_ATTEMPT,
          packet: packet.id,
          confirmedBytes,
          repeatedBytes: packet.sourceBytes - confirmedBytes,
          inherited: !this.attempted.has(packet.id),
          missingPaths: this.ledger.inspection.missingPaths,
        });
      }
    });
    this.refreshOperation = result.catch(() => undefined);
    return result;
  }

  async boundary(): Promise<boolean> {
    const wasSweeping = this.needsBoundary;
    await this.refresh();
    const packet = this.inFlight;
    if (packet !== undefined) {
      this.inFlight = undefined;
      this.deferred.add(packet.id);
      this.log("context-packet-unconfirmed", {
        snapshot: this.prepared.snapshot,
        run: process.env.GITHUB_RUN_ID,
        attempt: process.env.GITHUB_RUN_ATTEMPT,
        packet: packet.id,
        unreadBytes: packet.sourceBytes,
        fallback: "paged tools",
      });
    }
    this.packetBoundaryPending = false;
    return wasSweeping || this.needsBoundary;
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
      "advance_review_context",
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
