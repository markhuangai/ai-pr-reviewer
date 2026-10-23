import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reviewConfig,
  emptyConversation,
  runReviewGoalWithEmptyGuidance,
} from "./agent-test-helpers.js";
import {
  makeReplayRepository,
  makeDiffFromSnapshots,
  commitFixtureSnapshot,
} from "./git-test-helpers.js";
import type { TestContext } from "node:test";
import { isRecord } from "../src/runtime/agent-logging.js";
import type { PreparedContextFile } from "../src/lib/context-files.js";
import { prepareContextFiles } from "../src/lib/context-files.js";
import { runReviewGoals } from "../src/runtime/agent.js";
import type { ReviewConfig, ReviewExecutor } from "../src/lib/types.js";

export interface ModelRequest {
  readonly path: string;
  readonly body: Record<string, unknown>;
}

export type ModelReply =
  | {
      readonly tool: string;
      readonly args: Record<string, unknown>;
      readonly inputTokens?: number;
      readonly cachedInputTokens?: number;
      readonly input?: string;
    }
  | { readonly text: string; readonly inputTokens?: number; readonly cachedInputTokens?: number }
  | { readonly error: number }
  | { readonly disconnect: true }
  | { readonly interruptStream: true }
  | { readonly wait: true };

function wireTools(
  body: Record<string, unknown>,
): { name: string; namespace?: string; codeMode?: boolean }[] {
  const result: { name: string; namespace?: string; codeMode?: boolean }[] = [];
  const addTool = (spec: Record<string, unknown>, namespace?: string): void => {
    if (typeof spec.name !== "string") return;
    result.push({ name: spec.name, ...(namespace === undefined ? {} : { namespace }) });
    if (
      (spec.name === "exec" || spec.name.endsWith("__exec")) &&
      typeof spec.description === "string"
    ) {
      for (const match of spec.description.matchAll(/declare const tools: \{ (\w+)\(/gu))
        if (match[1] !== undefined) result.push({ name: match[1], codeMode: true });
    }
  };
  const definitions: unknown[] = Array.isArray(body.tools) ? body.tools : [];
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (isRecord(item) && item.type === "additional_tools" && Array.isArray(item.tools))
      definitions.push(...(item.tools as unknown[]));
  }
  for (const tool of definitions) {
    if (!isRecord(tool)) continue;
    if (tool.type === "namespace" && typeof tool.name === "string" && Array.isArray(tool.tools)) {
      for (const child of tool.tools) {
        if (isRecord(child)) addTool(child, tool.name);
      }
    } else {
      const spec = isRecord(tool.function) ? tool.function : tool;
      addTool(spec);
    }
  }
  return result;
}

export function toolNames(body: Record<string, unknown>): readonly string[] {
  return wireTools(body).map((tool) => (tool.namespace ? tool.namespace + "." : "") + tool.name);
}

export function historyText(body: Record<string, unknown>): string {
  return JSON.stringify(body.input ?? body.messages ?? []);
}

export function historyDocuments(body: Record<string, unknown>): Record<string, unknown>[] {
  const documents: Record<string, unknown>[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      try {
        visit(JSON.parse(value));
      } catch {
        if (value.includes("\n")) for (const line of value.split("\n")) visit(line);
      }
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (isRecord(value)) {
      if (Array.isArray(value.records) || typeof value.done === "boolean") documents.push(value);
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(body.input ?? body.messages);
  return documents;
}

function respond(
  response: ServerResponse,
  body: Record<string, unknown>,
  reply: Exclude<
    ModelReply,
    { error: number } | { disconnect: true } | { interruptStream: true } | { wait: true }
  >,
): void {
  const tool =
    "tool" in reply
      ? wireTools(body).find(
          (item) => item.name === reply.tool || item.name.endsWith("__" + reply.tool),
        )
      : undefined;
  if ("tool" in reply)
    assert.ok(
      tool,
      "The real Codex request must expose " + reply.tool + "; names=" + toolNames(body).join(","),
    );
  if (tool?.codeMode && "tool" in reply) {
    respond(response, body, {
      ...reply,
      tool: "exec",
      input: `text(JSON.stringify(await tools.${tool.name}(${JSON.stringify("input" in reply ? reply.input : reply.args)})));`,
    });
    return;
  }
  const id = "resp_" + randomUUID().replaceAll("-", "");
  const callId = "call_" + randomUUID().replaceAll("-", "");
  if (Array.isArray(body.messages) && typeof body.max_tokens === "number") {
    const content =
      tool === undefined
        ? { type: "text", text: "text" in reply ? reply.text : "" }
        : {
            type: "tool_use",
            id: callId,
            name: tool.name,
            input: "args" in reply ? reply.args : {},
          };
    const message = {
      id,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [content],
      stop_reason: tool === undefined ? "end_turn" : "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: reply.inputTokens ?? 100,
        output_tokens: 10,
        cache_read_input_tokens: reply.cachedInputTokens ?? 0,
        cache_creation_input_tokens: 0,
      },
    };
    if (body.stream !== true) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(message));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const event = (type: string, data: unknown) =>
      response.write("event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n");
    event("message_start", {
      type: "message_start",
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { ...message.usage, output_tokens: 0 },
      },
    });
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: tool === undefined ? { type: "text", text: "" } : { ...content, input: {} },
    });
    event("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta:
        tool === undefined
          ? { type: "text_delta", text: "text" in reply ? reply.text : "" }
          : {
              type: "input_json_delta",
              partial_json: JSON.stringify("args" in reply ? reply.args : {}),
            },
    });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
    event("message_delta", {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: 10 },
    });
    event("message_stop", { type: "message_stop" });
    response.end();
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  if (Array.isArray(body.messages)) {
    const chunk = (delta: unknown, finish: string | null = null) =>
      response.write(
        "data: " +
          JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created: 1700000000,
            model: body.model,
            choices: [{ index: 0, delta, finish_reason: finish }],
          }) +
          "\n\n",
      );
    chunk({
      role: "assistant",
      ...(tool === undefined
        ? { content: "text" in reply ? reply.text : "" }
        : {
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: {
                  name: tool.name,
                  arguments: JSON.stringify(
                    "input" in reply ? { input: reply.input } : "args" in reply ? reply.args : {},
                  ),
                },
              },
            ],
          }),
    });
    chunk({}, tool === undefined ? "stop" : "tool_calls");
    response.end("data: [DONE]\n\n");
    return;
  }
  let sequence = 0;
  const event = (type: string, data: Record<string, unknown>) =>
    response.write(
      "event: " +
        type +
        "\ndata: " +
        JSON.stringify({ type, sequence_number: sequence++, ...data }) +
        "\n\n",
    );
  const item =
    tool === undefined
      ? {
          type: "message",
          id: "msg_" + callId,
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "text" in reply ? reply.text : "", annotations: [] },
          ],
        }
      : "input" in reply
        ? {
            type: "custom_tool_call",
            id: "fc_" + callId,
            call_id: callId,
            name: tool.name,
            ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
            input: reply.input,
            status: "completed",
          }
        : {
            type: "function_call",
            id: "fc_" + callId,
            call_id: callId,
            name: tool.name,
            ...(tool.namespace === undefined ? {} : { namespace: tool.namespace }),
            arguments: JSON.stringify("args" in reply ? reply.args : {}),
            status: "completed",
          };
  const envelope = {
    id,
    object: "response",
    created_at: 1700000000,
    model: body.model,
    status: "in_progress",
    output: [],
  };
  event("response.created", { response: envelope });
  event("response.output_item.added", {
    output_index: 0,
    item: {
      ...item,
      status: "in_progress",
      ...(tool === undefined
        ? { content: [] }
        : "input" in reply
          ? { input: "" }
          : { arguments: "" }),
    },
  });
  if (tool !== undefined && !("input" in reply)) {
    event("response.function_call_arguments.delta", {
      item_id: item.id,
      output_index: 0,
      delta: "args" in reply ? JSON.stringify(reply.args) : "",
    });
    event("response.function_call_arguments.done", {
      item_id: item.id,
      output_index: 0,
      arguments: "args" in reply ? JSON.stringify(reply.args) : "",
    });
  } else if (tool !== undefined && "input" in reply) {
    event("response.custom_tool_call_input.delta", {
      item_id: item.id,
      output_index: 0,
      delta: reply.input,
    });
    event("response.custom_tool_call_input.done", {
      item_id: item.id,
      output_index: 0,
      input: reply.input,
    });
  } else if (tool === undefined) {
    const text = "text" in reply ? reply.text : "";
    event("response.content_part.added", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    event("response.output_text.delta", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: text,
    });
    event("response.output_text.done", {
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text,
    });
  }
  event("response.output_item.done", { output_index: 0, item });
  const inputTokens = reply.inputTokens ?? 100;
  event("response.completed", {
    response: {
      ...envelope,
      status: "completed",
      output: [item],
      usage: {
        input_tokens: inputTokens,
        output_tokens: 10,
        total_tokens: inputTokens + 10,
        input_tokens_details: { cached_tokens: reply.cachedInputTokens ?? 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  response.end();
}

export async function modelFixture(
  t: TestContext,
  next: (request: ModelRequest, index: number) => ModelReply | Promise<ModelReply>,
) {
  const requests: ModelRequest[] = [];
  const lookups: string[] = [];
  const failures: unknown[] = [];
  let upgrades = 0;
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" || request.method === "HEAD") {
        lookups.push(request.url ?? "");
        response.writeHead(404);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request as AsyncIterable<Uint8Array>)
        chunks.push(Buffer.from(chunk));
      assert.ok(chunks.length > 0, `Empty upstream request: ${request.method} ${request.url}`);
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      if (request.url?.includes("count_tokens")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      const entry = { path: request.url ?? "", body };
      requests.push(entry);
      const reply = await next(entry, requests.length - 1);
      if ("wait" in reply) return;
      if ("disconnect" in reply) {
        response.destroy();
        return;
      }
      if ("interruptStream" in reply) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
          'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_interrupted","status":"in_progress","output":[]}}\n\n',
        );
        setTimeout(() => response.destroy(), 50);
        return;
      }
      if ("error" in reply) {
        response.writeHead(reply.error, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: { type: "fixture_error", message: "Controlled upstream failure." },
          }),
        );
        return;
      }
      respond(response, body, reply);
    })().catch((error: unknown) => {
      failures.push(error);
      process.stderr.write(
        "Controlled upstream fixture failure: " +
          (error instanceof Error ? error.message : String(error)) +
          "\n",
      );
      response.destroy();
    });
  });
  server.on("upgrade", (_request, socket) => {
    upgrades++;
    socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      }),
    );
    assert.deepEqual(failures, []);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    lookups,
    port,
    url: `http://127.0.0.1:${port}/v1`,
    upgrades: () => upgrades,
  };
}

