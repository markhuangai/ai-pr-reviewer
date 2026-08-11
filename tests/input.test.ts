import { strict as assert } from "node:assert";
import test from "node:test";

import { inputInternals, readReviewConfig } from "../src/lib/input.js";

function reader(values: Record<string, string>) {
  return { get: (name: string): string => values[name] ?? "" };
}

test("reads newline-separated goals and strict HTTP MCP configuration", () => {
  const config = readReviewConfig(
    reader({
      "github-pat": "ghp_test",
      "ai-base-url": "https://ai.example.test/v1/",
      "ai-secret": "secret",
      model: "review-model",
      "review-prompts": "first goal\n\nsecond goal",
      "mcp-servers": `
security:
  type: http
  url: https://mcp.example.test/review
  headers:
    Authorization: Bearer token
  timeout: 10000
`,
    }),
  );
  assert.deepEqual(config.reviewPrompts, ["first goal", "second goal"]);
  assert.equal(config.aiBaseUrl, "https://ai.example.test/v1");
  assert.equal(config.mcpServers.security?.type, "http");
  assert.equal(config.mcpServers.security?.headers?.Authorization, "Bearer token");
  assert.equal(
    inputInternals.parseMcpServers(
      "server:\n  type: http\n  url: https://mcp.example.test/review?tenant=foo/",
    ).server?.url,
    "https://mcp.example.test/review?tenant=foo/",
  );
});

test("accepts JSON goal arrays", () => {
  assert.deepEqual(inputInternals.parseReviewPrompts('["one", "two"]'), ["one", "two"]);
});

test("rejects unsupported MCP transports and unknown keys", () => {
  assert.throws(
    () => inputInternals.parseMcpServers("server:\n  type: stdio\n  url: https://example.test"),
    /type must be 'http'/,
  );
  assert.throws(
    () =>
      inputInternals.parseMcpServers(
        "server:\n  type: http\n  url: https://example.test\n  command: node",
      ),
    /only HTTP MCP is allowed/,
  );
  assert.throws(
    () => inputInternals.parseMcpServers("server:\n  type: http\n  url: http://example.test"),
    /must use https/,
  );
  assert.throws(
    () =>
      inputInternals.parseMcpServers("review_output:\n  type: http\n  url: https://example.test"),
    /review_output.*reserved/,
  );
});

test("rejects invalid numeric and boolean inputs", () => {
  const values = {
    "github-pat": "ghp_test",
    "ai-base-url": "https://ai.example.test",
    "ai-secret": "secret",
    model: "model",
    "review-prompts": "goal",
    "parallel-count": "0",
  };
  assert.throws(() => readReviewConfig(reader(values)), /parallel-count.*between 1 and 10/);
  assert.throws(
    () =>
      readReviewConfig(reader({ ...values, "parallel-count": "1", "auto-approve": "sometimes" })),
    /auto-approve.*true.*false/,
  );
});
