import { randomUUID } from "node:crypto";
const MAX_DIAGNOSTIC_LINE_LENGTH = 8_000;
const MAX_DIAGNOSTIC_STRING_LENGTH = 2_048;
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 20;
const MAX_DIAGNOSTIC_OBJECT_NODES = 100;
const MAX_DIAGNOSTIC_DEPTH = 6;
const MAX_DIAGNOSTIC_CAUSE_DEPTH = 5;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|private[-_ ]?key|secret|signature|token|api[-_ ]?key|query|variables|request[-_ ]?body|response[-_ ]?body|body|headers?|prompt|content|text)/iu;
const SAFE_METADATA_KEYS = new Set([
    "content_length",
    "content_type",
    "status_text",
    "text_length",
]);
const URL_KEY = /(?:^|[-_])(?:url|uri|route|location)$/iu;
const SAFE_RESPONSE_HEADERS = new Set([
    "content-length",
    "content-type",
    "retry-after",
    "x-accepted-github-permissions",
    "x-accepted-oauth-scopes",
    "x-github-request-id",
    "x-oauth-scopes",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-ratelimit-resource",
    "x-ratelimit-used",
]);
let fallbackOperationId = 0;
const safeDiagnosticMessages = new WeakMap();
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isObjectLike(value) {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}
function snapshotContext(context) {
    const snapshot = {};
    if (context === undefined)
        return snapshot;
    try {
        for (const key of Object.keys(context)) {
            try {
                snapshot[key] = context[key];
            }
            catch {
                snapshot[key] = "[UNSERIALIZABLE]";
            }
        }
    }
    catch {
        return snapshot;
    }
    return snapshot;
}
export function registerSafeDiagnosticError(error, message, primitiveMessages) {
    if (isObjectLike(error))
        safeDiagnosticMessages.set(error, message);
    else
        primitiveMessages?.set(error, message);
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
function redactSecret(value, secret) {
    if (secret.length < 8 && /^[A-Za-z0-9]+$/u.test(secret)) {
        const pattern = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(secret)}(?![A-Za-z0-9])`, "gu");
        return value.replace(pattern, "[REDACTED]");
    }
    return value.split(secret).join("[REDACTED]");
}
function redact(value, secrets) {
    return secrets
        .filter((secret) => secret.length > 0)
        .sort((left, right) => right.length - left.length)
        .reduce((result, secret) => redactSecret(result, secret), value);
}
function truncate(value, maxLength = MAX_DIAGNOSTIC_STRING_LENGTH) {
    if (value.length <= maxLength)
        return value;
    return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
function stripUrlQuery(value) {
    try {
        const url = new URL(value);
        return `${url.origin}${url.pathname}`;
    }
    catch {
        const query = value.search(/[?#]/u);
        return query < 0 ? value : value.slice(0, query);
    }
}
function stripEmbeddedUrlQueries(value) {
    return value.replace(/https?:\/\/[^\s"'<>]+/giu, (candidate) => stripUrlQuery(candidate));
}
function safeKey(key, secrets) {
    return truncate(redact(key, secrets), 256);
}
function isSensitiveKey(key) {
    return !SAFE_METADATA_KEYS.has(key.toLowerCase()) && SENSITIVE_KEY.test(key);
}
function project(value, secrets, state, key, depth) {
    if (key !== undefined && isSensitiveKey(key))
        return "[OMITTED]";
    if (state.nodes >= MAX_DIAGNOSTIC_OBJECT_NODES || depth > MAX_DIAGNOSTIC_DEPTH) {
        state.truncated = true;
        return "[TRUNCATED]";
    }
    state.nodes += 1;
    if (typeof value === "string") {
        const sanitized = URL_KEY.test(key ?? "")
            ? stripUrlQuery(value)
            : stripEmbeddedUrlQueries(value);
        return truncate(redact(sanitized, secrets));
    }
    if (typeof value === "bigint")
        return "[BIGINT]";
    if (typeof value !== "object" || value === null) {
        if (typeof value === "function" || typeof value === "symbol")
            return "[UNSERIALIZABLE]";
        return value;
    }
    if (state.stack.has(value))
        return "[CIRCULAR]";
    state.stack.add(value);
    try {
        if (Array.isArray(value)) {
            const output = [];
            for (let index = 0; index < value.length; index += 1) {
                if (output.length >= MAX_DIAGNOSTIC_ARRAY_ITEMS) {
                    state.truncated = true;
                    output.push("[TRUNCATED]");
                    break;
                }
                output.push(project(value[index], secrets, state, undefined, depth + 1));
            }
            return output;
        }
        const output = {};
        for (const [rawKey, child] of Object.entries(value)) {
            const childKey = safeKey(rawKey, secrets);
            if (rawKey === "response_headers") {
                if (!isRecord(child)) {
                    output[childKey] = "[OMITTED]";
                    continue;
                }
                const headers = {};
                for (const [header, headerValue] of Object.entries(child)) {
                    if (SAFE_RESPONSE_HEADERS.has(header.toLowerCase()))
                        headers[header.toLowerCase()] = project(headerValue, secrets, state, undefined, depth + 1);
                }
                output[childKey] = headers;
                continue;
            }
            if (isSensitiveKey(rawKey)) {
                output[childKey] = "[OMITTED]";
                continue;
            }
            output[childKey] = project(child, secrets, state, rawKey, depth + 1);
        }
        return output;
    }
    finally {
        state.stack.delete(value);
    }
}
function errorRecordValue(error, secrets, depth, primitiveMessages) {
    if (depth > MAX_DIAGNOSTIC_CAUSE_DEPTH)
        return "[CAUSE_DEPTH_EXCEEDED]";
    const registeredMessage = isObjectLike(error) ? safeDiagnosticMessages.get(error) : undefined;
    if (registeredMessage !== undefined) {
        const state = { nodes: 0, truncated: false, stack: new Set() };
        return project({ name: error instanceof Error ? error.name : typeof error, message: registeredMessage }, secrets, state, undefined, 0);
    }
    if (error instanceof Error) {
        const diagnosticMessage = error.diagnosticMessage;
        const message = typeof diagnosticMessage === "string" ? diagnosticMessage : error.message;
        const stack = typeof error.stack !== "string" || typeof diagnosticMessage === "string"
            ? undefined
            : error.stack;
        const record = {
            name: error.name,
            message,
            ...(stack === undefined ? {} : { stack }),
        };
        const safeErrorKeys = new Set([
            "code",
            "diagnosticMessage",
            "errno",
            "graphqlErrors",
            "name",
            "operation",
            "requiredPermission",
            "requestId",
            "status",
            "statusCode",
        ]);
        for (const [key, value] of Object.entries(error)) {
            if (safeErrorKeys.has(key))
                record[key] = value;
        }
        const cause = error.cause;
        if (cause !== undefined)
            record.cause = errorRecord(cause, secrets, depth + 1, primitiveMessages);
        const aggregate = error.errors;
        if (Array.isArray(aggregate))
            record.errors = aggregate
                .slice(0, MAX_DIAGNOSTIC_ARRAY_ITEMS)
                .map((item) => errorRecord(item, secrets, depth + 1, primitiveMessages));
        const state = { nodes: 0, truncated: false, stack: new Set() };
        return project(record, secrets, state, undefined, 0);
    }
    const state = { nodes: 0, truncated: false, stack: new Set() };
    return project({
        name: typeof error,
        message: primitiveMessages?.get(error) ?? (error === undefined ? "undefined" : "[UNSERIALIZABLE]"),
    }, secrets, state, undefined, 0);
}
function errorRecord(error, secrets, depth = 0, primitiveMessages) {
    try {
        return errorRecordValue(error, secrets, depth, primitiveMessages);
    }
    catch {
        return "[UNSERIALIZABLE]";
    }
}
function isCancellation(error) {
    try {
        if (!isRecord(error) && !(error instanceof Error))
            return false;
        const name = error instanceof Error ? error.name : error.name;
        const message = error instanceof Error
            ? error.message
            : typeof error.message === "string"
                ? error.message
                : "";
        return (name === "AbortError" ||
            name === "CancellationError" ||
            /\b(cancelled|aborted)\b/iu.test(message));
    }
    catch {
        return false;
    }
}
function correlationFields(value) {
    if (!isRecord(value))
        return {};
    const fields = {};
    for (const key of ["component", "phase", "operation", "operation_id", "outcome"]) {
        if (typeof value[key] === "string")
            fields[key] = truncate(value[key], 256);
    }
    return fields;
}
function serialized(value, secrets, identity) {
    const state = { nodes: 0, truncated: false, stack: new Set() };
    let projected;
    try {
        projected = project(value, secrets, state, undefined, 0);
    }
    catch {
        projected = "[UNSERIALIZABLE]";
    }
    let result;
    try {
        const serializedValue = JSON.stringify(projected);
        result = typeof serializedValue === "string" ? serializedValue : "null";
    }
    catch {
        result = JSON.stringify("[UNSERIALIZABLE]");
    }
    if (result.length <= MAX_DIAGNOSTIC_LINE_LENGTH)
        return result;
    if (isRecord(projected)) {
        const { details, ...base } = projected;
        const retainedDetails = {
            truncated: true,
            original_length: result.length,
        };
        if (isRecord(details)) {
            for (const key of [
                "status",
                "status_text",
                "response_bytes",
                "request_id",
                "required_permission",
            ]) {
                if (Object.hasOwn(details, key))
                    retainedDetails[key] = details[key];
            }
            if (Object.hasOwn(details, "graphql_errors"))
                retainedDetails.graphql_errors = "[TRUNCATED]";
            if (isRecord(details.error)) {
                const error = {};
                for (const key of [
                    "name",
                    "message",
                    "operation",
                    "status",
                    "requestId",
                    "requiredPermission",
                    "diagnosticMessage",
                ]) {
                    if (Object.hasOwn(details.error, key))
                        error[key] = details.error[key];
                }
                if (Object.hasOwn(details.error, "graphqlErrors"))
                    error.graphqlErrors = "[TRUNCATED]";
                if (Object.keys(error).length > 0)
                    retainedDetails.error = error;
            }
        }
        const fallback = JSON.stringify({
            ...base,
            details: retainedDetails,
        });
        if (fallback.length <= MAX_DIAGNOSTIC_LINE_LENGTH)
            return fallback;
    }
    const correlation = { ...correlationFields(identity), ...correlationFields(projected) };
    return JSON.stringify({
        schema_version: 1,
        event: "diagnostic.truncated",
        ...correlation,
        truncated: true,
        original_length: result.length,
    });
}
export class DiagnosticLogger {
    component;
    context;
    write;
    now;
    id;
    secrets = new Set();
    primitiveDiagnosticMessages = new Map();
    constructor(options) {
        this.component = options.component;
        this.context = snapshotContext(options.context);
        this.write =
            options.write ??
                ((line) => {
                    console.log(line);
                });
        this.now = options.now ?? (() => new Date());
        this.id = options.id ?? randomUUID;
        this.addSecrets(options.secrets ?? []);
    }
    addSecrets(secrets) {
        for (const secret of secrets)
            if (secret.length > 0)
                this.secrets.add(secret);
    }
    registerSafeDiagnosticError(error, message) {
        registerSafeDiagnosticError(error, message, this.primitiveDiagnosticMessages);
    }
    event(event, descriptor, outcome, operationId, details, elapsedMs) {
        try {
            const component = descriptor.component ?? this.component;
            const payload = {
                ...this.context,
                schema_version: 1,
                timestamp: this.timestamp(),
                event,
                component,
                phase: descriptor.phase,
                operation: descriptor.operation,
                purpose: descriptor.purpose,
                operation_id: operationId,
                outcome,
                ...(elapsedMs === undefined ? {} : { elapsed_ms: Math.max(0, Math.round(elapsedMs)) }),
                ...(details === undefined ? {} : { details }),
            };
            const line = `[ai-pr-reviewer][${component}] ${serialized(payload, [...this.secrets], {
                component,
                phase: descriptor.phase,
                operation: descriptor.operation,
                operation_id: operationId,
                outcome,
            })}`;
            this.write(line);
        }
        catch {
            // Diagnostics must not change the action result.
        }
    }
    start(descriptor, details) {
        let operationId;
        try {
            const candidate = this.id();
            operationId =
                typeof candidate === "string" && candidate.length > 0
                    ? candidate
                    : `fallback-${++fallbackOperationId}`;
        }
        catch {
            operationId = `fallback-${++fallbackOperationId}`;
        }
        const started = this.milliseconds();
        let finished = false;
        this.event("operation.started", descriptor, "started", operationId, details);
        const finish = (outcome, terminalDetails, error, hasError = false) => {
            if (finished)
                return;
            finished = true;
            const detailsWithError = !hasError
                ? terminalDetails
                : {
                    ...(isRecord(terminalDetails) ? terminalDetails : {}),
                    error: errorRecord(error, [...this.secrets], 0, this.primitiveDiagnosticMessages),
                };
            const event = outcome === "success"
                ? "operation.succeeded"
                : outcome === "cancelled"
                    ? "operation.cancelled"
                    : outcome === "skipped"
                        ? "operation.skipped"
                        : "operation.finished";
            this.event(event, descriptor, outcome, operationId, detailsWithError, this.milliseconds() - started);
        };
        return {
            id: operationId,
            success: (terminalDetails) => {
                finish("success", terminalDetails);
            },
            failure: (error, terminalDetails) => {
                finish("failure", terminalDetails, error, true);
            },
            skipped: (terminalDetails) => {
                finish("skipped", terminalDetails);
            },
            cancelled: (error, terminalDetails) => {
                finish("cancelled", terminalDetails, error, error !== undefined);
            },
        };
    }
    async withSpan(descriptor, action, details) {
        const span = this.start(descriptor, details);
        try {
            const result = await action();
            span.success();
            return result;
        }
        catch (error) {
            if (isCancellation(error))
                span.cancelled(error);
            else
                span.failure(error);
            throw error;
        }
    }
    timestamp() {
        try {
            return this.now().toISOString();
        }
        catch {
            return new Date().toISOString();
        }
    }
    milliseconds() {
        try {
            const value = this.now().getTime();
            return Number.isFinite(value) ? value : Date.now();
        }
        catch {
            return Date.now();
        }
    }
}
export const diagnosticsInternals = {
    errorRecord,
    isCancellation,
    registerSafeDiagnosticError,
    serialized,
    stripUrlQuery,
    stripEmbeddedUrlQueries,
};
