import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { z } from "zod";
import {
  reviewConfig,
  emptyConversation,
  runReviewGoalWithEmptyGuidance,
} from "./agent-test-helpers.js";
import { makeReplayRepository, makeDiffFromSnapshots } from "./git-test-helpers.js";
import {
  completeReviewScript,
  historyText,
  historyDocuments,
  modelFixture,
  toolNames,
  isolatedTemporaryRoot,
  nativeReview,
} from "./codex-test-helpers.js";
import {
  CodexAppServer,
  codexConfigArgs,
  codexExecutable,
  CODEX_TARGETS,
} from "../src/runtime/codex-app-server.js";
import { startCodexMcpServer } from "../src/runtime/codex-mcp-server.js";
import { tool } from "../src/runtime/review-tool.js";
import { verifyResolution } from "../src/runtime/resolution-session.js";
import { prepareContextFiles } from "../src/lib/context-files.js";
import { runSharedDiscovery } from "../src/runtime/shared-discovery.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

test("native reviews use runner proxies while local MCP bypasses them", async (t) => {
  for (const name of ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    await t.test(name, { timeout: 30_000 }, async (subtest) => {
      await isolatedTemporaryRoot(subtest);
      const fixture = await modelFixture(subtest, completeReviewScript());
      for (const key of [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
      ]) {
        const previous = process.env[key];
        Reflect.deleteProperty(process.env, key);
        subtest.after(() => {
          if (previous === undefined) Reflect.deleteProperty(process.env, key);
          else process.env[key] = previous;
        });
      }
      process.env[name] = new URL(fixture.url).origin;
      const result = await nativeReview(subtest, "http://native-model.invalid/v1");
      assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
      assert.ok(fixture.requests.length > 0);
      assert.ok(
        fixture.requests.every(({ path }) => new URL(path).hostname === "native-model.invalid"),
      );
      assert.ok(
        fixture.requests.some(({ body }) =>
          historyText(body).includes("Review submission accepted."),
        ),
      );
    });
  }
});

test(
  "native Codex reviews reject, inspect, recover evidence, and submit through authenticated MCP",
  { timeout: 60_000 },
  async (t) => {
    const temporary = await isolatedTemporaryRoot(t);
    const fixture = await modelFixture(t, completeReviewScript({ continuation: true }));
    const result = await nativeReview(t, fixture.url);
    assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
    assert.equal(result.submission?.findings[0]?.line, 2);
    assert.deepEqual(result.inspection, {
      observedPaths: ["review.txt"],
      missingPaths: [],
      lineCoverage: [{ path: "review.txt", addedLines: [[2, 3]], deletedLines: [] }],
    });
    assert.ok((result.diagnostics?.submissionAttempts ?? 0) >= 2);
    assert.ok(fixture.requests.some(({ body }) => historyText(body).includes("rejected")));
    assert.ok(fixture.requests.some(({ body }) => historyText(body).includes("Continue")));
    for (const { body } of fixture.requests) {
      assert.equal(body.model, "gpt-6.1-sol");
      assert.equal((body.reasoning as { effort: unknown }).effort, "high");
      assert.ok(
        toolNames(body).every((name) => !/shell|exec_command|web_search|spawn_agent/u.test(name)),
      );
    }
    assert.deepEqual(await readdir(temporary), []);
  },
);

test(
  "native compaction preserves host-owned evidence and submission validation",
  { timeout: 60_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const fixture = await modelFixture(t, completeReviewScript({ compact: true }));
    const result = await nativeReview(t, fixture.url);
    assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
    assert.ok(fixture.requests.some(({ body }) => toolNames(body).length === 0));
    assert.ok((result.diagnostics?.evidenceReferences ?? 0) > 0);
  },
);

