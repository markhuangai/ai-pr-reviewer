import { randomUUID } from "node:crypto";
import type {
  SDKActiveGoalMessage,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { throwIfAborted } from "../lib/bootstrap/cancellation.js";
import { errorMessage, isRecord, sdkSessionActivity } from "./agent-logging.js";
import type { ReviewSession } from "./review-session.js";
import {
  closeSdkSession,
  ProviderRecovery,
  SdkSessionMonitor,
  waitForProviderRetry,
  type ProviderFailure,
  type SdkSessionActivity,
  type SdkSessionStall,
  type SessionRecoveryFailure,
} from "./session-recovery.js";

export function createDeferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export function makeUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: "",
  };
}

class PromptStream implements AsyncIterable<SDKUserMessage> {
  private readonly queue: SDKUserMessage[] = [];
  private readonly waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private finished = false;

  push(value: SDKUserMessage): void {
    if (this.finished) throw new Error("Cannot add input after the review session has finished.");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.queue.push(value);
  }

  finish(): void {
    this.finished = true;
    while (this.waiters.length > 0) this.waiters.shift()?.({ done: true, value: undefined });
  }

  async next(): Promise<IteratorResult<SDKUserMessage>> {
    const value = this.queue.shift();
    if (value) return { done: false, value };
    if (this.finished) return { done: true, value: undefined };
    return new Promise<IteratorResult<SDKUserMessage>>((resolve) => this.waiters.push(resolve));
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return this;
  }
}

type SessionMessage = SDKMessage | SDKActiveGoalMessage;
type SessionObserver = (message: SessionMessage, failure?: ProviderFailure) => boolean | undefined;
type TerminalTurn = {
  kind: "result";
  result: SDKResultMessage;
  providerFailure: ProviderFailure | undefined;
  interrupted: boolean;
};
type TerminalProviderFailure = {
  failure: ProviderFailure;
  subtype: SDKResultMessage["subtype"];
};
type SessionStop =
  { kind: "accepted-after-grace" } | { kind: "recovery-failed"; reason: SessionRecoveryFailure };

interface SessionRunnerOptions {
  readonly signal?: AbortSignal | undefined;
  readonly streamEnded: string;
  readonly write: (event: string, details: Readonly<Record<string, unknown>>) => void;
  readonly watchdog?: {
    readonly kind: "review" | "resolution";
    readonly snapshot: () => Readonly<Record<string, unknown>>;
    readonly activity?: (message: SessionMessage) => SdkSessionActivity;
    readonly progress?: () => number;
  };
  readonly deadline?: {
    readonly controller: AbortController;
    readonly milliseconds: number;
    readonly reason: Error;
  };
}

const TURN_READY = Symbol("turn ready");

export class SessionRunner {
  readonly prompts = new PromptStream();
  phase = "starting";
  private readonly signal: AbortSignal | undefined;
  private readonly releaseDeadline: (() => void) | undefined;
  private readonly provider = new ProviderRecovery();
  private readonly accepted = createDeferred<undefined>();
  private readonly stopped = createDeferred<SessionStop>();
  private readonly turns: TerminalTurn[] = [];
  private ready = createDeferred<typeof TURN_READY>();
  private session: ReviewSession | undefined;
  private monitor: SdkSessionMonitor | undefined;
  private reader: Promise<void> | undefined;
  private readerError: Error | undefined;
  private providerFailureAfterAcceptance: TerminalProviderFailure | undefined;
  private shutdown: Promise<void> | undefined;
  private shutdownConfirmed = false;
  private outputAccepted = false;
  private expectedClose = false;
  private awaitingBoundary = false;
  private graceExpired = false;

