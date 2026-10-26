import { errorMessage, isRecord } from "./agent-logging.js";
import { randomInt } from "node:crypto";
import type {
  SDKMessage,
  SDKActiveGoalMessage,
  SDKResultMessage,
  SDKAssistantMessageError,
} from "@anthropic-ai/claude-agent-sdk";
import { throwIfAborted } from "../lib/bootstrap/cancellation.js";

export interface ProviderFailure {
  readonly category: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly message: string;
}

export function codexProviderError(value: unknown): {
  error: SDKAssistantMessageError;
  error_status?: number | null;
} {
  const info = isRecord(value) ? value.codexErrorInfo : undefined;
  const categories: Readonly<Record<string, SDKAssistantMessageError>> = {
    unauthorized: "authentication_failed",
    usageLimitExceeded: "billing_error",
    sessionBudgetExceeded: "billing_error",
    badRequest: "invalid_request",
    contextWindowExceeded: "invalid_request",
    rateLimitExceeded: "rate_limit",
    serverOverloaded: "overloaded",
    flexUnavailable: "overloaded",
    internalServerError: "server_error",
  };
  if (typeof info === "string") return { error: categories[info] ?? "unknown" };
  for (const kind of [
    "httpConnectionFailed",
    "responseStreamConnectionFailed",
    "responseStreamDisconnected",
    "responseTooManyFailedAttempts",
  ]) {
    const details = isRecord(info) ? info[kind] : undefined;
    if (!isRecord(details)) continue;
    const status = details.httpStatusCode;
    return {
      error: "unknown",
      ...(status === null ||
      (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599)
        ? { error_status: status }
        : {}),
    };
  }
  return { error: "unknown" };
}

export class ProviderRecovery {
  private error: SDKAssistantMessageError | undefined;
  private status: number | null | undefined;
  private readonly failures = new WeakMap<SDKResultMessage, ProviderFailure>();
  retries = 0;
  private lastFailure: ProviderFailure | undefined;

  get diagnostics(): { providerRetries: number; providerErrorStatus?: number } {
    return {
      providerRetries: this.retries,
      ...(this.lastFailure?.status === undefined
        ? {}
        : { providerErrorStatus: this.lastFailure.status }),
    };
  }

  observe(message: SDKMessage | SDKActiveGoalMessage): void {
    if (message.type === "assistant") {
      this.error = message.error;
      if (message.error === undefined) this.status = undefined;
    }
    if (message.type === "system" && message.subtype === "api_retry") {
      this.error = message.error;
      this.status = message.error_status;
    }
    if (message.type !== "result") return;
    if ("codex_error" in message) {
      const final = codexProviderError(message.codex_error);
      this.error = final.error;
      this.status = final.error_status;
    }
    if (
      (message.subtype === "success" && message.is_error) ||
      (message.subtype === "error_during_execution" &&
        (this.error !== undefined || this.status !== undefined))
    ) {
      const status =
        message.subtype === "success" && message.api_error_status !== undefined
          ? message.api_error_status
          : this.status;
      const transient = ["rate_limit", "overloaded", "server_error"];
      const permanent =
        this.error !== undefined && this.error !== "unknown" && !transient.includes(this.error);
      const retryable =
        !permanent &&
        (typeof status === "number"
          ? status === 429 || (status >= 500 && status <= 599 && status !== 501 && status !== 505)
          : status === null || transient.includes(this.error ?? ""));
      this.lastFailure = {
        category: this.error ?? (status === null ? "transport_timeout" : "provider_error"),
        ...(typeof status === "number" ? { status } : {}),
        retryable,
        message:
          (message.subtype === "success" ? message.result : message.errors.join("; ")) ||
          "The model provider returned an error.",
      };
      this.failures.set(message, this.lastFailure);
    }
    this.error = undefined;
    this.status = undefined;
  }

  failure(result: SDKResultMessage): ProviderFailure | undefined {
    return this.failures.get(result);
  }

  retryDelay(failure: ProviderFailure): number | undefined {
    if (!failure.retryable || this.retries >= 2) return undefined;
    this.retries += 1;
    return 120_000 * this.retries + randomInt(0, 15_001);
  }
}

