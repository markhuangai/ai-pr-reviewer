import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { ReviewToolDefinition } from "./executor.js";

const INTERNAL_TOKEN_ENV = "AI_PR_REVIEWER_INTERNAL_MCP_TOKEN";

function authorized(value: string | undefined, token: string): boolean {
  if (value === undefined) return false;
  const expected = Buffer.from(`Bearer ${token}`, "utf8");
  const actual = Buffer.from(value, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function jsonError(response: ServerResponse, status: number): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32_000, message: status === 401 ? "Unauthorized" : "Request rejected" },
      id: null,
    }),
  );
}

export interface CodexMcpServer {
  readonly url: string;
  readonly token: string;
  readonly tokenEnvironmentVariable: string;
  failure(): Error | undefined;
  close(): Promise<void>;
}

function createMcpServer(tools: readonly ReviewToolDefinition[], instructions: string): McpServer {
  const mcp = new McpServer({ name: "review_output", version: "1.0.0" }, { instructions });
  for (const definition of tools) {
    mcp.registerTool(
      definition.name,
      {
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      (input) => definition.handler(input),
    );
  }
  return mcp;
}

export async function startCodexMcpServer(
  tools: readonly ReviewToolDefinition[],
  instructions: string,
): Promise<CodexMcpServer> {
  const validationServer = createMcpServer(tools, instructions);
  await validationServer.close();
  const token = randomBytes(32).toString("base64url");
  let expectedHost = "";
  let serverFailure: Error | undefined;
  let closed = false;
  interface ActiveRequest {
    readonly close: () => Promise<void>;
  }
  const activeRequests = new Set<ActiveRequest>();
  const http = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (request.headers.host !== expectedHost || path !== "/mcp") {
        jsonError(response, 403);
        return;
      }
      if (!authorized(request.headers.authorization, token)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        jsonError(response, 401);
        return;
      }
      if (closed) {
        jsonError(response, 503);
        return;
      }
      // Each Codex turn starts a fresh CLI process, and MCP stateless mode requires one transport per HTTP request.
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true,
        enableDnsRebindingProtection: true,
        allowedHosts: [expectedHost],
      });
      transport.onerror = (error) => {
        serverFailure = error;
      };
      const mcp = createMcpServer(tools, instructions);
      let requestClosed = false;
      const active: ActiveRequest = {
        close: async () => {
          if (requestClosed) return;
          requestClosed = true;
          activeRequests.delete(active);
          await mcp.close();
        },
      };
      activeRequests.add(active);
      response.once("close", () => {
        void active.close().catch((error: unknown) => {
          serverFailure = error instanceof Error ? error : new Error(String(error));
        });
      });
      try {
        // MCP SDK 1.30's exact-optional transport declarations are not self-assignable under TS 6.
        await mcp.connect(transport as unknown as Transport);
        await transport.handleRequest(request, response);
      } catch (error) {
        const [cleanupFailure] = await Promise.allSettled([active.close()]);
        if (cleanupFailure.status === "rejected") {
          throw new AggregateError(
            [error, cleanupFailure.reason],
            "Codex MCP request and cleanup failed.",
            { cause: error },
          );
        }
        throw error;
      }
    })().catch((error: unknown) => {
      serverFailure = error instanceof Error ? error : new Error(String(error));
      if (!response.headersSent) jsonError(response, 500);
      else response.destroy(serverFailure);
    });
  });
  http.on("clientError", (error, socket) => {
    serverFailure = error;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => {
      reject(error);
    };
    http.once("error", fail);
    http.listen(0, "127.0.0.1", () => {
      http.off("error", fail);
      resolve();
    });
  });
  const address = http.address() as AddressInfo | null;
  if (address === null) {
    await new Promise<void>((resolve) => {
      http.close(() => {
        resolve();
      });
    });
    throw new Error("The Codex MCP server did not bind a loopback address.");
  }
  expectedHost = `127.0.0.1:${address.port}`;
  return {
    url: `http://${expectedHost}/mcp`,
    token,
    tokenEnvironmentVariable: INTERNAL_TOKEN_ENV,
    failure: () => serverFailure,
    close: async () => {
      if (closed) return;
      closed = true;
      const outcomes = await Promise.allSettled([
        ...Array.from(activeRequests, (active) => active.close()),
        new Promise<void>((resolve, reject) => {
          http.close((error) => {
            if (error === undefined) resolve();
            else reject(error);
          });
        }),
      ]);
      const failure = outcomes.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      if (failure !== undefined) throw failure.reason;
    },
  };
}

export const codexMcpServerInternals = { authorized };
