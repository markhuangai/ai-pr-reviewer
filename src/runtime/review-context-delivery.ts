import type { ReviewEvidenceLedger } from "./review-assessment.js";
import type { ReviewBriefingReader } from "./review-briefing.js";
import { ReviewContextHistory } from "./review-context-history.js";
import type { ReviewContextPacket, SharedReviewContext } from "./review-context-packets.js";

export class ReviewContextDelivery {
  readonly history: ReviewContextHistory;
  private readonly confirmed = new Set<string>();
  private inFlight: ReviewContextPacket | undefined;
  private attempted = new Set<string>();
  private deferred = new Set<string>();
  private refreshOperation: Promise<void> = Promise.resolve();
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

  stage(inherited: readonly string[] = []): ReviewContextPacket | undefined {
    if (this.inFlight !== undefined) return undefined;
    const packet = this.prepared.packets.find(
      ({ id }) => !this.confirmed.has(id) && !inherited.includes(id) && !this.deferred.has(id),
    );
    if (packet === undefined) return undefined;
    this.inFlight = packet;
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

  async boundary(): Promise<void> {
    await this.refresh();
    const packet = this.inFlight;
    if (packet === undefined) return;
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
}
