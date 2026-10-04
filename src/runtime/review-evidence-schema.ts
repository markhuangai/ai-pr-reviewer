import { z } from "zod";

export const evidenceRefSchema = z.string().regex(/^ev-[1-9][0-9]{0,8}$/u);
export const pathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((path) => path.trim().length > 0);

export const reviewLimitationSchema = z
  .object({
    paths: z.array(pathSchema).max(100),
    reason: z.string().trim().min(1).max(1_000),
  })
  .strict();

export const findingEvidenceShape = {
  evidenceRefs: z.array(evidenceRefSchema).min(1).max(200),
  countercheck: z.string().trim().min(1).max(1_000),
  counterevidenceRefs: z.array(evidenceRefSchema).max(200),
};

export const reviewEvidenceResultSchema = z
  .object({
    id: evidenceRefSchema,
    kind: z.enum([
      "repository_diff",
      "repository_file",
      "repository_read",
      "repository_search",
      "repository_glob",
      "context_file",
      "conversation",
      "briefing",
      "external_tool",
    ]),
    status: z.enum(["complete", "partial", "failed"]),
    completedBy: evidenceRefSchema.optional(),
    path: pathSchema.optional(),
    paths: z.array(pathSchema).max(50).optional(),
    revision: z.enum(["base", "head"]).optional(),
    mergeBaseSha: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu)
      .optional(),
    headSha: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu)
      .optional(),
    changedPaths: z.boolean().optional(),
    contentKind: z.enum(["text", "binary", "non_regular", "missing"]).optional(),
    bounds: z
      .object({
        byteStart: z.number().int().nonnegative().optional(),
        byteEnd: z.number().int().nonnegative().optional(),
        totalBytes: z.number().int().nonnegative().optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().nonnegative().optional(),
        headLimit: z.number().int().nonnegative().optional(),
        pages: z.string().min(1).max(100).optional(),
        truncated: z.boolean().optional(),
        startLine: z.number().int().positive().optional(),
        numLines: z.number().int().nonnegative().optional(),
        totalLines: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
