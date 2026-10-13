import { tool as claudeTool } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { z } from "zod";

export interface ReviewTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly alwaysLoad: boolean;
  readonly handler: (input: Record<string, unknown>) => Promise<CallToolResult>;
}

export function tool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: (input: z.infer<z.ZodObject<Shape>>) => Promise<CallToolResult>,
  options: { readonly alwaysLoad?: boolean } = {},
): ReviewTool {
  return {
    name,
    description,
    inputSchema,
    handler: (input) => handler(input as z.infer<z.ZodObject<Shape>>),
    alwaysLoad: options.alwaysLoad ?? false,
  };
}

export function toClaudeTool(definition: ReviewTool) {
  return claudeTool(
    definition.name,
    definition.description,
    definition.inputSchema,
    definition.handler,
    { alwaysLoad: definition.alwaysLoad },
  );
}
