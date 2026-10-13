import { z } from "zod";
import { throwIfAborted } from "../lib/bootstrap/cancellation.js";
import { jsonToolResult } from "./agent-review-tools.js";
import type { ReviewQueryReaderStore } from "./review-context-tools.js";
import type { RepositoryQuerySource, RepositorySnapshot } from "./repository-snapshot.js";
import { tool, type ReviewTool } from "./review-tool.js";

export function createRepositoryDiscoveryTools({
  snapshot,
  readers,
  isActive,
  signal,
}: {
  snapshot: RepositorySnapshot;
  readers: ReviewQueryReaderStore;
  isActive: () => boolean;
  signal?: AbortSignal | undefined;
}): readonly ReviewTool[] {
  const page = async (
    source: Promise<RepositoryQuerySource>,
    selector: Record<string, unknown>,
  ) => {
    const query = readers.createSource(await source, "discovery", { selector });
    return readers.readPage(query.cursor, "discovery", { selector });
  };
  const inactive = () => ({
    content: [{ type: "text" as const, text: "Wait for the full review prompt before reading." }],
  });
  return [
    tool(
      "list_repository_files",
      "List tracked file paths at the immutable base or head. This is discovery, not source inspection.",
      {
        revision: z.enum(["base", "head"]),
        path: z.string().min(1).max(4_096).optional(),
        cursor: z.string().min(1).max(100).optional(),
      },
      async ({ revision, path, cursor }) => {
        throwIfAborted(signal);
        if (!isActive()) return inactive();
        const selector = { revision, ...(path === undefined ? {} : { path }) };
        return cursor === undefined
          ? page(snapshot.list(revision, path), selector)
          : readers.readPage(cursor, "discovery", { selector });
      },
      { alwaysLoad: true },
    ),
    tool(
      "search_repository",
      "Search immutable tracked text using an extended regular expression. Read matching source files to obtain finding evidence.",
      {
        revision: z.enum(["base", "head"]),
        pattern: z.string().min(1).max(1_000),
        paths: z.array(z.string().min(1).max(4_096)).max(20).optional(),
        cursor: z.string().min(1).max(100).optional(),
      },
      async ({ revision, pattern, paths, cursor }) => {
        throwIfAborted(signal);
        if (!isActive()) return inactive();
        const selector = { revision, pattern, paths: paths ?? [] };
        if (cursor !== undefined) return readers.readPage(cursor, "discovery", { selector });
        if (pattern.includes("\0"))
          return {
            ...jsonToolResult({ error: "Search patterns cannot contain NUL." }),
            isError: true,
          };
        return page(snapshot.search(revision, pattern, paths), selector);
      },
      { alwaysLoad: true },
    ),
  ];
}