export function completeReviewScript({ continuation = false, compact = false } = {}) {
  let step = 0;
  let compacted = false;
  const calls: ModelReply[] = [
    ...(continuation ? [{ text: "I will continue the active review goal." }] : []),
    { tool: "submit_review", args: { summary: "Too early", findings: [], limitations: [] } },
    { tool: "read_review_briefing", args: {} },
    { tool: "list_repository_files", args: { revision: "head" } },
    { tool: "search_repository", args: { revision: "head", pattern: "after" } },
    { tool: "read_repository_file", args: { revision: "head", path: "missing.txt" } },
    { tool: "read_pr_diff", args: {} },
    { tool: "read_review_state", args: {} },
  ];
  return (request: ModelRequest): ModelReply => {
    if (compact && toolNames(request.body).length === 0) {
      compacted = true;
      return {
        text: "The briefing and changed-code diff were inspected. Recover host evidence through read_review_state and then submit the complete review.",
      };
    }
    const call = calls[step++];
    if (call !== undefined)
      return compact && "tool" in call && call.tool === "read_pr_diff"
        ? { ...call, inputTokens: 300_000 }
        : call;
    if (!historyText(request.body).includes("Review submission accepted.")) {
      if (compact) assert.equal(compacted, true, "The real native process must compact.");
      const docs = historyDocuments(request.body);
      const records: unknown[] = docs.flatMap((doc): unknown[] =>
        Array.isArray(doc.records) ? (doc.records as unknown[]) : [],
      );
      const evidence = records.find(
        (record) =>
          isRecord(record) &&
          record.kind === "evidence" &&
          isRecord(record.reference) &&
          record.reference.kind === "repository_diff" &&
          record.reference.status === "complete",
      );
      if (!isRecord(evidence) || !isRecord(evidence.reference))
        return { tool: "read_review_state", args: {} };
      return {
        tool: "submit_review",
        args: {
          summary: "Reviewed the change",
          limitations: [],
          findings: [
            {
              title: "Check the changed line",
              severity: "HIGH",
              why: "The changed value is unchecked.",
              fix: "Validate the value.",
              path: "review.txt",
              line: 2,
              evidenceRefs: [evidence.reference.id],
              countercheck: "Checked the complete changed-code diff for a guard.",
              counterevidenceRefs: [],
            },
          ],
        },
      };
    }
    return { text: "Review submitted." };
  };
}