export async function waitForProviderRetry(
  milliseconds: number,
  signal?: AbortSignal,
  accepted?: Promise<void>,
): Promise<void> {
  throwIfAborted(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        abort = () => {
          const reason: unknown = signal?.reason;
          reject(reason instanceof Error ? reason : new Error("Provider retry cancelled."));
        };
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(resolve, milliseconds);
      }),
      ...(accepted === undefined ? [] : [accepted]),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort !== undefined) signal?.removeEventListener("abort", abort);
  }
}

export const SDK_SESSION_HEARTBEAT_MS = 60_000;
export const SDK_SESSION_STALL_MS = 300_000;
export const SDK_INSPECTION_STALL_MS = 600_000;
export const SDK_INTERRUPT_GRACE_MS = 30_000;
export const SDK_SUBMISSION_GRACE_MS = 30_000;
export const SDK_SESSION_CLOSE_MS = 5_000;

export async function closeSdkSession(
  close: () => void | Promise<void>,
  reader: Promise<void> | undefined,
): Promise<void> {
  const closed = close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all([reader, closed]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(
            new Error(
              `SDK message reader did not stop within ${SDK_SESSION_CLOSE_MS} ms after close().`,
            ),
          );
        }, SDK_SESSION_CLOSE_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface SdkSessionActivity {
  readonly type: string;
  readonly subtype?: string;
  readonly tool?: string;
}

export interface SdkSessionStall {
  readonly recovery: number;
  readonly elapsedSinceMessageMs: number;
  readonly reason?: "silence" | "inspection";
}

export type SessionRecoveryFailure = "stall-recovery-exhausted" | "interrupt-timeout";

export interface SdkSessionClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const systemSessionClock: SdkSessionClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => {
    clearTimeout(handle);
  },
  setInterval: (callback, milliseconds) => setInterval(callback, milliseconds),
  clearInterval: (handle) => {
    clearInterval(handle);
  },
};

export interface SdkSessionMonitorOptions {
  readonly snapshot: () => Readonly<Record<string, unknown>>;
  readonly write: (event: string, details: Readonly<Record<string, unknown>>) => void;
  readonly onStall: (stall: SdkSessionStall) => void | Promise<void>;
  readonly onSubmissionDeadline?: () => void;
  readonly progress?: () => number;
  readonly onRecoveryFailure?: (reason: SessionRecoveryFailure) => void;
  readonly heartbeatMs?: number;
  readonly stallMs?: number;
  readonly clock?: SdkSessionClock;
}