test(
  "native context-file delivery reaches the model and stays out of action logs",
  { timeout: 30_000 },
  async (t) => {
    const temporary = await isolatedTemporaryRoot(t);
    const contextPath = join(temporary, "private-context.txt");
    const sentinel = "PRIVATE_CONTEXT_DELIVERY_SENTINEL";
    await writeFile(contextPath, sentinel);
    const artifact = await prepareContextFiles(
      [{ prompt: "Review", files: [contextPath] }],
      process.cwd(),
    );
    t.after(() => artifact.cleanup());
    const output: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
      output.push(chunk.toString());
      return true;
    });
    let first = true;
    const script = completeReviewScript();
    const fixture = await modelFixture(t, (request) => {
      if (first) {
        first = false;
        return { tool: "read_context_file", args: { path: contextPath } };
      }
      return script(request);
    });
    const result = await nativeReview(t, fixture.url, {}, undefined, artifact.filesByGoal[0]);
    assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
    assert.ok(fixture.requests.some(({ body }) => historyText(body).includes(sentinel)));
    assert.ok(output.some((line) => line.includes("read_context_file")));
    assert.doesNotMatch(output.join(""), new RegExp(sentinel, "u"));
  },
);

test(
  "native cache usage is counted once in the shared token summary",
  { timeout: 30_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const script = completeReviewScript();
    const fixture = await modelFixture(t, (request) => ({
      ...script(request),
      cachedInputTokens: 30,
    }));
    const result = await nativeReview(t, fixture.url);
    assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
    const usage = result.tokenUsage?.models[0];
    assert.equal(usage?.inputTokens, fixture.requests.length * 70);
    assert.equal(usage?.cacheReadInputTokens, fixture.requests.length * 30);
    assert.equal(usage?.outputTokens, fixture.requests.length * 10);
  },
);

test(
  "native file edits fail closed and preserve the immutable checkout",
  { timeout: 30_000 },
  async (t) => {
    const temporary = await isolatedTemporaryRoot(t);
    let checkout = "";
    let calls = 0;
    const fixture = await modelFixture(t, () => {
      calls++;
      if (calls > 1) {
        return { text: "The edit attempt was rejected. Stop this review." };
      }
      return {
        tool: "apply_patch",
        args: {},
        input: `*** Begin Patch\n*** Update File: ${join(checkout, "review.txt")}\n@@\n-before\n+tampered\n*** End Patch`,
      };
    });
    const result = await nativeReview(t, fixture.url, {}, (root) => {
      checkout = root;
      return Promise.resolve();
    });
    assert.equal(result.status, "failed");
    assert.ok(
      fixture.requests.some(({ body }) =>
        historyText(body).includes("patch rejected: writing is blocked by read-only sandbox"),
      ),
    );
    assert.equal(await readFile(join(checkout, "review.txt"), "utf8"), "before\nafter\n");
    assert.deepEqual(await readdir(temporary), []);
  },
);

test(
  "premature native goal completion still requires host acceptance and a repair turn",
  { timeout: 30_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    let index = 0;
    const script = completeReviewScript();
    const fixture = await modelFixture(t, (request) => {
      if (index++ === 0) return { tool: "update_goal", args: { status: "complete" } };
      if (index === 2) return { text: "The native goal is complete." };
      return script(request);
    });
    const result = await nativeReview(t, fixture.url);
    assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
    assert.ok(result.submission);
    assert.ok(fixture.requests.some(({ body }) => /submit_review|repair/u.test(historyText(body))));
  },
);

test(
  "acceptance at the turn limit is retained and stops native continuation",
  { timeout: 30_000 },
  async (t) => {
    const temporary = await isolatedTemporaryRoot(t);
    const fixture = await modelFixture(t, completeReviewScript({ continuation: true }));
    const result = await nativeReview(t, fixture.url, { maxTurns: 2 });
    assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
    assert.ok(result.submission);
    assert.deepEqual(await readdir(temporary), []);
  },
);

