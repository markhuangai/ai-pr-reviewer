import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ReviewTool } from "./review-tool.js";

export interface CodexMcpServer {
  readonly url: string;
  readonly token: string;
  failure(): Error | undefined;
  close(): Promise<void>;
}

export async function startCodexMcpServer(
  name: string,
  tools: readonly ReviewTool[],
  invoke: (definition: ReviewTool, input: Record<string, unknown>) => Promise<CallToolResult>,
): Promise<CodexMcpServer> {
  const token = randomBytes(32).toString("base64url");
  let host = "";
  let failure: Error | undefined;
  const active = new Set<McpServer>();
  const makeServer = (): McpServer => {
    const mcp = new McpServer({ name, version: "1.0.0" });
    for (const definition of tools) {
      mcp.registerTool(
        definition.name,
        { description: definition.description, inputSchema: definition.inputSchema },
        (input) => invoke(definition, input as Record<string, unknown>),
      );
    }
    return mcp;
  };
  const validation = makeServer();
  await validation.close();
  const http = createServer((request, response) => {
    const expected = Buffer.from("Bearer " + token);
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const status =
      request.headers.host !== host || request.url !== "/mcp"
        ? 403
        : supplied.length !== expected.length || !timingSafeEqual(supplied, expected)
          ? 401
          : undefined;
    if (status !== undefined) {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Request rejected." },
        }),
      );
      return;
    }
    void (async () => {
      const mcp = makeServer();
      active.add(mcp);
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [host],
      });
      const finish = async (): Promise<void> => {
        if (!active.delete(mcp)) return;
        await mcp.close();
      };
      response.once("close", () => {
        void finish().catch((error: unknown) => {
          failure = error instanceof Error ? error : new Error(String(error));
        });
      });
      try {
        await mcp.connect(transport as unknown as Transport);
        await transport.handleRequest(request, response);
      } catch (error) {
        await finish();
        throw error;
      }
    })().catch((error: unknown) => {
      failure = error instanceof Error ? error : new Error(String(error));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.off("error", reject);
      resolve();
    });
  });
  const address = http.address() as AddressInfo;
  host = `127.0.0.1:${address.port}`;
  return {
    url: "http://" + host + "/mcp",
    token,
    failure: () => failure,
    close: async () => {
      http.closeAllConnections();
      await Promise.all([
        ...[...active].map((mcp) => mcp.close()),
        new Promise<void>((resolve, reject) =>
          http.close((error) => {
            if (error) reject(error);
            else resolve();
          }),
        ),
      ]);
      if (failure !== undefined) throw failure;
    },
  };
}