export class SdkSessionMonitor {
  private readonly clock: SdkSessionClock;
  private readonly heartbeatMs: number;
  private readonly stallMs: number;
  private readonly startedAt: number;
  private lastMessageAt: number;
  private lastProgressAt: number;
  private progress: number;
  private lastActivity: SdkSessionActivity | undefined;
  private recoveries = 0;
  private heartbeatHandle: ReturnType<typeof setInterval> | undefined;
  private watchdogHandle: ReturnType<typeof setTimeout> | undefined;
  private progressHandle: ReturnType<typeof setTimeout> | undefined;
  private interruptionHandle: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private pausedAt: number | undefined;
  private submissionAccepted = false;
  private submissionHandle: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: SdkSessionMonitorOptions) {
    this.clock = options.clock ?? systemSessionClock;
    this.heartbeatMs = options.heartbeatMs ?? SDK_SESSION_HEARTBEAT_MS;
    this.stallMs = options.stallMs ?? SDK_SESSION_STALL_MS;
    if (this.heartbeatMs < 1 || this.stallMs < 1) {
      throw new RangeError("SDK session monitor intervals must be positive.");
    }
    this.startedAt = this.clock.now();
    this.lastMessageAt = this.startedAt;
    this.lastProgressAt = this.startedAt;
    this.progress = options.progress?.() ?? 0;
  }

  start(): void {
    if (this.stopped || this.heartbeatHandle !== undefined) return;
    this.heartbeatHandle = this.clock.setInterval(() => {
      this.writeHeartbeat();
    }, this.heartbeatMs);
    this.armWatchdog();
    this.armProgressWatchdog();
  }

  observe(activity: SdkSessionActivity): void {
    if (this.stopped) return;
    this.lastActivity = activity;
    this.lastMessageAt = this.clock.now();
    this.armWatchdog();
    this.observeProgress();
  }

  observeProgress(): void {
    if (this.stopped) return;
    const progress = this.options.progress?.() ?? 0;
    if (progress <= this.progress) return;
    this.progress = progress;
    this.lastProgressAt = this.clock.now();
    this.armProgressWatchdog();
  }

  pause(): void {
    if (this.stopped || this.pausedAt !== undefined) return;
    this.pausedAt = this.clock.now();
    if (this.watchdogHandle !== undefined) this.clock.clearTimeout(this.watchdogHandle);
    if (this.progressHandle !== undefined) this.clock.clearTimeout(this.progressHandle);
  }

  resume(): void {
    if (this.stopped || this.pausedAt === undefined) return;
    this.lastMessageAt += this.clock.now() - Math.max(this.pausedAt, this.lastMessageAt);
    this.lastProgressAt += this.clock.now() - Math.max(this.pausedAt, this.lastProgressAt);
    this.pausedAt = undefined;
    this.armWatchdog();
    this.armProgressWatchdog();
  }

  interruptedTurnFinished(): void {
    if (this.interruptionHandle === undefined) return;
    this.clock.clearTimeout(this.interruptionHandle);
    this.interruptionHandle = undefined;
    this.pausedAt = undefined;
    this.lastMessageAt = this.clock.now();
    this.lastProgressAt = this.clock.now();
    this.armWatchdog();
    this.armProgressWatchdog();
  }

  acceptSubmission(): void {
    if (this.stopped || this.submissionAccepted) return;
    this.submissionAccepted = true;
    if (this.watchdogHandle !== undefined) this.clock.clearTimeout(this.watchdogHandle);
    if (this.progressHandle !== undefined) this.clock.clearTimeout(this.progressHandle);
    if (this.interruptionHandle !== undefined) this.clock.clearTimeout(this.interruptionHandle);
    this.interruptionHandle = undefined;
    this.options.write("submission-accepted", { grace_ms: SDK_SUBMISSION_GRACE_MS });
    this.submissionHandle = this.clock.setTimeout(() => {
      this.stop();
      this.options.write("submission-deadline", { grace_ms: SDK_SUBMISSION_GRACE_MS });
      this.options.onSubmissionDeadline?.();
    }, SDK_SUBMISSION_GRACE_MS);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.heartbeatHandle !== undefined) this.clock.clearInterval(this.heartbeatHandle);
    if (this.watchdogHandle !== undefined) this.clock.clearTimeout(this.watchdogHandle);
    if (this.progressHandle !== undefined) this.clock.clearTimeout(this.progressHandle);
    if (this.interruptionHandle !== undefined) this.clock.clearTimeout(this.interruptionHandle);
    if (this.submissionHandle !== undefined) this.clock.clearTimeout(this.submissionHandle);
    this.heartbeatHandle = undefined;
    this.watchdogHandle = undefined;
  }

  get recoveryCount(): number {
    return this.recoveries;
  }

  private details(now = this.clock.now(), timingFirst = false): Readonly<Record<string, unknown>> {
    const snapshot = this.options.snapshot();
    const timing = {
      elapsed_session_ms: Math.max(0, now - this.startedAt),
      elapsed_since_sdk_message_ms: Math.max(0, now - this.lastMessageAt),
      elapsed_since_inspection_progress_ms: Math.max(0, now - this.lastProgressAt),
      last_sdk_message_type: this.lastActivity?.type ?? "none",
      ...(this.lastActivity?.subtype === undefined
        ? {}
        : { last_sdk_message_subtype: this.lastActivity.subtype }),
      ...(this.lastActivity?.tool === undefined ? {} : { last_tool: this.lastActivity.tool }),
      stall_recoveries: this.recoveries,
    };
    return timingFirst ? { ...timing, ...snapshot } : { ...snapshot, ...timing };
  }

  private writeHeartbeat(): void {
    if (this.stopped) return;
    this.options.write("heartbeat", this.details());
  }

  private armWatchdog(): void {
    if (this.stopped || this.submissionAccepted || this.pausedAt !== undefined) return;
    if (this.watchdogHandle !== undefined) this.clock.clearTimeout(this.watchdogHandle);
    this.watchdogHandle = this.clock.setTimeout(() => {
      this.handleStall();
    }, this.stallMs);
  }

  private armProgressWatchdog(): void {
    if (
      this.stopped ||
      this.submissionAccepted ||
      this.pausedAt !== undefined ||
      this.options.progress === undefined
    )
      return;
    if (this.progressHandle !== undefined) this.clock.clearTimeout(this.progressHandle);
    this.progressHandle = this.clock.setTimeout(
      () => {
        this.handleStall("inspection");
      },
      Math.max(0, SDK_INSPECTION_STALL_MS - (this.clock.now() - this.lastProgressAt)),
    );
  }

  private handleStall(reason: "silence" | "inspection" = "silence"): void {
    if (this.stopped || this.pausedAt !== undefined) return;
    const now = this.clock.now();
    const elapsedSinceMessageMs = Math.max(0, now - this.lastMessageAt);
    if (reason === "silence" && elapsedSinceMessageMs < this.stallMs) {
      this.armWatchdog();
      return;
    }
    if (this.options.onRecoveryFailure !== undefined && this.recoveries >= 2) {
      this.stop();
      this.options.onRecoveryFailure("stall-recovery-exhausted");
      return;
    }
    this.recoveries += 1;
    const stall = { recovery: this.recoveries, elapsedSinceMessageMs, reason };
    this.options.write("stall-detected", {
      ...this.details(now, true),
      recovery: this.recoveries,
      reason,
    });
    if (this.options.onRecoveryFailure === undefined) this.armWatchdog();
    else {
      this.pause();
      this.interruptionHandle = this.clock.setTimeout(() => {
        this.stop();
        this.options.onRecoveryFailure?.("interrupt-timeout");
      }, SDK_INTERRUPT_GRACE_MS);
    }
    void Promise.resolve()
      .then(() => this.options.onStall(stall))
      .catch((error: unknown) => {
        this.options.write("stall-handler-failed", {
          recovery: stall.recovery,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

export interface ReviewSessionRecoveryMonitorOptions {
  readonly snapshot: () => Readonly<Record<string, unknown>>;
  readonly write: (event: string, details: Readonly<Record<string, unknown>>) => void;
  readonly hasAcceptedSubmission: () => boolean;
  readonly setPhase: (phase: string) => void;
  readonly finishAcceptedInput: () => void;
  readonly markBoundaryPending: () => void;
  readonly interrupt: () => Promise<unknown>;
  readonly finalizeAcceptedSubmission: () => void;
  readonly progress: () => number;
  readonly onRecoveryFailure: (reason: SessionRecoveryFailure) => void;
}

export function createReviewSessionRecoveryMonitor(
  options: ReviewSessionRecoveryMonitorOptions,
): SdkSessionMonitor {
  let finalizing = false;
  const recover = (stall?: SdkSessionStall): void => {
    if (finalizing) return;
    const submissionAccepted = options.hasAcceptedSubmission();
    options.setPhase(submissionAccepted ? "finalizing-submission" : "interrupting-stalled-turn");
    const details = {
      recovery: stall?.recovery ?? 0,
      ...(stall === undefined ? {} : { elapsed_since_sdk_message_ms: stall.elapsedSinceMessageMs }),
      submission_accepted: submissionAccepted,
    };
    options.write("interrupt-started", details);
    if (submissionAccepted) {
      finalizing = true;
      options.finishAcceptedInput();
      options.finalizeAcceptedSubmission();
    } else options.markBoundaryPending();
    void Promise.resolve()
      .then(options.interrupt)
      .then((receipt) => {
        const stillQueued =
          isRecord(receipt) && Array.isArray(receipt.still_queued)
            ? receipt.still_queued.length
            : undefined;
        options.write("interrupt-finished", {
          recovery: details.recovery,
          ...(stillQueued === undefined ? {} : { still_queued: stillQueued }),
        });
      })
      .catch((error: unknown) => {
        options.write("interrupt-failed", {
          recovery: details.recovery,
          error: errorMessage(error),
        });
      });
  };
  return new SdkSessionMonitor({
    snapshot: options.snapshot,
    write: options.write,
    onStall: recover,
    onSubmissionDeadline: recover,
    progress: options.progress,
    onRecoveryFailure: options.onRecoveryFailure,
  });
}
