import { strict as assert } from "node:assert";
import test from "node:test";

import {
  inputInternals,
  inputSecretCandidates,
  readReviewConfig,
  reviewSecretCandidates,
} from "../src/lib/input.js";

function reader(values: Record<string, string>) {
  return { get: (name: string): string => values[name] ?? "" };
}

test("reads structured goals and strict HTTP MCP configuration", () => {
  const config = readReviewConfig(
    reader({
      "github-pat": "ghp_test",
      "ai-base-url": "https://ai.example.test/v1/",
      "ai-secret": "secret",
      model: "review-model",
      "review-prompts": JSON.stringify([
        { prompt: "first goal" },
        { prompt: "second goal", files: [] },
      ]),
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
  assert.deepEqual(config.reviewPrompts, [
    { prompt: "first goal", files: [] },
    { prompt: "second goal", files: [] },
  ]);
  assert.equal(config.aiBaseUrl, "https://ai.example.test/v1");
  assert.equal(config.mcpServers.security?.type, "http");
  assert.equal(config.mcpServers.security?.headers?.Authorization, "Bearer token");
  assert.equal(config.interactWithPullRequest, true);
  assert.equal(config.effort, undefined);
  assert.equal(config.pullRequestUrl, undefined);
  assert.equal(
    inputInternals.parseMcpServers(
      "server:\n  type: http\n  url: https://mcp.example.test/review?tenant=foo/",
    ).server?.url,
    "https://mcp.example.test/review?tenant=foo/",
  );
});

test("accepts goals with omitted, empty, and populated context files", () => {
  assert.deepEqual(
    inputInternals.parseReviewPrompts(
      JSON.stringify([
        { prompt: "omitted files" },
        { prompt: "empty files", files: [] },
        { prompt: "populated files", files: ["/tmp/ticket.json"] },
      ]),
    ),
    [
      { prompt: "omitted files", files: [] },
      { prompt: "empty files", files: [] },
      { prompt: "populated files", files: ["/tmp/ticket.json"] },
    ],
  );
});

test("rejects legacy string goals", () => {
  assert.throws(
    () => inputInternals.parseReviewPrompts('["one", "two"]'),
    /review-prompts\[0\] must be an object/u,
  );
  assert.throws(() => inputInternals.parseReviewPrompts("one\ntwo"), /must be valid JSON/u);
});

test("accepts exact context files on individual goals", () => {
  assert.deepEqual(
    inputInternals.parseReviewPrompts(
      JSON.stringify([
        { prompt: "use ticket", files: ["/tmp/ticket.json"] },
        { prompt: "review concurrency" },
      ]),
    ),
    [
      { prompt: "use ticket", files: ["/tmp/ticket.json"] },
      { prompt: "review concurrency", files: [] },
    ],
  );
});

test("reads and validates optional model effort", () => {
  const values = {
    "github-pat": "ghp_test",
    "ai-base-url": "https://ai.example.test",
    "ai-secret": "secret",
    model: "model",
    "review-prompts": JSON.stringify([{ prompt: "goal" }]),
  };
  for (const [input, expected] of [
    ["low", "low"],
    [" MEDIUM ", "medium"],
    ["High", "high"],
    ["xhigh", "xhigh"],
    ["MAX", "max"],
  ] as const) {
    assert.equal(readReviewConfig(reader({ ...values, effort: input })).effort, expected);
  }
  assert.equal(readReviewConfig(reader({ ...values, effort: " " })).effort, undefined);
  for (const effort of ["auto", "ultracode", "highest"]) {
    assert.throws(
      () => readReviewConfig(reader({ ...values, effort })),
      /effort.*low.*medium.*high.*xhigh.*max/u,
    );
  }
});

test("reads an optional replacement system prompt without an application length cap", () => {
  const values = {
    "github-pat": "ghp_test",
    "ai-base-url": "https://ai.example.test",
    "ai-secret": "secret",
    model: "model",
    "review-prompts": JSON.stringify([{ prompt: "goal" }]),
  };
  assert.equal(readReviewConfig(reader(values)).systemPrompt, undefined);
  assert.equal(
    readReviewConfig(reader({ ...values, "system-prompt": "   " })).systemPrompt,
    undefined,
  );

  const prompt = `  first line\n  second line\n${"x".repeat(12_001)}  `;
  assert.equal(
    readReviewConfig(reader({ ...values, "system-prompt": prompt })).systemPrompt,
    `first line\n  second line\n${"x".repeat(12_001)}`,
  );
});

test("reads strict model pricing while preserving the currency prefix", () => {
  const pricing = inputInternals.parseModelPricing(
    JSON.stringify({
      currency: "USD ",
      models: {
        "review-model": {
          input: 1.2,
          output: 2,
          "cache-hit": 0.12,
          "cache-creation": 0.6,
        },
      },
    }),
  );
  assert.ok(pricing);
  assert.equal(pricing.currency, "USD ");
  assert.deepEqual(pricing.models["review-model"], {
    input: 1.2,
    output: 2,
    cacheHit: 0.12,
    cacheCreation: 0.6,
  });
  assert.equal(Object.getPrototypeOf(pricing.models), null);
  assert.equal(inputInternals.parseModelPricing(""), undefined);

  const config = readReviewConfig(
    reader({
      "github-pat": "token",
      "ai-base-url": "https://ai.example.test",
      "ai-secret": "secret",
      model: "review-model",
      "model-pricing": JSON.stringify({
        currency: "$",
        models: {
          "review-model": {
            input: 0,
            output: 0,
            "cache-hit": 0,
            "cache-creation": 0,
          },
        },
      }),
      "review-prompts": JSON.stringify([{ prompt: "goal" }]),
    }),
  );
  assert.equal(config.modelPricing?.currency, "$");
});

test("rejects malformed, duplicate, and unsupported model pricing JSON", () => {
  for (const [value, message] of [
    ["{currency: '$'}", /must be valid JSON/u],
    ['{"currency":"$","currency":"USD","models":{}}', /unique object keys/u],
    [
      '{"currency":"$","models":{"model":{"input":1,"input":2,"output":2,"cache-hit":0.1,"cache-creation":0.2}}}',
      /unique object keys/u,
    ],
    ['{"currency":"$","models":{},"extra":true}', /model-pricing\.extra is not supported/u],
    ['{"currency":"$","models":[]}', /models must be an object/u],
    ['{"currency":"$","models":{}}', /must contain at least one model/u],
    [
      '{"currency":"$","models":{"model":{"input":1,"output":2,"cache-hit":0.1,"cache-creation":0.2,"extra":3}}}',
      /extra.*is not supported/u,
    ],
  ] as const) {
    assert.throws(() => inputInternals.parseModelPricing(value), message);
  }
});

test("requires every model pricing rate to be finite and non-negative", () => {
  const makePricing = (rates: Record<string, unknown>): string =>
    JSON.stringify({ currency: "$", models: { model: rates } });
  const valid = { input: 1, output: 2, "cache-hit": 0.1, "cache-creation": 0.2 };
  for (const [field, value] of [
    ["input", -1],
    ["output", "2"],
    ["cache-hit", null],
    ["cache-creation", undefined],
  ] as const) {
    assert.throws(
      () => inputInternals.parseModelPricing(makePricing({ ...valid, [field]: value })),
      new RegExp(`${field} must be a finite non-negative number`, "u"),
    );
  }
  assert.throws(
    () =>
      inputInternals.parseModelPricing(
        '{"currency":"$","models":{"model":{"input":1e400,"output":2,"cache-hit":0.1,"cache-creation":0.2}}}',
      ),
    /input must be a finite non-negative number/u,
  );
});

test("registers direct secret inputs before configuration parsing", () => {
  const values = {
    "github-pat": "ghp_test",
    "ai-secret": "ai-secret",
    "ai-base-url": "https://ai.example.test",
  };
  const candidates = inputSecretCandidates(reader(values));
  assert.deepEqual(candidates, ["ghp_test", "ai-secret", "https://ai.example.test"]);
  assert.throws(
    () => inputInternals.parseMcpServers("root: [\n  Authorization: nested-header-secret\n"),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Input 'mcp-servers' is invalid YAML." &&
      !error.message.includes("nested-header-secret"),
  );
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
    "review-prompts": JSON.stringify([{ prompt: "goal" }]),
    "parallel-count": "0",
  };
  assert.throws(() => readReviewConfig(reader(values)), /parallel-count.*between 1 and 10/);
  assert.throws(
    () =>
      readReviewConfig(reader({ ...values, "parallel-count": "1", "auto-approve": "sometimes" })),
    /auto-approve.*true.*false/,
  );
  assert.throws(
    () => readReviewConfig(reader({ ...values, "parallel-count": "1", "max-turns": "1" })),
    /max-turns.*between 2 and 100/,
  );
  assert.throws(
    () =>
      readReviewConfig(
        reader({ ...values, "parallel-count": "1", "interact-with-pr": "sometimes" }),
      ),
    /interact-with-pr.*true.*false/,
  );
});

test("reads summary-only and pull request URL inputs", () => {
  const config = readReviewConfig(
    reader({
      "github-pat": "ghp_test",
      "ai-base-url": "https://ai.example.test",
      "ai-secret": "secret",
      model: "model",
      "review-prompts": JSON.stringify([{ prompt: "goal" }]),
      "interact-with-pr": "false",
      "pull-request-url": "https://github.com/owner/repository/pull/42/",
    }),
  );
  assert.equal(config.interactWithPullRequest, false);
  assert.equal(config.pullRequestUrl, "https://github.com/owner/repository/pull/42");
});

test("accepts every supported MCP policy and optional field", () => {
  const servers = inputInternals.parseMcpServers(`
security:
  type: http
  url: https://mcp.example.test/path///
  headers:
    X-Test: value
  tools:
    - name: allow
      permission_policy: always_allow
      org_max_permission: allow
    - name: ask
      permission_policy: always_ask
      org_max_permission: ask
    - name: deny
      permission_policy: always_deny
      org_max_permission: blocked
    - name: default
  timeout: 1000
  alwaysLoad: false
`);
  assert.deepEqual(servers.security, {
    type: "http",
    url: "https://mcp.example.test/path",
    headers: { "X-Test": "value" },
    tools: [
      { name: "allow", permission_policy: "always_allow", org_max_permission: "allow" },
      { name: "ask", permission_policy: "always_ask", org_max_permission: "ask" },
      { name: "deny", permission_policy: "always_deny", org_max_permission: "blocked" },
      { name: "default" },
    ],
    timeout: 1000,
    alwaysLoad: false,
  });
});

test("rejects malformed MCP maps, headers, policies, and optional values", () => {
  assert.throws(() => inputInternals.parseMcpServers("[]"), /must be a mapping of server names/u);
  assert.throws(
    () =>
      inputInternals.parseMcpServers(
        Array.from(
          { length: 21 },
          (_, index) => `server${index}:\n  type: http\n  url: https://example.test/${index}`,
        ).join("\n"),
      ),
    /too many servers/u,
  );
  assert.throws(
    () => inputInternals.parseMcpServers('"bad name": { type: http, url: https://example.test }'),
    /not a valid server name/u,
  );
  assert.throws(() => inputInternals.parseMcpServers("server: value"), /server must be a mapping/u);
  assert.throws(
    () =>
      inputInternals.parseMcpServers(
        "server:\n  type: http\n  url: https://example.test\n  headers: []",
      ),
    /headers must be a mapping/u,
  );
  const manyHeaders = Array.from({ length: 51 }, (_, index) => `    X-${index}: value`).join("\n");
  assert.throws(
    () =>
      inputInternals.parseMcpServers(
        `server:\n  type: http\n  url: https://example.test\n  headers:\n${manyHeaders}`,
      ),
    /too many headers/u,
  );
  assert.throws(
    () =>
      inputInternals.parseMcpServers(
        'server:\n  type: http\n  url: https://example.test\n  headers:\n    "Bad Header": value',
      ),
    /not a valid HTTP header name/u,
  );
  assert.throws(
    () =>
      inputInternals.parseMcpServers(
        "server:\n  type: http\n  url: https://example.test\n  headers:\n    X-Test: ''",
      ),
    /must be a non-empty string/u,
  );

  for (const [tools, message] of [
    ["value", /tools must be a sequence/u],
    ["\n    - value", /tools\[0\] must be a mapping/u],
    ["\n    - name: tool\n      extra: true", /tools\[0\]\.extra is not supported/u],
    ["\n    - name: ''", /tools\[0\]\.name must be a non-empty string/u],
    ["\n    - name: tool\n      permission_policy: sometimes", /permission_policy is invalid/u],
    ["\n    - name: tool\n      org_max_permission: sometimes", /org_max_permission is invalid/u],
  ] as const) {
    assert.throws(
      () =>
        inputInternals.parseMcpServers(
          `server:\n  type: http\n  url: https://example.test\n  tools: ${tools}`,
        ),
      message,
    );
  }
  const manyTools = Array.from({ length: 101 }, () => "    - name: tool").join("\n");
  assert.throws(
    () =>
      inputInternals.parseMcpServers(
        `server:\n  type: http\n  url: https://example.test\n  tools:\n${manyTools}`,
      ),
    /too many tool policies/u,
  );
  for (const [field, value, message] of [
    ["timeout", "999", /timeout must be an integer between/u],
    ["timeout", "value", /timeout must be an integer between/u],
    ["alwaysLoad", "value", /alwaysLoad must be a boolean/u],
  ] as const) {
    assert.throws(
      () =>
        inputInternals.parseMcpServers(
          `server:\n  type: http\n  url: https://example.test\n  ${field}: ${value}`,
        ),
      message,
    );
  }
});

test("rejects malformed URLs, prompts, required values, and removed auth modes", () => {
  const base = {
    "github-pat": "token",
    "ai-base-url": "https://ai.example.test",
    "ai-secret": "secret",
    model: "model",
    "review-prompts": JSON.stringify([{ prompt: "goal" }]),
  };
  for (const [value, message] of [
    ["not-a-url", /absolute HTTP\(S\) URL/u],
    ["ftp://example.test", /must use http:\/\/ or https:\/\//u],
    ["https://user:pass@example.test", /must not contain URL credentials/u],
  ] as const) {
    assert.throws(() => readReviewConfig(reader({ ...base, "ai-base-url": value })), message);
  }
  assert.throws(
    () =>
      inputInternals.parseMcpServers(
        "server:\n  type: http\n  url: https://user:pass@example.test",
      ),
    /must not contain URL credentials/u,
  );
  assert.throws(
    () => readReviewConfig(reader({ ...base, model: " " })),
    /Input 'model' is required/u,
  );
  assert.throws(
    () => readReviewConfig(reader({ ...base, "ai-auth-mode": "oauth" })),
    /ai-auth-mode.*no longer supported.*API-key/u,
  );
  assert.throws(
    () => readReviewConfig(reader({ ...base, "ai-auth-mode": " AUTH-TOKEN " })),
    /ai-auth-mode.*no longer supported.*API-key/u,
  );

  for (const [value, message] of [
    ["", /at least one prompt/u],
    ["goal", /valid JSON/u],
    ["one\ntwo", /valid JSON/u],
    ["{}", /non-empty JSON array of goal objects/u],
    ["[]", /non-empty JSON array of goal objects/u],
    ["[", /valid JSON/u],
    [JSON.stringify(Array.from({ length: 51 }, () => ({ prompt: "goal" }))), /at most 50 prompts/u],
    [JSON.stringify([1]), /must be an object/u],
    [JSON.stringify([" "]), /must be an object/u],
    [JSON.stringify([{ prompt: "x".repeat(12_001) }]), /must not exceed 12000 characters/u],
    [JSON.stringify([{ prompt: "goal", files: null }]), /files must be an array/u],
    [JSON.stringify([{ prompt: "goal" }, "legacy"]), /must be an object/u],
    [JSON.stringify([{ prompt: "goal", files: ["relative.txt"] }]), /absolute path/u],
    [JSON.stringify([{ prompt: "goal", files: ["/tmp/../ticket.txt"] }]), /normalized/u],
    [
      JSON.stringify([{ prompt: "goal", files: ["/tmp/ticket.txt", "/tmp/ticket.txt"] }]),
      /duplicate paths/u,
    ],
    [
      JSON.stringify([{ prompt: "goal", files: ["/tmp/ticket.txt"], other: true }]),
      /not supported/u,
    ],
    ['[{"prompt":"one","prompt":"two","files":["/tmp/ticket.txt"]}]', /unique object keys/u],
    [
      JSON.stringify([
        {
          prompt: "goal",
          files: Array.from({ length: 26 }, (_, index) => `/tmp/context-${index}.txt`),
        },
      ]),
      /at most 25 files/u,
    ],
    [
      JSON.stringify(
        Array.from({ length: 5 }, (_, goal) => ({
          prompt: `goal-${goal}`,
          files: Array.from({ length: 21 }, (_, file) => `/tmp/context-${goal}-${file}.txt`),
        })),
      ),
      /at most 100 unique context files/u,
    ],
  ] as const) {
    assert.throws(() => inputInternals.parseReviewPrompts(value), message);
  }
  assert.throws(
    () => readReviewConfig(reader({ ...base, "parallel-count": "1.5" })),
    /parallel-count.*integer/u,
  );
  assert.throws(
    () => readReviewConfig(reader({ ...base, "max-turns": "101" })),
    /max-turns.*between 2 and 100/u,
  );
});

test("extracts only credential-shaped endpoint and authorization secrets", () => {
  const config = readReviewConfig(
    reader({
      "github-pat": "token",
      "ai-base-url": "https://ai.example.test?flag&apiKey=encoded%2Fsecret&tenant=public&token=",
      "ai-secret": 'secret"with-escape',
      model: "model",
      "review-prompts": JSON.stringify([{ prompt: "goal" }]),
      "mcp-servers": `
server:
  type: http
  url: https://mcp.example.test?signature=raw%2Fsignature
  headers:
    Authorization: Bearer header-secret
    X-Public: public-value
`,
    }),
  );
  const secrets = reviewSecretCandidates(config);
  assert.ok(secrets.includes("encoded%2Fsecret"));
  assert.ok(secrets.includes("encoded/secret"));
  assert.ok(secrets.includes("raw%2Fsignature"));
  assert.ok(secrets.includes("raw/signature"));
  assert.ok(secrets.includes("header-secret"));
  assert.ok(secrets.includes('secret\\"with-escape'));
  assert.equal(secrets.includes("public"), false);
  assert.equal(secrets.includes("public-value"), true);
});