test(
  "accepted-submission grace closes a native session without a terminal model response",
  { timeout: 45_000 },
  async (t) => {
    const temporary = await isolatedTemporaryRoot(t);
    const script = completeReviewScript();
    const fixture = await modelFixture(t, (request) =>
      historyText(request.body).includes("Review submission accepted.")
        ? { wait: true }
        : script(request),
    );
    const result = await nativeReview(t, fixture.url);
    assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
    assert.equal(result.tokenUsage?.complete, false);
    assert.deepEqual(await readdir(temporary), []);
  },
);

test(
  "native goal continuation stops at the app-server turn cap without accepting goal completion",
  { timeout: 30_000 },
  async (t) => {
    const temporary = await isolatedTemporaryRoot(t);
    const fixture = await modelFixture(t, () => ({ text: "Continue reviewing the goal." }));
    const result = await nativeReview(t, fixture.url, { maxTurns: 2 });
    assert.notEqual(result.status, "completed");
    assert.equal(result.submission, undefined);
    assert.equal(result.diagnostics?.termination, "max-turns-exhausted");
    assert.ok(fixture.requests.length >= 2 && fixture.requests.length <= 3);
    assert.deepEqual(await readdir(temporary), []);
  },
);

test(
  "large bounded source pages reach the model and schema rejections preserve recovery",
  { timeout: 60_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const content = "x ".repeat(12_000) + "SOURCE_DELIVERY_SENTINEL\n";
    let index = 0;
    let observed = false;
    const script = completeReviewScript();
    const fixture = await modelFixture(t, (request) => {
      if (index++ === 0) return { tool: "submit_review", args: { summary: 42 } };
      if (index === 2)
        return { tool: "read_repository_file", args: { revision: "head", path: "large.txt" } };
      const page = historyDocuments(request.body)
        .filter((doc) => doc.path === "large.txt")
        .at(-1);
      if (page?.done === false)
        return {
          tool: "read_repository_file",
          args: { revision: "head", path: "large.txt", cursor: page.nextCursor },
        };
      if (historyText(request.body).includes("SOURCE_DELIVERY_SENTINEL")) observed = true;
      return script(request);
    });
    const result = await nativeReview(t, fixture.url, {}, async (root) => {
      await writeFile(join(root, "large.txt"), content);
    });
    assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
    assert.equal(observed, true, "The source suffix must survive native tool-output truncation.");
    assert.ok((result.diagnostics?.submissionAttempts ?? 0) >= 3);
  },
);

test(
  "required external MCP startup failure prevents a complete review",
  { timeout: 30_000 },
  async (t) => {
    const temporary = await isolatedTemporaryRoot(t);
    const fixture = await modelFixture(t, completeReviewScript());
    const result = await nativeReview(t, fixture.url, {
      mcpServers: {
        unavailable: { type: "http", url: "http://127.0.0.1:1/mcp" },
      },
    });
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /MCP|unavailable/u);
    assert.equal(result.submission, undefined);
    assert.deepEqual(await readdir(temporary), []);
  },
);

test(
  "external MCP deny and ask policies are withheld from the native model",
  { timeout: 30_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const bridge = await startCodexMcpServer(
      "external",
      [
        tool("denied", "Denied tool", {}, () => Promise.reject(new Error("Denied tool executed"))),
        tool("ask", "Ask tool", {}, () => Promise.reject(new Error("Ask tool executed"))),
      ],
      (definition, args) => definition.handler(args),
    );
    t.after(() => bridge.close());
    const script = completeReviewScript();
    const fixture = await modelFixture(t, (request) => {
      assert.ok(
        toolNames(request.body).every((name) => !name.endsWith("denied") && !name.endsWith("ask")),
      );
      return script(request);
    });
    const result = await nativeReview(t, fixture.url, {
      mcpServers: {
        external: {
          type: "http",
          url: bridge.url,
          headers: { Authorization: "Bearer " + bridge.token },
          tools: [
            { name: "denied", permission_policy: "always_deny" },
            { name: "ask", permission_policy: "always_ask" },
          ],
        },
      },
    });
    assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
  },
);

