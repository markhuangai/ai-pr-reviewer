import { parseDocument } from "yaml";

import type {
  AuthMode,
  HttpMcpServer,
  McpToolPolicy,
  ModelPricingConfig,
  ModelPricingRates,
  ReviewConfig,
} from "./types.js";

export interface InputReader {
  get(name: string): string;
}

const MAX_PROMPTS = 50;
const MAX_PROMPT_LENGTH = 12_000;
const MAX_MCP_SERVERS = 20;
const MAX_MCP_HEADERS = 50;
const MAX_PRICED_MODELS = 100;
const MAX_MODEL_NAME_LENGTH = 500;
const MAX_CURRENCY_LENGTH = 32;

function required(value: string, name: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`Input '${name}' is required.`);
  }
  return trimmed;
}

function parseInteger(value: string, name: string, min: number, max: number): number {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Input '${name}' must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function parseBoolean(value: string, name: string, defaultValue: boolean): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return defaultValue;
  if (trimmed.toLowerCase() === "true") return true;
  if (trimmed.toLowerCase() === "false") return false;
  throw new Error(`Input '${name}' must be 'true' or 'false'.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new Error(`${path} must not exceed ${maxLength} characters.`);
  }
  return trimmed;
}

function readOptionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean.`);
  return value;
}

function readOptionalInteger(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${path} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function readUrl(value: unknown, path: string, requireHttps = false): string {
  const text = readString(value, path, 2_000);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${path} must be an absolute HTTP(S) URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${path} must use http:// or https://.`);
  }
  if (requireHttps && url.protocol !== "https:") {
    throw new Error(`${path} must use https://.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${path} must not contain URL credentials.`);
  }
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function parseHeaders(value: unknown, path: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`${path} must be a mapping.`);
  const entries = Object.entries(value);
  if (entries.length > MAX_MCP_HEADERS) throw new Error(`${path} has too many headers.`);
  const headers: Record<string, string> = {};
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key)) {
      throw new Error(`${path}.${key} is not a valid HTTP header name.`);
    }
    headers[key] = readString(raw, `${path}.${key}`, 4_096);
  }
  return headers;
}

