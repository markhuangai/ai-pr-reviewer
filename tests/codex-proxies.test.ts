import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { isRecord } from "../src/runtime/agent-logging.js";
import {
  completeReviewScript,
  historyText,
  isolatedTemporaryRoot,
  modelFixture,
  nativeReview,
} from "./codex-test-helpers.js";

const execFileAsync = promisify(execFile);
const images = {
  cliproxyapi: "eceasy/cli-proxy-api:v8.0.27",
  litellm: "ghcr.io/berriai/litellm:v1.105.0",
} as const;

async function proxyFixture(t: TestContext, kind: keyof typeof images, upstreamPort: number) {
  const directory = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-proxy-test-"));
  const dockerConfig = join(directory, "docker-public");
  await mkdir(dockerConfig);
  const docker = async (args: string[]) =>
    (
      await execFileAsync("docker", ["--config", dockerConfig, ...args], { timeout: 180_000 })
    ).stdout.trim();
  t.after(() => rm(directory, { recursive: true, force: true }));
  const upstreamHost =
    process.env.AI_PR_REVIEWER_PROXY_TEST_UPSTREAM_HOST ?? "host.docker.internal";
  const dockerHost = process.env.AI_PR_REVIEWER_PROXY_TEST_DOCKER_HOST ?? "127.0.0.1";
  const upstream = `http://${upstreamHost}:${upstreamPort}/v1`;
  const config =
    kind === "cliproxyapi"
      ? `port: 8317
auth-dir: /tmp/fixture-auth
api-keys: [fixture-client-key]
request-retry: 0
openai-compatibility:
  - name: fixture
    base-url: ${upstream}
    api-key-entries:
      - api-key: fixture-upstream-key
    models:
      - name: gpt-6.1-sol
        alias: gpt-6.1-sol-fixture-alias
        thinking:
          levels: [low, medium, high, xhigh, max]
`
      : `model_list:
  - model_name: gpt-6.1-sol-fixture-alias
    litellm_params:
      model: openai/gpt-6.1-sol
      api_base: ${upstream}
      api_key: fixture-upstream-key
general_settings:
  master_key: fixture-client-key
litellm_settings:
  telemetry: false
  drop_params: false
`;
  const path = join(directory, "config.yaml");
  await writeFile(path, config, { mode: 0o600 });
  const port = kind === "cliproxyapi" ? "8317" : "4000";
  const mount = kind === "cliproxyapi" ? "/CLIProxyAPI/config.yaml" : "/app/config.yaml";
  const id = await docker([
    "create",
    ...(upstreamHost === "host.docker.internal"
      ? ["--add-host", "host.docker.internal:host-gateway"]
      : []),
    "--publish",
    (dockerHost === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0") + "::" + port,
    images[kind],
    ...(kind === "litellm" ? ["--config", mount, "--port", port] : []),
  ]);
  assert.match(id, /^[a-f0-9]{64}$/u);
  t.after(async () => {
    await docker(["rm", "--force", id]);
    const remaining = await docker(["ps", "--all", "--quiet", "--filter", "id=" + id]);
    assert.equal(remaining, "", "The owned proxy container must be removed.");
  });
  await docker(["cp", path, id + ":" + mount]);
  await docker(["start", id]);
  const published = await docker(["port", id, port + "/tcp"]);
  assert.match(published, /^(127\.0\.0\.1|0\.0\.0\.0):[0-9]+$/u);
  const url = `http://${dockerHost}:${published.split(":")[1]}/v1`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    const state = await docker(["inspect", "--format", "{{.State.Status}}", id]);
    if (state === "exited" || state === "dead")
      throw new Error(
        kind + " fixture exited during startup: " + (await docker(["logs", "--tail", "20", id])),
      );
    try {
      const response = await fetch(url + "/models", {
        headers: { Authorization: "Bearer fixture-client-key" },
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return url;
    } catch {
      /* The container is not ready until its HTTP listener accepts requests. */
    }
    if (Date.now() >= deadline)
      throw new Error(kind + " fixture did not become ready within 60 seconds.");
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
}

function assertToolHistory(body: Record<string, unknown>): void {
  const calls = new Set<string>();
  const items = Array.isArray(body.input)
    ? body.input
    : Array.isArray(body.messages)
      ? body.messages
      : [];
  let outputs = 0;
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.type === "function_call" && typeof item.call_id === "string") calls.add(item.call_id);
    for (const call of Array.isArray(item.tool_calls) ? item.tool_calls : [])
      if (isRecord(call) && typeof call.id === "string") calls.add(call.id);
    const id =
      item.type === "function_call_output"
        ? item.call_id
        : item.role === "tool"
          ? item.tool_call_id
          : undefined;
    if (typeof id === "string") {
      assert.ok(
        calls.has(id),
        "Every proxy-delivered tool result must retain its preceding call ID.",
      );
      outputs++;
    }
  }
  if (historyText(body).includes("Review submission accepted.")) assert.ok(outputs >= 6);
}

for (const kind of ["cliproxyapi", "litellm"] as const) {
  test("complete native Codex reviews through " + images[kind], { timeout: 300_000 }, async (t) => {
    await isolatedTemporaryRoot(t);
    for (const effort of ["low", "high", "max"] as const) {
      await t.test(effort, async (subtest) => {
        const fixture = await modelFixture(subtest, completeReviewScript());
        const url = await proxyFixture(subtest, kind, fixture.port);
        const result = await nativeReview(subtest, url, fixture.catalogUrl, {
          aiSecret: "fixture-client-key",
          model: "gpt-6.1-sol-fixture-alias",
          effort,
        });
        assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
        assert.ok((result.diagnostics?.evidenceReferences ?? 0) > 0);
        assert.ok(
          fixture.requests.some(({ body }) =>
            historyText(body).includes("Review submission accepted."),
          ),
        );
        for (const { body } of fixture.requests) {
          assert.equal(body.model, "gpt-6.1-sol");
          assert.equal(
            isRecord(body.reasoning) ? body.reasoning.effort : body.reasoning_effort,
            effort,
          );
          assertToolHistory(body);
        }
      });
    }
  });
}
