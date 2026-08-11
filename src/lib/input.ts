import { parseDocument } from "yaml";

import type { AuthMode, HttpMcpServer, McpToolPolicy, ReviewConfig } from "./types.js";

export interface InputReader {
  get(name: string): string;
}

const MAX_PROMPTS = 50;
const MAX_PROMPT_LENGTH = 12_000;
const MAX_MCP_SERVERS = 20;
const MAX_MCP_HEADERS = 50;

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
  return url.toString().replace(/\/$/, "");
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
    throw new Error(
      `Input 'mcp-servers' is invalid YAML: ${document.errors[0]?.message ?? "parse error"}`,
    );
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

function readAuthMode(value: string): AuthMode {
  const mode = value.trim().toLowerCase();
  if (mode === "api-key" || mode === "auth-token") return mode;
  throw new Error("Input 'ai-auth-mode' must be 'api-key' or 'auth-token'.");
}

export function readReviewConfig(reader: InputReader): ReviewConfig {
  return {
    githubToken: required(reader.get("github-pat"), "github-pat"),
    aiBaseUrl: readUrl(required(reader.get("ai-base-url"), "ai-base-url"), "ai-base-url"),
    aiSecret: required(reader.get("ai-secret"), "ai-secret"),
    aiAuthMode: readAuthMode(reader.get("ai-auth-mode") || "api-key"),
    model: required(reader.get("model"), "model"),
    reviewPrompts: parseReviewPrompts(reader.get("review-prompts")),
    parallelCount: parseInteger(reader.get("parallel-count") || "5", "parallel-count", 1, 10),
    maxTurns: parseInteger(reader.get("max-turns") || "50", "max-turns", 1, 100),
    autoApprove: parseBoolean(reader.get("auto-approve"), "auto-approve", false),
    mcpServers: parseMcpServers(reader.get("mcp-servers")),
  };
}

export const inputInternals = {
  parseMcpServers,
  parseReviewPrompts,
};