export function inputSecretCandidates(reader: InputReader): readonly string[] {
  return Array.from(
    new Set(
      [reader.get("github-pat"), reader.get("ai-secret"), reader.get("ai-base-url")]
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function authorizationCredential(name: string, value: string): string | undefined {
  const normalizedName = name.toLowerCase();
  if (normalizedName !== "authorization" && normalizedName !== "proxy-authorization") {
    return undefined;
  }
  return /^[A-Za-z][A-Za-z0-9+.-]*\s+(.+)$/u.exec(value)?.[1]?.trim();
}

function endpointQuerySecretCandidates(value: string): readonly string[] {
  const url = new URL(value);
  return url.search
    .slice(1)
    .split("&")
    .flatMap((entry) => {
      const separator = entry.indexOf("=");
      if (separator === -1) return [];
      const rawValue = entry.slice(separator + 1);
      const parameter = new URLSearchParams(entry).entries().next().value;
      if (parameter === undefined) return [];
      const [name, decodedValue] = parameter;
      const normalizedName = name.replace(/([a-z0-9])([A-Z])/gu, "$1-$2");
      if (
        !/(?:^|[-_.])(?:access[-_.]?key|api[-_.]?key|auth(?:orization)?|credential|key|passw(?:or)?d|secret|signature|sig|token)(?:$|[-_.])/iu.test(
          normalizedName,
        )
      ) {
        return [];
      }
      return [rawValue, decodedValue].filter((candidate) => candidate.length > 0);
    });
}

function jsonSecretCandidate(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export function reviewSecretCandidates(config: ReviewConfig): readonly string[] {
  const servers = Object.values(config.mcpServers);
  const endpoints = [config.aiBaseUrl, ...servers.map((server) => server.url)];
  const candidates = [
    config.githubToken,
    config.aiSecret,
    ...endpoints,
    ...endpoints.flatMap(endpointQuerySecretCandidates),
    ...servers.flatMap((server) =>
      Object.entries(server.headers ?? {}).flatMap(([name, value]) => [
        value,
        authorizationCredential(name, value) ?? "",
      ]),
    ),
  ].filter((value) => value.length > 0);
  return Array.from(
    new Set(candidates.flatMap((candidate) => [candidate, jsonSecretCandidate(candidate)])),
  );
}

function parseToolPolicies(value: unknown, path: string): readonly McpToolPolicy[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be a sequence.`);
  if (value.length > 100) throw new Error(`${path} has too many tool policies.`);
  return value.map((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) throw new Error(`${itemPath} must be a mapping.`);
    const allowed = new Set(["name", "permission_policy", "org_max_permission"]);
    for (const key of Object.keys(item)) {
      if (!allowed.has(key)) throw new Error(`${itemPath}.${key} is not supported.`);
    }
    const name = readString(item.name, `${itemPath}.name`, 200);
    const permission = item.permission_policy;
    if (
      permission !== undefined &&
      permission !== "always_allow" &&
      permission !== "always_ask" &&
      permission !== "always_deny"
    ) {
      throw new Error(`${itemPath}.permission_policy is invalid.`);
    }
    const orgPermission = item.org_max_permission;
    if (
      orgPermission !== undefined &&
      orgPermission !== "allow" &&
      orgPermission !== "ask" &&
      orgPermission !== "blocked"
    ) {
      throw new Error(`${itemPath}.org_max_permission is invalid.`);
    }
    return {
      name,
      ...(permission === undefined ? {} : { permission_policy: permission }),
      ...(orgPermission === undefined ? {} : { org_max_permission: orgPermission }),
    };
  });
}

function parseMcpServers(raw: string): Readonly<Record<string, HttpMcpServer>> {
  if (raw.trim().length === 0) return {};
  const document = parseDocument(raw, { prettyErrors: true, uniqueKeys: true, version: "1.2" });
  if (document.errors.length > 0) {
    throw new Error("Input 'mcp-servers' is invalid YAML.");
  }
  const value = document.toJS() as unknown;
  if (!isRecord(value)) throw new Error("Input 'mcp-servers' must be a mapping of server names.");
  const serverEntries = Object.entries(value);
  if (serverEntries.length > MAX_MCP_SERVERS)
    throw new Error("Input 'mcp-servers' has too many servers.");
  const servers: Record<string, HttpMcpServer> = {};
  for (const [name, rawServer] of serverEntries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      throw new Error(`mcp-servers.${name} is not a valid server name.`);
    }
    if (name === "review_output") {
      throw new Error("mcp-servers.review_output is reserved for the internal review output tool.");
    }
    if (!isRecord(rawServer)) throw new Error(`mcp-servers.${name} must be a mapping.`);
    const allowed = new Set(["type", "url", "headers", "tools", "timeout", "alwaysLoad"]);
    for (const key of Object.keys(rawServer)) {
      if (!allowed.has(key))
        throw new Error(`mcp-servers.${name}.${key} is not supported; only HTTP MCP is allowed.`);
    }
    if (rawServer.type !== "http") {
      throw new Error(
        `mcp-servers.${name}.type must be 'http'; stdio and SSE servers are disabled.`,
      );
    }
    const url = readUrl(rawServer.url, `mcp-servers.${name}.url`, true);
    const headers = parseHeaders(rawServer.headers, `mcp-servers.${name}.headers`);
    const tools = parseToolPolicies(rawServer.tools, `mcp-servers.${name}.tools`);
    const timeout = readOptionalInteger(
      rawServer.timeout,
      `mcp-servers.${name}.timeout`,
      1_000,
      300_000,
    );
    const alwaysLoad = readOptionalBoolean(rawServer.alwaysLoad, `mcp-servers.${name}.alwaysLoad`);
    servers[name] = {
      type: "http",
      url,
      ...(headers === undefined ? {} : { headers }),
      ...(tools === undefined ? {} : { tools }),
      ...(timeout === undefined ? {} : { timeout }),
      ...(alwaysLoad === undefined ? {} : { alwaysLoad }),
    };
  }
  return servers;
}

function parseReviewPrompts(raw: string): readonly string[] {
  const value = raw.trim();
  if (value.length === 0)
    throw new Error("Input 'review-prompts' must contain at least one prompt.");
  let prompts: unknown;
  try {
    prompts = JSON.parse(value) as unknown;
  } catch {
    prompts = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
  if (!Array.isArray(prompts) || prompts.length === 0) {
    throw new Error("Input 'review-prompts' must be a JSON string array or one prompt per line.");
  }
  if (prompts.length > MAX_PROMPTS)
    throw new Error(`Input 'review-prompts' supports at most ${MAX_PROMPTS} prompts.`);
  return prompts.map((prompt, index) =>
    readString(prompt, `review-prompts[${index}]`, MAX_PROMPT_LENGTH),
  );
}

function parseModelPricing(raw: string): ModelPricingConfig | undefined {
  if (raw.trim().length === 0) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Input 'model-pricing' must be valid JSON.");
  }
  const duplicateCheck = parseDocument(raw, {
    prettyErrors: false,
    schema: "json",
    uniqueKeys: true,
    version: "1.2",
  });
  if (duplicateCheck.errors.length > 0) {
    throw new Error("Input 'model-pricing' must be valid JSON with unique object keys.");
  }
  if (!isRecord(value)) throw new Error("Input 'model-pricing' must be a JSON object.");

  const rootKeys = new Set(["currency", "models"]);
  for (const key of Object.keys(value)) {
    if (!rootKeys.has(key)) throw new Error(`model-pricing.${key} is not supported.`);
  }
  if (typeof value.currency !== "string" || value.currency.length === 0) {
    throw new Error("model-pricing.currency must be a non-empty string.");
  }
  if (value.currency.length > MAX_CURRENCY_LENGTH) {
    throw new Error(`model-pricing.currency must not exceed ${MAX_CURRENCY_LENGTH} characters.`);
  }
  if (!isRecord(value.models)) throw new Error("model-pricing.models must be an object.");

  const modelEntries = Object.entries(value.models);
  if (modelEntries.length === 0) {
    throw new Error("model-pricing.models must contain at least one model.");
  }
  if (modelEntries.length > MAX_PRICED_MODELS) {
    throw new Error(`model-pricing.models supports at most ${MAX_PRICED_MODELS} models.`);
  }

  const models = Object.create(null) as Record<string, ModelPricingRates>;
  const rateKeys = new Set(["input", "output", "cache-hit", "cache-creation"]);
  for (const [model, rawRates] of modelEntries) {
    const modelPath = `model-pricing.models[${JSON.stringify(model)}]`;
    if (model.trim().length === 0) {
      throw new Error("model-pricing.models keys must be non-empty model identifiers.");
    }
    if (model.length > MAX_MODEL_NAME_LENGTH) {
      throw new Error(
        `model-pricing.models keys must not exceed ${MAX_MODEL_NAME_LENGTH} characters.`,
      );
    }
    if (!isRecord(rawRates)) {
      throw new Error(`${modelPath} must be an object.`);
    }
    for (const key of Object.keys(rawRates)) {
      if (!rateKeys.has(key)) {
        throw new Error(`${modelPath}[${JSON.stringify(key)}] is not supported.`);
      }
    }
    const readRate = (key: string): number => {
      const rate = rawRates[key];
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) {
        throw new Error(`${modelPath}.${key} must be a finite non-negative number.`);
      }
      return rate;
    };
    models[model] = {
      input: readRate("input"),
      output: readRate("output"),
      cacheHit: readRate("cache-hit"),
      cacheCreation: readRate("cache-creation"),
    };
  }
  return { currency: value.currency, models };
}

function readAuthMode(value: string): AuthMode {
  const mode = value.trim().toLowerCase();
  if (mode === "api-key" || mode === "auth-token") return mode;
  throw new Error("Input 'ai-auth-mode' must be 'api-key' or 'auth-token'.");
}

export function readReviewConfig(reader: InputReader): ReviewConfig {
  const pullRequestUrl = reader.get("pull-request-url").trim();
  const modelPricing = parseModelPricing(reader.get("model-pricing"));
  return {
    githubToken: required(reader.get("github-pat"), "github-pat"),
    aiBaseUrl: readUrl(required(reader.get("ai-base-url"), "ai-base-url"), "ai-base-url"),
    aiSecret: required(reader.get("ai-secret"), "ai-secret"),
    aiAuthMode: readAuthMode(reader.get("ai-auth-mode") || "api-key"),
    model: required(reader.get("model"), "model"),
    ...(modelPricing === undefined ? {} : { modelPricing }),
    reviewPrompts: parseReviewPrompts(reader.get("review-prompts")),
    parallelCount: parseInteger(reader.get("parallel-count") || "5", "parallel-count", 1, 10),
    maxTurns: parseInteger(reader.get("max-turns") || "50", "max-turns", 2, 100),
    autoApprove: parseBoolean(reader.get("auto-approve"), "auto-approve", false),
    interactWithPullRequest: parseBoolean(reader.get("interact-with-pr"), "interact-with-pr", true),
    ...(pullRequestUrl.length === 0
      ? {}
      : { pullRequestUrl: readUrl(pullRequestUrl, "pull-request-url") }),
    mcpServers: parseMcpServers(reader.get("mcp-servers")),
  };
}

export const inputInternals = {
  parseMcpServers,
  parseModelPricing,
  parseReviewPrompts,
};
