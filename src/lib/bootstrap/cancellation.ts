const CANCELLATION_MESSAGE_TYPE = "ai-pr-reviewer.cancel";

export class CancellationError extends Error {
  constructor(readonly processSignal?: NodeJS.Signals) {
    super(
      processSignal === undefined
        ? "The pull request review was cancelled."
        : `The pull request review was cancelled by ${processSignal}.`,
    );
    this.name = "CancellationError";
  }
}

interface CancellationMessage {
  readonly type: typeof CANCELLATION_MESSAGE_TYPE;
  readonly processSignal?: NodeJS.Signals;
}

function isProcessSignal(value: unknown): value is NodeJS.Signals {
  return value === "SIGINT" || value === "SIGTERM" || value === "SIGBREAK";
}

function cancellationMessage(value: unknown): CancellationMessage {
  const processSignal = value instanceof CancellationError ? value.processSignal : undefined;
  return {
    type: CANCELLATION_MESSAGE_TYPE,
    ...(processSignal === undefined ? {} : { processSignal }),
  };
}

function readCancellationMessage(value: unknown): CancellationError | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (message.type !== CANCELLATION_MESSAGE_TYPE) return undefined;
  return new CancellationError(
    isProcessSignal(message.processSignal) ? message.processSignal : undefined,
  );
}

export interface CancellationHandlers {
  readonly controller: AbortController;
  dispose(): void;
}

export function installCancellationHandlers(
  controller = new AbortController(),
): CancellationHandlers {
  const processSignals: readonly NodeJS.Signals[] = [
    "SIGINT",
    "SIGTERM",
    ...(process.platform === "win32" ? (["SIGBREAK"] as const) : []),
  ];
  let listening = true;
  const handlers = new Map<NodeJS.Signals, () => void>();

  const dispose = (): void => {
    if (!listening) return;
    listening = false;
    for (const [processSignal, handler] of handlers) process.off(processSignal, handler);
    process.off("message", receiveMessage);
  };
  const cancel = (reason: CancellationError): void => {
    if (controller.signal.aborted) return;
    dispose();
    controller.abort(reason);
  };
  const receiveMessage = (value: unknown): void => {
    const reason = readCancellationMessage(value);
    if (reason !== undefined) cancel(reason);
  };

  for (const processSignal of processSignals) {
    const handler = (): void => {
      cancel(new CancellationError(processSignal));
    };
    handlers.set(processSignal, handler);
    process.once(processSignal, handler);
  }
  if (typeof process.send === "function") process.on("message", receiveMessage);
  if (controller.signal.aborted) dispose();

  return { controller, dispose };
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

export function cancellationReason(signal: AbortSignal | undefined): Error {
  if (!signal?.aborted) return new CancellationError();
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new CancellationError();
}

export const cancellationInternals = {
  cancellationMessage,
  readCancellationMessage,
};
