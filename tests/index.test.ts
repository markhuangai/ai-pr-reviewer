import { strict as assert } from "node:assert";
import test from "node:test";

import { indexInternals } from "../src/index.js";
import type { ReviewConfig } from "../src/lib/types.js";

const config: ReviewConfig = {
  githubToken: "github-secret",
  aiBaseUrl: "https://ai.example.test/signed?token=ai-url-secret",
  aiSecret: "ai-secret",
  aiAuthMode: "api-key",
  model: "review-model",
  reviewPrompts: ["security"],
  parallelCount: 1,
  maxTurns: 2,
  autoApprove: false,
  mcpServers: {
    security: {
      type: "http",
      url: "https://mcp.example.test/review?signature=mcp-url-secret",
      headers: { Authorization: "mcp-header-secret" },
    },
  },
};

test("redaction secrets include configured AI and MCP endpoints", () => {
  const secrets = indexInternals.reviewSecrets(config);
  assert.ok(secrets.includes(config.aiBaseUrl));
  assert.ok(secrets.includes(config.mcpServers.security?.url ?? ""));
  assert.equal(
    indexInternals.redact(
      `AI failed at ${config.aiBaseUrl}; MCP failed at ${config.mcpServers.security?.url}.`,
      secrets,
    ),
    "AI failed at [REDACTED]; MCP failed at [REDACTED].",
  );
  assert.equal(
    indexInternals.redact(`${config.aiBaseUrl}/mcp?signature=leaked`, [
      config.aiBaseUrl,
      `${config.aiBaseUrl}/mcp?signature=leaked`,
    ]),
    "[REDACTED]",
  );
});