  constructor(private readonly options: SessionRunnerOptions) {
    const deadline = options.deadline;
    this.signal = deadline?.controller.signal ?? options.signal;
    if (deadline !== undefined) {
      const forwardAbort = () => {
        deadline.controller.abort(options.signal?.reason);
      };
      options.signal?.addEventListener("abort", forwardAbort, { once: true });
      if (options.signal?.aborted) forwardAbort();
      const timer = setTimeout(() => {
        deadline.controller.abort(deadline.reason);
      }, deadline.milliseconds);
      this.releaseDeadline = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", forwardAbort);
      };
    }
    this.signal?.addEventListener("abort", this.cancel, { once: true });
    if (this.signal?.aborted) this.cancel();
  }

  get recoveryCount(): number {
    return this.monitor?.recoveryCount ?? 0;
  }

  get awaitingInterruptedTurn(): boolean {
    return this.awaitingBoundary;
  }

  get providerDiagnostics(): ProviderRecovery["diagnostics"] {
    return this.provider.diagnostics;
  }

  get hasSession(): boolean {
    return this.session !== undefined;
  }

  get closed(): boolean {
    return this.shutdownConfirmed;
  }

  get readerFailure(): Error | undefined {
    return this.readerError;
  }

  get acceptedProviderFailure(): TerminalProviderFailure | undefined {
    return this.providerFailureAfterAcceptance;
  }

  start(
    createSession: (prompt: AsyncIterable<SDKUserMessage>) => ReviewSession,
    observe: SessionObserver,
  ): ReviewSession {
    throwIfAborted(this.signal);
    const session = createSession(this.prompts);
    this.session = session;
    const watchdog = this.options.watchdog;
    if (watchdog !== undefined) {
      this.monitor = new SdkSessionMonitor({
        snapshot: watchdog.snapshot,
        write: this.options.write,
        ...(watchdog.progress === undefined ? {} : { progress: watchdog.progress }),
        ...(watchdog.kind === "review"
          ? {
              onRecoveryFailure: (reason: SessionRecoveryFailure) => {
                this.stopped.resolve({ kind: "recovery-failed", reason });
              },
            }
          : {}),
        onStall: (stall) => {
          this.recover(stall);
        },
        onSubmissionDeadline: () => {
          this.recover();
        },
      });
      this.monitor.start();
      if (this.outputAccepted) this.monitor.acceptSubmission();
    }
    this.phase = "waiting-for-sdk-message";
    this.reader = this.consume(session, observe);
    return session;
  }

  acceptOutput(): void {
    if (this.outputAccepted) return;
    this.outputAccepted = true;
    this.accepted.resolve(undefined);
    this.monitor?.acceptSubmission();
  }

  observeProgress(): void {
    this.monitor?.observeProgress();
  }

  rebaseProgress(): void {
    this.monitor?.rebaseProgress();
  }

  async waitForTurn<T = never>(wake?: Promise<T>): Promise<TerminalTurn | SessionStop | T> {
    const next = await Promise.race([
      this.ready.promise,
      this.stopped.promise,
      ...(wake === undefined ? [] : [wake]),
    ]);
    throwIfAborted(this.signal);
    if (next !== TURN_READY) return next;
    const turn = this.turns.shift();
    if (turn === undefined) throw new Error("The session has no pending terminal result.");
    if (this.turns.length === 0) this.ready = createDeferred<typeof TURN_READY>();
    return turn;
  }

  async interruptAndWait(): Promise<TerminalTurn | SessionStop> {
    void this.interrupt().catch((error: unknown) => {
      this.stopped.reject(error);
    });
    return this.waitForTurn();
  }

  async retry(
    failure: ProviderFailure,
  ): Promise<"retry" | "provider-error" | "provider-retries-exhausted"> {
    throwIfAborted(this.signal);
    const delay = this.outputAccepted ? undefined : this.provider.retryDelay(failure);
    if (delay === undefined)
      return failure.retryable && !this.outputAccepted
        ? "provider-retries-exhausted"
        : "provider-error";
    this.phase = "waiting-for-provider-retry";
    this.monitor?.pause();
    this.options.write("provider-retry", {
      retry: this.provider.retries,
      max_retries: 2,
      retry_delay_ms: delay,
      error_status: failure.status,
      error: failure.category,
    });
    await waitForProviderRetry(delay, this.signal, this.accepted.promise);
    throwIfAborted(this.signal);
    this.monitor?.resume();
    return this.outputAccepted ? "provider-error" : "retry";
  }

  async finish<T>(beforeClose: () => Promise<T>): Promise<T> {
    this.monitor?.stop();
    const value = await beforeClose();
    await this.close();
    throwIfAborted(this.signal);
    return value;
  }

  async close(): Promise<void> {
    this.monitor?.stop();
    this.expectedClose = true;
    this.prompts.finish();
    this.shutdown ??= closeSdkSession(() => this.session?.close(), this.reader).then(() => {
      this.shutdownConfirmed = true;
    });
    await this.shutdown;
    if (this.readerError !== undefined) throw this.readerError;
  }

  dispose(): void {
    this.monitor?.stop();
    this.signal?.removeEventListener("abort", this.cancel);
    this.releaseDeadline?.();
  }

  private readonly cancel = (): void => {
    this.monitor?.stop();
    this.prompts.finish();
    this.stopped.reject(this.signal?.reason ?? new Error("The session was cancelled."));
  };

  private async consume(session: ReviewSession, observe: SessionObserver): Promise<void> {
    try {
      for await (const message of session) {
        this.provider.observe(message);
        const activity = this.options.watchdog?.activity;
        if (this.monitor !== undefined)
          this.monitor.observe(
            activity === undefined ? sdkSessionActivity(message) : activity(message),
          );
        const failure = message.type === "result" ? this.provider.failure(message) : undefined;
        if (message.type === "result" && failure !== undefined && this.outputAccepted)
          this.providerFailureAfterAcceptance ??= { failure, subtype: message.subtype };
        if (observe(message, failure) === false || message.type !== "result" || this.graceExpired)
          continue;
        if (this.outputAccepted) this.monitor?.stop();
        const interrupted = this.awaitingBoundary;
        if (interrupted) {
          this.awaitingBoundary = false;
          this.monitor?.interruptedTurnFinished();
        }
        this.turns.push({ kind: "result", result: message, providerFailure: failure, interrupted });
        this.ready.resolve(TURN_READY);
      }
      if (!this.expectedClose) this.stopped.reject(new Error(this.options.streamEnded));
    } catch (error) {
      this.readerError = error instanceof Error ? error : new Error(errorMessage(error));
      this.stopped.reject(this.readerError);
    }
  }

  private interrupt(): Promise<unknown> {
    return Promise.resolve().then(() => this.session?.interrupt());
  }

  private recover(stall?: SdkSessionStall): void {
    if (this.expectedClose || this.signal?.aborted) return;
    const recovery = stall?.recovery ?? 0;
    const accepted = this.outputAccepted;
    this.phase = accepted ? "finalizing-submission" : "interrupting-stalled-turn";
    this.options.write("interrupt-started", {
      recovery,
      ...(stall === undefined ? {} : { elapsed_since_sdk_message_ms: stall.elapsedSinceMessageMs }),
      [this.options.watchdog?.kind === "resolution" ? "verdict_accepted" : "submission_accepted"]:
        accepted,
    });
    if (accepted) {
      this.graceExpired = true;
      this.expectedClose = true;
      this.prompts.finish();
      this.stopped.resolve({ kind: "accepted-after-grace" });
    } else {
      this.awaitingBoundary = true;
      this.phase = "waiting-for-interrupted-turn-boundary";
    }
    void this.interrupt().then(
      (receipt) => {
        this.options.write("interrupt-finished", {
          recovery,
          ...(isRecord(receipt) && Array.isArray(receipt.still_queued)
            ? { still_queued: receipt.still_queued.length }
            : {}),
        });
      },
      (error: unknown) => {
        this.options.write("interrupt-failed", { recovery, error: errorMessage(error) });
      },
    );
  }
}