test(
  "selected effort survives literal aliases and default native WebSocket-to-HTTP fallback",
  { timeout: 90_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    for (const effort of ["low", "high", "max"] as const) {
      await t.test(effort, async (subtest) => {
        const fixture = await modelFixture(subtest, completeReviewScript());
        const result = await nativeReview(subtest, fixture.url, {
          model: "gpt-6.1-sol-fixture-alias",
          effort,
        });
        assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
        assert.ok(fixture.upgrades() > 0);
        assert.deepEqual(fixture.lookups, []);
        assert.ok(
          fixture.requests.every(
            ({ body }) =>
              body.model === "gpt-6.1-sol-fixture-alias" &&
              typeof body.reasoning === "object" &&
              body.reasoning !== null &&
              "effort" in body.reasoning &&
              body.reasoning.effort === effort,
          ),
        );
      });
    }
  },
);

test(
  "native terminal failure retains an accepted review as failed and removes private state",
  { timeout: 30_000 },
  async (t) => {
    const temporary = await isolatedTemporaryRoot(t);
    const script = completeReviewScript();
    const fixture = await modelFixture(t, (request) =>
      historyText(request.body).includes("Review submission accepted.")
        ? { error: 400 }
        : script(request),
    );
    const result = await nativeReview(t, fixture.url);
    assert.equal(result.status, "failed");
    assert.ok(result.submission);
    assert.match(result.error ?? "", /Controlled upstream failure|400/u);
    assert.deepEqual(await readdir(temporary), []);
  },
);

test(
  "native permanent terminal errors override earlier transport retries in review and discovery",
  { timeout: 180_000 },
  async (t) => {
    for (const discovery of [false, true]) {
      for (const status of [401, 402, 400, 418]) {
        await t.test(`${discovery ? "discovery" : "review"} HTTP ${status}`, async (subtest) => {
          const temporary = await isolatedTemporaryRoot(subtest);
          const output: string[] = [];
          subtest.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
            output.push(chunk.toString());
            return true;
          });
          const schedule = globalThis.setTimeout;
          const backoffs: number[] = [];
          subtest.mock.method(
            globalThis,
            "setTimeout",
            (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
              if (
                milliseconds !== undefined &&
                milliseconds >= 120_000 &&
                milliseconds <= 255_000
              ) {
                backoffs.push(milliseconds);
                return schedule(callback, 1, ...args);
              }
              return schedule(callback, milliseconds, ...args);
            },
          );
          const fixture = await modelFixture(subtest, (_, index) =>
            index === 0 ? { interruptStream: true } : { error: status },
          );
          if (discovery) {
            const repository = await makeReplayRepository(subtest);
            const diff = await makeDiffFromSnapshots(
              repository.root,
              repository.baseSha,
              repository.headSha,
              repository.temporaryRoot,
            );
            subtest.after(() => diff.cleanup());
            const result = await runSharedDiscovery({
              context: repository.context,
              files: [],
              conversation: emptyConversation,
              config: reviewConfig({
                executor: "codex",
                aiBaseUrl: fixture.url,
                model: "gpt-6.1-sol",
              }),
              diff,
              cwd: repository.root,
              queryAgent: query,
              abortController: undefined,
              briefing: {
                linkedIssues: [],
                linkedIssueReferencesTruncated: false,
                repositoryGuidance: [],
              },
            });
            assert.equal(result.result.status, "failed");
            assert.equal(result.result.diagnostics.termination, "provider-error");
            assert.equal(result.seed, undefined);
          } else {
            const result = await nativeReview(subtest, fixture.url);
            assert.equal(result.status, "failed");
            assert.equal(result.diagnostics?.termination, "provider-error");
            assert.equal(result.diagnostics?.providerRetries, 0);
            assert.match(output.join(""), /session api-retry/u);
          }
          assert.deepEqual(backoffs, []);
          assert.ok(fixture.requests.length >= 2);
          assert.ok(
            fixture.requests.every(
              ({ body }) =>
                !/provider request failed temporarily|provider is available for another attempt/u.test(
                  historyText(body),
                ),
            ),
          );
          assert.deepEqual(await readdir(temporary), []);
        });
      }
    }
  },
);

