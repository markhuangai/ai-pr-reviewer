const CANCELLATION_MESSAGE_TYPE = "ai-pr-reviewer.cancel";
export class CancellationError extends Error {
    processSignal;
    constructor(processSignal) {
        super(processSignal === undefined
            ? "The pull request review was cancelled."
            : `The pull request review was cancelled by ${processSignal}.`);
        this.processSignal = processSignal;
        this.name = "CancellationError";
    }
}
function isProcessSignal(value) {
    return value === "SIGINT" || value === "SIGTERM" || value === "SIGBREAK";
}
function cancellationMessage(value) {
    const processSignal = value instanceof CancellationError ? value.processSignal : undefined;
    return {
        type: CANCELLATION_MESSAGE_TYPE,
        ...(processSignal === undefined ? {} : { processSignal }),
    };
}
function readCancellationMessage(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    const message = value;
    if (message.type !== CANCELLATION_MESSAGE_TYPE)
        return undefined;
    return new CancellationError(isProcessSignal(message.processSignal) ? message.processSignal : undefined);
}
export function installCancellationHandlers(controller = new AbortController()) {
    const processSignals = [
        "SIGINT",
        "SIGTERM",
        ...(process.platform === "win32" ? ["SIGBREAK"] : []),
    ];
    let listening = true;
    const handlers = new Map();
    const dispose = () => {
        if (!listening)
            return;
        listening = false;
        for (const [processSignal, handler] of handlers)
            process.off(processSignal, handler);
        process.off("message", receiveMessage);
    };
    const cancel = (reason) => {
        if (controller.signal.aborted)
            return;
        dispose();
        controller.abort(reason);
    };
    const receiveMessage = (value) => {
        const reason = readCancellationMessage(value);
        if (reason !== undefined)
            cancel(reason);
    };
    for (const processSignal of processSignals) {
        const handler = () => {
            cancel(new CancellationError(processSignal));
        };
        handlers.set(processSignal, handler);
        process.once(processSignal, handler);
    }
    if (typeof process.send === "function")
        process.on("message", receiveMessage);
    if (controller.signal.aborted)
        dispose();
    return { controller, dispose };
}
export function throwIfAborted(signal) {
    signal?.throwIfAborted();
}
export function cancellationReason(signal) {
    if (!signal?.aborted)
        return new CancellationError();
    const reason = signal.reason;
    return reason instanceof Error ? reason : new CancellationError();
}
export const cancellationInternals = {
    cancellationMessage,
    readCancellationMessage,
};
