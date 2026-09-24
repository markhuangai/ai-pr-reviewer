import { strict as assert } from "node:assert";
import type {
  HookInput,
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AgentQuery, RegisteredToolResult } from "./agent-test-helpers.js";

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