test("native retry notices do not defeat an accepted review", { timeout: 30_000 }, async (t) => {
  const temporary = await isolatedTemporaryRoot(t);
  const output: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    output.push(chunk.toString());
    return true;
  });
  let retried = false;
  let interruptedHistory = "";
  const script = completeReviewScript();
  const fixture = await modelFixture(t, (request) => {
    const evidence = historyDocuments(request.body).some(
      (document) =>
        Array.isArray(document.records) &&
        document.records.some(
          (record: unknown) =>
            typeof record === "object" &&
            record !== null &&
            "kind" in record &&
            record.kind === "evidence",
        ),
    );
    if (!retried && evidence) {
      retried = true;
      interruptedHistory = historyText(request.body);
      return { interruptStream: true };
    }
    return script(request);
  });
  const result = await nativeReview(t, fixture.url);
  assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
  assert.equal(retried, true);
  assert.match(output.join(""), /session api-retry/u);
  assert.ok(
    fixture.requests.filter(({ body }) => historyText(body) === interruptedHistory).length >= 2,
  );
  assert.deepEqual(await readdir(temporary), []);
});

test(
  "unexpected native process EOF is failed only after private-state cleanup",
  { timeout: 30_000, skip: process.platform === "win32" },
  async (t) => {
    const temporary = await isolatedTemporaryRoot(t);
    const fixture = await modelFixture(t, async () => {
      const { stdout } = await promisify(execFile)("ps", ["-eo", "pid=,args="], {
        encoding: "utf8",
      });
      const owned = stdout
        .split("\n")
        .find((line) => line.includes(temporary) && line.includes("app-server --listen"));
      assert.ok(owned, "Only the real process using this test's private home may be terminated.");
      const pid = Number(/^\s*(\d+)/u.exec(owned)?.[1]);
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      process.kill(pid, "SIGKILL");
      return { wait: true };
    });
    const result = await nativeReview(t, fixture.url);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /closed stdout|exited/u);
    assert.deepEqual(await readdir(temporary), []);
  },
);

test(
  "native cancellation closes a pending request and cleans the private home",
  { timeout: 30_000 },
  async (t) => {
    const temporary = await isolatedTemporaryRoot(t);
    const controller = new AbortController();
    const fixture = await modelFixture(t, () => {
      controller.abort(new Error("fixture cancellation"));
      return { wait: true };
    });
    const repository = await makeReplayRepository(t);
    const diff = await makeDiffFromSnapshots(
      repository.root,
      repository.baseSha,
      repository.headSha,
      repository.temporaryRoot,
    );
    t.after(() => diff.cleanup());
    await assert.rejects(
      runReviewGoalWithEmptyGuidance(
        "Review",
        0,
        repository.context,
        [],
        emptyConversation,
        reviewConfig({
          executor: "codex",
          aiBaseUrl: fixture.url,
          model: "gpt-6.1-sol",
          maxTurns: 2,
        }),
        diff,
        repository.root,
        undefined,
        [],
        controller,
      ),
      /fixture cancellation/u,
    );
    assert.deepEqual(await readdir(temporary), []);
  },
);