export async function isolatedTemporaryRoot(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-codex-test-"));
  const previous = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previous;
  });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export async function nativeReview(
  t: TestContext,
  url: string,
  config = {},
  populate?: (root: string) => Promise<void>,
  contextFiles: readonly PreparedContextFile[] = [],
) {
  const controller = new AbortController();
  const cancel = () => {
    controller.abort(t.signal.reason);
  };
  t.signal.addEventListener("abort", cancel, { once: true });
  t.after(() => {
    t.signal.removeEventListener("abort", cancel);
  });
  const repository = await makeReplayRepository(t, populate);
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.temporaryRoot,
  );
  t.after(() => diff.cleanup());
  return runReviewGoalWithEmptyGuidance(
    "Inspect changed code.",
    0,
    repository.context,
    [
      {
        path: "review.txt",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        addedLines: new Set([2]),
      },
    ],
    emptyConversation,
    reviewConfig({
      executor: "codex",
      aiBaseUrl: url,
      model: "gpt-6.1-sol",
      effort: "high",
      maxTurns: 6,
      interactWithPullRequest: true,
      ...config,
    }),
    diff,
    repository.root,
    undefined,
    contextFiles,
    controller,
  );
}

export function sharedReviewScript({
  goalCount = 3,
  exhaust = false,
  compact = false,
  partial = false,
} = {}) {
  const shared = goalCount > 1;
  let discoveryStep = 0;
  let compacted = false;
  const steps = new Map<string, number>();
  const reads: { goal: string; tool: string }[] = [];
  const next = ({ body }: ModelRequest): ModelReply => {
    const history = historyText(body);
    if (toolNames(body).length === 0) {
      compacted = true;
      return {
        text: "The shared orientation read the overview, briefing and review.txt diff. The change adds an unchecked value. Finish a neutral map with explicit unknowns.",
      };
    }
    const label = ["ALPHA", "BETA", "GAMMA"].find((name) => history.includes("GOAL_" + name));
    if (label === undefined) {
      if (history.includes("Discovery change map accepted."))
        return { text: "Orientation complete." };
      if (
        history.includes("Finish the change map from evidence already delivered") ||
        (exhaust && discoveryStep >= 17)
      )
        return {
          tool: "finish_discovery",
          args: {
            changeMap:
              "Intent: add a value to review.txt. Area: the text consumer. Entry points and tests need further investigation. Unknowns: surrounding consumers were not read.",
          },
        };
      const sequence: ModelReply[] = [
        { tool: "read_change_overview", args: {} },
        {
          tool: "read_pr_diff",
          args: { paths: ["review.txt"] },
          ...(compact ? { inputTokens: 300_000 } : {}),
        },
        {
          tool: "finish_discovery",
          args: {
            changeMap:
              "Intent: append a value in review.txt. Area: the text consumer. Entry point: review.txt. Tests and consumers remain unknown; reviewers must investigate independently.",
          },
        },
      ];
      const reply: ModelReply = exhaust
        ? { tool: "read_change_overview", args: {} }
        : (sequence[discoveryStep] ?? { text: "Orientation complete." });
      discoveryStep++;
      if ("tool" in reply && reply.tool.startsWith("read_"))
        reads.push({ goal: "discovery", tool: reply.tool });
      return reply;
    }
    if (shared) {
      assert.ok(
        toolNames(body).every((name) => !/shell|exec_command|web_search|spawn_agent/u.test(name)),
        "Forked reviewers must retain the disabled native-tool boundaries.",
      );
      assert.ok(history.includes("Intent: ") || compacted, "The native fork must inherit the map.");
      if (!compacted)
        assert.ok(
          history.includes("+after") || (partial && history.includes("+" + "x".repeat(50))),
          "The native fork must inherit actual selected source results.",
        );
      assert.ok(
        history.includes(privatePaths.get(label) ?? "missing"),
        "The first child request must contain its authorized context index.",
      );
      assert.ok(
        history.includes("FULL_GOAL_END_" + label),
        "The first child request must contain the full goal beyond the native command limit.",
      );
    }
    if (history.includes("Review submission accepted.")) return { text: "Review complete." };
    const step = steps.get(label) ?? 0;
    steps.set(label, step + 1);
    const calls: ModelReply[] = [
      { tool: "read_review_briefing", args: {} },
      ...(!shared || partial ? [{ tool: "read_pr_diff", args: { remaining: true } } as const] : []),
      { tool: "read_review_state", args: {} },
      { tool: "read_context_file", args: { path: privatePaths.get(label) ?? "missing" } },
      {
        tool: "read_repository_file",
        args: { revision: "head", path: label.toLowerCase() + ".txt" },
      },
      {
        tool: "submit_review",
        args: { summary: "Checked the goal independently.", findings: [], limitations: [] },
      },
    ];
    for (const sibling of ["ALPHA", "BETA", "GAMMA"].filter((name) => name !== label)) {
      assert.ok(!history.includes("GOAL_" + sibling));
      assert.ok(!history.includes("PRIVATE_" + sibling + "_DATA"));
      assert.ok(!history.includes("LATER_" + sibling + "_SOURCE"));
    }
    const reply = calls[step] ?? { text: "Review complete." };
    if ("tool" in reply && reply.tool.startsWith("read_"))
      reads.push({ goal: label, tool: reply.tool });
    return reply;
  };
  const privatePaths = new Map<string, string>();
  return { next, reads, privatePaths, partial, goalCount };
}

