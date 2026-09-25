import { strict as assert } from "node:assert";
import type {
  HookInput,
  Options,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  agentInternals,
  makeRepository,
  makeDiffFromSnapshots,
  writeFile,
  join,
  reviewConfig,
  type AgentQuery,
  type RegisteredToolResult,
  type TestContext,
} from "./agent-test-helpers.js";
import type { ReviewEvidenceReference } from "../src/lib/types.js";

export const recoveryConfig = (overrides: Parameters<typeof reviewConfig>[0] = {}) =>
  reviewConfig({ maxTurns: 100, ...overrides });

export interface ReviewProtocol {
  readonly options: Options;
  readonly messages: AsyncIterator<SDKUserMessage>;
  readonly closed: Promise<void>;
  call(
    name: string,
    input: Record<string, unknown>,
    batch?: boolean,
  ): AsyncGenerator<SDKMessage, RegisteredToolResult>;
}

export function reviewProtocolQuery(
  exercise: (protocol: ReviewProtocol) => AsyncGenerator<SDKMessage>,
  statuses: readonly Record<string, unknown>[] = [],
): AgentQuery {
  return (({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const messages = prompt[Symbol.asyncIterator]();
    const client = new Client({ name: "review-protocol-test", version: "1" });
    const server = (options.mcpServers?.review_output as unknown as { instance: McpServer })
      .instance;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const signal = new AbortController().signal;
    let sequence = 0;
    let close: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      close = resolve;
    });
    const protocol: ReviewProtocol = {
      options,
      messages,
      closed,
      async *call(name, input, batch = true) {
        const id = `protocol-${++sequence}`;
        const toolName = `mcp__review_output__${name}`;
        const use = {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "tool_use", id, name: toolName, input }],
          },
        } as SDKMessage;
        yield use;
        yield use;
        const hookBase = {
          session_id: "protocol",
          transcript_path: "",
          cwd: options.cwd ?? "",
          tool_name: toolName,
          tool_input: input,
          tool_use_id: id,
        };
        for (const matcher of options.hooks?.PreToolUse ?? []) {
          if (matcher.matcher !== undefined && !new RegExp(matcher.matcher, "u").test(toolName))
            continue;
          for (const hook of matcher.hooks)
            await hook({ ...hookBase, hook_event_name: "PreToolUse" }, id, {
              signal,
            });
        }
        const response = (await client.callTool({
          name,
          arguments: input,
        })) as RegisteredToolResult;
        if (batch)
          for (const matcher of options.hooks?.PostToolBatch ?? [])
            for (const hook of matcher.hooks) {
              const observation: HookInput = {
                ...hookBase,
                hook_event_name: "PostToolBatch",
                tool_calls: [{ ...hookBase, tool_response: response }],
              };
              await hook(observation, undefined, { signal });
              await hook(observation, undefined, { signal });
            }
        const result = {
          type: "user",
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: id,
                is_error: response.isError === true,
                content: response.content,
              },
            ],
          },
        } as SDKMessage;
        yield result;
        yield result;
        return response;
      },
    };
    return {
      async *[Symbol.asyncIterator]() {
        assert.equal((await messages.next()).done, false);
        assert.equal((await messages.next()).done, false);
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        try {
          yield* exercise(protocol);
        } finally {
          await client.close();
          await server.close();
        }
      },
      mcpServerStatus: () => Promise.resolve(statuses),
      interrupt: () => Promise.resolve(),
      close: () => {
        close?.();
      },
    };
  }) as unknown as AgentQuery;
}

interface RecoveryState {
  readonly manifest: readonly { path: string }[];
  readonly evidence: readonly ReviewEvidenceReference[];
  readonly gaps: readonly { category: string; paths: readonly string[] }[];
  readonly remainingCorrections: number;
  readonly remainingInspectionCycles: number;
  readonly inspectionContinuations: number;
  readonly validationFailures: number;
  readonly consecutiveNoProgress: number;
  readonly uniqueSourceBytes: number;
  readonly repeatedSourceBytes: number;
  readonly submissionAttempts: number;
  readonly headSha: string;
  readonly inspection: { observed: number; missing: number };
  readonly calls: readonly { kind: string; tool: string; arguments: Record<string, unknown> }[];
}

export function protocolDocument(response: {
  readonly content: readonly { readonly text?: string }[];
}): Record<string, unknown> {
  return JSON.parse(response.content[0]?.text ?? "{}") as Record<string, unknown>;
}

export function normalizeState(pages: readonly Record<string, unknown>[]): RecoveryState {
  const records = pages.flatMap((page) => page.records as Record<string, unknown>[]);
  return {
    ...pages[0],
    manifest: records.filter((record) => record.kind === "changed_file"),
    evidence: records
      .filter((record) => record.kind === "evidence")
      .map((record) => record.reference),
    gaps: records.filter((record) => record.kind === "gap"),
    calls: records.filter((record) => record.kind === "next_call" || record.kind === "active_read"),
  } as unknown as RecoveryState;
}

export async function* recoveryState(
  protocol: ReviewProtocol,
  paths?: string[],
): AsyncGenerator<SDKMessage, RecoveryState> {
  let cursor: string | undefined;
  const pages: Record<string, unknown>[] = [];
  for (;;) {
    const response = yield* protocol.call("read_review_state", {
      ...(paths === undefined ? {} : { paths }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    assert.ok(
      Buffer.byteLength(JSON.stringify(response)) <= agentInternals.MODEL_TOOL_RESULT_BYTES,
    );
    const page = protocolDocument(response);
    assert.ok(Array.isArray(page.records));
    assert.equal(page.content, undefined);
    pages.push(page);
    if (page.done === true) return normalizeState(pages);
    cursor = String(page.nextCursor);
  }
}

export async function* protocolBriefing(protocol: ReviewProtocol): AsyncGenerator<SDKMessage> {
  let done = false;
  while (!done)
    done = protocolDocument(yield* protocol.call("read_review_briefing", {})).done === true;
}

export function protocolResult(subtype = "success"): SDKResultMessage {
  return {
    type: "result",
    subtype,
    errors: subtype === "success" ? [] : [subtype],
    num_turns: 2,
    modelUsage: {},
  } as SDKResultMessage;
}

export async function recoveryRepository(t: TestContext) {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "review.txt"), "changed line\n");
    await writeFile(join(root, "unread.txt"), "unseen change\n");
  });
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.temporaryRoot,
  );
  t.after(() => diff.cleanup());
  return { ...repository, diff };
}