test(
  "Codex resolution requires a successful cited-file delivery and excludes review MCP servers",
  { timeout: 30_000 },
  async (t) => {
    const temporary = await isolatedTemporaryRoot(t);
    const repository = await makeReplayRepository(t);
    let index = 0;
    const fixture = await modelFixture(t, ({ body }) => {
      assert.ok(!toolNames(body).some((name) => name.includes("external")));
      const replies = [
        {
          tool: "submit_resolution",
          args: { verdict: "fixed", confidence: "high", rationale: "Already fixed" },
        },
        { tool: "read_repository_file", args: { path: "missing.txt" } },
        {
          tool: "submit_resolution",
          args: { verdict: "fixed", confidence: "high", rationale: "Still no evidence" },
        },
        { tool: "read_repository_file", args: { path: "review.txt" } },
        {
          tool: "submit_resolution",
          args: {
            verdict: "fixed",
            confidence: "high",
            rationale: "The current cited source handles the value.",
          },
        },
        { text: "Verdict submitted." },
      ];
      return replies[index++] ?? { text: "Done." };
    });
    const result = await verifyResolution(
      repository.context,
      {
        nodeId: "thread",
        path: "review.txt",
        isResolved: false,
        isOutdated: true,
        line: 2,
        originalLine: 2,
        reviewId: 1,
        reviewNodeId: "review",
        comments: [],
      },
      reviewConfig({
        executor: "codex",
        aiBaseUrl: fixture.url,
        model: "gpt-6.1-sol",
        maxTurns: 2,
        mcpServers: { external: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      }),
      repository.root,
    );
    assert.equal(result.status, "completed", result.error ?? "Unexpected review result");
    assert.equal(result.verdict, "fixed", result.error ?? "Unexpected review result");
    assert.ok(fixture.requests.some(({ body }) => historyText(body).includes("successful Read")));
    assert.deepEqual(await readdir(temporary), []);
  },
);

test("MCP bridge rejects unauthenticated requests and validates real tool input", async (t) => {
  let calls = 0;
  const bridge = await startCodexMcpServer(
    "test",
    [
      tool("bounded", "Bounded read", { path: z.string() }, () => {
        calls++;
        return Promise.resolve({ content: [{ type: "text", text: "delivered" }] });
      }),
    ],
    (definition, args) => definition.handler(args),
  );
  t.after(() => bridge.close());
  assert.equal((await fetch(bridge.url, { method: "POST", body: "{}" })).status, 401);
  const response = await fetch(bridge.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + bridge.token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "bounded", arguments: { path: 1 } },
    }),
  });
  const value = (await response.json()) as { result: { isError: boolean } };
  assert.equal(value.result.isError, true);
  assert.equal(calls, 0);
});

test("app-server transport fails explicit EOF, malformed messages, and disabled client requests", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-codex-transport-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  for (const [name, source, pattern] of [
    ["eof", "process.stdout.end();", /closed stdout|exited/u],
    ["malformed", "process.stdout.write('not JSON\\n');", /JSON/u],
    [
      "approval",
      "process.stdout.write(JSON.stringify({id:1,method:'item/permissions/requestApproval',params:{}})+'\\n');",
      /disabled client action/u,
    ],
  ] as const) {
    const executable = join(temporary, name + ".js");
    await writeFile(executable, "#!/usr/bin/env node\n" + source);
    await chmod(executable, 0o700);
    let resolveFailure: ((error: Error) => void) | undefined;
    const failure = new Promise<Error>((resolve) => {
      resolveFailure = resolve;
    });
    const server = new CodexAppServer(
      executable,
      {},
      temporary,
      { PATH: process.env.PATH },
      () => Promise.resolve(),
      (error) => resolveFailure?.(error),
    );
    assert.match((await failure).message, pattern);
    await server.close().catch((error: unknown) => {
      assert.match(String(error), pattern);
    });
  }
});

test("native package resolution covers six platforms and quotes dotted config keys", () => {
  for (const [platform, triple] of Object.entries(CODEX_TARGETS)) {
    const [os, cpu] = platform.split("/");
    assert.ok(os && cpu);
    assert.equal(
      codexExecutable(os, cpu, () => "/packages/package.json"),
      join("/packages", "vendor", triple, "bin", os === "win32" ? "codex.exe" : "codex"),
    );
  }
  assert.throws(() => codexExecutable("freebsd", "x64"), /Unsupported/u);
  assert.deepEqual(
    codexConfigArgs({ mcp_servers: { "review.tools": { url: "http://localhost" } } }),
    ["-c", 'mcp_servers."review.tools".url="http://localhost"'],
  );
});