export async function sharedReviewRun(
  t: TestContext,
  url: string,
  executor: ReviewExecutor,
  script: ReturnType<typeof sharedReviewScript>,
  overrides: Partial<ReviewConfig> = {},
  lifecycle: {
    readonly controller?: AbortController;
    readonly runner?: typeof runReviewGoals;
    readonly expectedStatuses?: readonly string[];
  } = {},
) {
  const temporary = await isolatedTemporaryRoot(t);
  const repository = await makeReplayRepository(t, async (root) => {
    for (const label of ["ALPHA", "BETA", "GAMMA"])
      await writeFile(join(root, label.toLowerCase() + ".txt"), "LATER_" + label + "_SOURCE\n");
  });
  let context = repository.context;
  if (script.partial) {
    await writeFile(join(repository.root, "review.txt"), "before\n" + "x".repeat(4300) + "\n");
    const headSha = await commitFixtureSnapshot(
      repository.root,
      repository.temporaryRoot,
      repository.headSha,
    );
    context = { ...context, headSha };
  }
  const goals = [];
  for (const label of ["ALPHA", "BETA", "GAMMA"].slice(0, script.goalCount)) {
    const path = join(temporary, label + ".txt");
    await writeFile(path, "PRIVATE_" + label + "_DATA");
    script.privatePaths.set(label, path);
    goals.push({
      prompt:
        "GOAL_" +
        label +
        ": independently inspect the change. " +
        "Goal detail. ".repeat(400) +
        "FULL_GOAL_END_" +
        label,
      files: [path],
    });
  }
  const prepared = await prepareContextFiles(goals, repository.root);
  const controller = lifecycle.controller ?? new AbortController();
  const cancel = () => {
    controller.abort(t.signal.reason);
  };
  t.signal.addEventListener("abort", cancel, { once: true });
  t.after(() => {
    t.signal.removeEventListener("abort", cancel);
  });
  try {
    const config = reviewConfig({
      executor,
      aiBaseUrl: executor === "claude" ? url.replace(/\/v1$/u, "") : url,
      model: executor === "claude" ? "claude-sonnet-4-5" : "gpt-6.1-sol",
      effort: "high",
      maxTurns: 20,
      reviewPrompts: goals,
      parallelCount: 2,
      autoApprove: true,
      ...overrides,
    });
    const run = await (lifecycle.runner ?? runReviewGoals)(
      context,
      [
        {
          path: "review.txt",
          status: "modified",
          additions: 1,
          deletions: 0,
          changes: 1,
          addedLines: new Set([2]),
        },
      ],
      emptyConversation,
      config,
      prepared.filesByGoal,
      repository.root,
      undefined,
      controller,
      { linkedIssues: [], linkedIssueReferencesTruncated: false, repositoryGuidance: [] },
    );
    assert.deepEqual(
      run.goals.map((goal) => goal.status),
      lifecycle.expectedStatuses ?? goals.map(() => "completed"),
      JSON.stringify(run),
    );
    for (const goal of run.goals)
      if (goal.status === "completed")
        assert.deepEqual(goal.inspection, {
          observedPaths: ["review.txt"],
          missingPaths: [],
          lineCoverage: [{ path: "review.txt", addedLines: [[2, 3]], deletedLines: [] }],
        });
    return { run, config, context };
  } finally {
    await prepared.cleanup();
    assert.equal(
      (await readdir(temporary)).some((name) => name.startsWith("ai-pr-reviewer-discovery-")),
      false,
      "The run owner must remove discovery storage after all child shutdowns.",
    );
  }
}
