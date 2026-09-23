import { execFile } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { z } from "zod";

import { aggregateReview } from "../src/lib/aggregate.js";
import { prepareContextFiles } from "../src/lib/context-files.js";
import { readGitMergeBase } from "../src/lib/git-changed-files.js";
import { readPullRequestFilesFromCheckout } from "../src/lib/github-api.js";
import { REVIEW_INPUT_LIMITS, reviewSecretCandidates } from "../src/lib/input.js";
import type { ReviewConversationSnapshot } from "../src/lib/review-context.js";
import { redact, redactGoalResults } from "../src/lib/redaction.js";
import { emptyReviewBriefing } from "../src/lib/review-evidence.js";
import type { GoalResult, PullRequestContext, ReviewConfig } from "../src/lib/types.js";
import { runReviewGoals } from "../src/runtime/agent.js";
import { isWithinRepository } from "../src/runtime/agent-review-tools.js";

const execFileAsync = promisify(execFile);
const SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const httpUrlSchema = z
  .string()
  .trim()
  .max(REVIEW_INPUT_LIMITS.maxUrlLength)
  .pipe(z.url())
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  });
const mcpUrlSchema = z
  .string()
  .trim()
  .max(REVIEW_INPUT_LIMITS.maxUrlLength)
  .pipe(z.url())
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  });

const contextSchema = z
  .object({
    repository: z.string().min(1),
    owner: z.string().min(1),
    name: z.string().min(1),
    number: z.number().int().positive(),
    headSha: z.string().regex(SHA_PATTERN),
    baseSha: z.string().regex(SHA_PATTERN),
    baseRef: z.string().min(1),
    changedFiles: z.number().int().nonnegative().optional(),
    title: z.string(),
    body: z.string().optional(),
    htmlUrl: z.url(),
  })
  .strict();

const goalSchema = z
  .object({
    prompt: z.string().trim().min(1).max(REVIEW_INPUT_LIMITS.maxPromptLength),
    files: z
      .array(
        z
          .string()
          .min(1)
          .max(REVIEW_INPUT_LIMITS.maxContextFilePathLength)
          .refine((path) => isAbsolute(path) && normalize(path) === path),
      )
      .max(REVIEW_INPUT_LIMITS.maxContextFilesPerPrompt)
      .superRefine((files, context) => {
        if (new Set(files).size !== files.length)
          context.addIssue({ code: "custom", message: "Goal files must not contain duplicates." });
      })
      .default([]),
  })
  .strict();

const mcpToolSchema = z
  .object({
    name: z.string().trim().min(1).max(REVIEW_INPUT_LIMITS.maxMcpToolNameLength),
    permission_policy: z.enum(["always_allow", "always_ask", "always_deny"]).optional(),
    org_max_permission: z.enum(["allow", "ask", "blocked"]).optional(),
  })
  .strict();

const mcpServerSchema = z
  .object({
    type: z.literal("http"),
    url: mcpUrlSchema,
    headers: z
      .record(
        z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u),
        z.string().trim().min(1).max(4_096),
      )
      .refine(
        (headers) => Object.keys(headers).length <= REVIEW_INPUT_LIMITS.maxMcpHeaders,
        `At most ${REVIEW_INPUT_LIMITS.maxMcpHeaders} MCP headers are supported.`,
      )
      .optional(),
    tools: z.array(mcpToolSchema).max(REVIEW_INPUT_LIMITS.maxMcpToolPolicies).optional(),
    timeout: z
      .number()
      .int()
      .min(REVIEW_INPUT_LIMITS.minMcpTimeout)
      .max(REVIEW_INPUT_LIMITS.maxMcpTimeout)
      .optional(),
    alwaysLoad: z.boolean().optional(),
  })
  .strict();

const pricingSchema = z
  .object({
    currency: z.string().min(1).max(REVIEW_INPUT_LIMITS.maxCurrencyLength),
    models: z
      .record(
        z
          .string()
          .min(1)
          .max(REVIEW_INPUT_LIMITS.maxModelNameLength)
          .refine((model) => model.trim().length > 0),
        z
          .object({
            input: z.number().nonnegative(),
            output: z.number().nonnegative(),
            cacheHit: z.number().nonnegative(),
            cacheCreation: z.number().nonnegative(),
          })
          .strict(),
      )
      .refine(
        (models) =>
          Object.keys(models).length > 0 &&
          Object.keys(models).length <= REVIEW_INPUT_LIMITS.maxPricedModels,
        `Model pricing supports 1 to ${REVIEW_INPUT_LIMITS.maxPricedModels} models.`,
      ),
  })
  .strict();

const caseSchema = z
  .object({
    version: z.literal(1),
    caseId: z.string().trim().min(1).max(200),
    labels: z.unknown().optional(),
    context: contextSchema,
    config: z
      .object({
        aiBaseUrl: httpUrlSchema.optional(),
        model: z.string().trim().min(1),
        effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
        systemPrompt: z.string().trim().optional(),
        modelPricing: pricingSchema.optional(),
        reviewPrompts: z.array(goalSchema).min(1).max(REVIEW_INPUT_LIMITS.maxPrompts),
        parallelCount: z
          .number()
          .int()
          .min(REVIEW_INPUT_LIMITS.minParallelCount)
          .max(REVIEW_INPUT_LIMITS.maxParallelCount)
          .default(5),
        maxTurns: z
          .number()
          .int()
          .min(REVIEW_INPUT_LIMITS.minMaxTurns)
          .max(REVIEW_INPUT_LIMITS.maxMaxTurns)
          .default(50),
        autoApprove: z.boolean().default(false),
        interactWithPullRequest: z.boolean().default(true),
        mcpServers: z
          .record(
            z
              .string()
              .max(REVIEW_INPUT_LIMITS.maxMcpServerNameLength)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u)
              .refine((name) => name !== "review_output", {
                message: "review_output is reserved for the internal review output tool.",
              }),
            mcpServerSchema,
          )
          .refine(
            (servers) => Object.keys(servers).length <= REVIEW_INPUT_LIMITS.maxMcpServers,
            `At most ${REVIEW_INPUT_LIMITS.maxMcpServers} MCP servers are supported.`,
          )
          .default({}),
      })
      .strict(),
    conversation: z
      .object({ digest: z.string().min(1), entries: z.array(z.unknown()) })
      .strict()
      .optional(),
    briefing: z
      .object({
        linkedIssues: z
          .array(
            z.object({
              number: z.number().int().positive(),
              title: z.string(),
              state: z.string(),
              body: z.string(),
              htmlUrl: z.url(),
            }),
          )
          .default([]),
        linkedIssueReferencesTruncated: z.boolean().default(false),
      })
      .strict()
      .optional(),
  })
  .superRefine((input, context) => {
    const uniqueFiles = new Set(input.config.reviewPrompts.flatMap((goal) => goal.files));
    if (uniqueFiles.size > REVIEW_INPUT_LIMITS.maxContextFilesPerRun)
      context.addIssue({
        code: "custom",
        message: `At most ${REVIEW_INPUT_LIMITS.maxContextFilesPerRun} unique context files are supported.`,
        path: ["config", "reviewPrompts"],
      });
  })
  .strict();

export type ReplayCase = z.infer<typeof caseSchema>;

function pullRequestContext(context: ReplayCase["context"]): PullRequestContext {
  return {
    repository: context.repository,
    owner: context.owner,
    name: context.name,
    number: context.number,
    headSha: context.headSha,
    baseSha: context.baseSha,
    baseRef: context.baseRef,
    ...(context.changedFiles === undefined ? {} : { changedFiles: context.changedFiles }),
    title: context.title,
    ...(context.body === undefined ? {} : { body: context.body }),
    htmlUrl: context.htmlUrl,
  };
}

export interface ReplayOutput {
  readonly version: 1;
  readonly caseId: string;
  readonly labels?: unknown;
  readonly repository: string;
  readonly pullRequest: number;
  readonly baseSha: string;
  readonly mergeBaseSha: string;
  readonly headSha: string;
  readonly partial: boolean;
  readonly allGoalsFailed: boolean;
  readonly findings: unknown;
  readonly goals: readonly Omit<GoalResult, "prompt">[];
}

export type ReplayRunner = typeof runReviewGoals;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return result.stdout;
  } catch (error) {
    throw new Error(`Replay Git ${args[0] ?? "command"} failed: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

async function verifyCheckout(cwd: string, context: PullRequestContext): Promise<string> {
  const root = await realpath(cwd);
  const topLevel = await realpath((await git(root, ["rev-parse", "--show-toplevel"])).trim());
  if (topLevel !== root) throw new Error("Replay checkout must be the repository root.");
  const status = await git(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  if (status.trim().length > 0)
    throw new Error("Replay checkout must be pristine, including ignored files.");
  const headSha = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  if (headSha.toLowerCase() !== context.headSha.toLowerCase()) {
    throw new Error(`Replay checkout HEAD ${headSha} does not match case head ${context.headSha}.`);
  }
  const baseSha = (
    await git(root, ["rev-parse", "--verify", `${context.baseSha}^{commit}`])
  ).trim();
  if (baseSha.toLowerCase() !== context.baseSha.toLowerCase()) {
    throw new Error("Replay case base SHA does not resolve to the recorded commit.");
  }
  const mergeBaseSha = await readGitMergeBase(root, context.baseSha, context.headSha);
  return mergeBaseSha;
}

function replayMcpServers(servers: ReplayCase["config"]["mcpServers"]): ReviewConfig["mcpServers"] {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      {
        type: server.type,
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: server.headers }),
        ...(server.tools === undefined
          ? {}
          : {
              tools: server.tools.map((toolPolicy) => ({
                name: toolPolicy.name,
                ...(toolPolicy.permission_policy === undefined
                  ? {}
                  : { permission_policy: toolPolicy.permission_policy }),
                ...(toolPolicy.org_max_permission === undefined
                  ? {}
                  : { org_max_permission: toolPolicy.org_max_permission }),
              })),
            }),
        ...(server.timeout === undefined ? {} : { timeout: server.timeout }),
        ...(server.alwaysLoad === undefined ? {} : { alwaysLoad: server.alwaysLoad }),
      },
    ]),
  );
}

function replayConfig(input: ReplayCase["config"]): ReviewConfig {
  const aiSecret = process.env.AI_PR_REVIEWER_SECRET ?? process.env.ANTHROPIC_API_KEY;
  if (aiSecret === undefined || aiSecret.length === 0) {
    throw new Error("Set AI_PR_REVIEWER_SECRET or ANTHROPIC_API_KEY before running a replay.");
  }
  return {
    githubToken: "",
    aiBaseUrl:
      input.aiBaseUrl ?? process.env.AI_PR_REVIEWER_BASE_URL ?? "https://api.anthropic.com",
    aiSecret,
    model: input.model,
    ...(input.effort === undefined ? {} : { effort: input.effort }),
    ...(input.systemPrompt === undefined || input.systemPrompt.length === 0
      ? {}
      : { systemPrompt: input.systemPrompt }),
    ...(input.modelPricing === undefined ? {} : { modelPricing: input.modelPricing }),
    reviewPrompts: input.reviewPrompts,
    parallelCount: input.parallelCount,
    maxTurns: input.maxTurns,
    autoApprove: input.autoApprove,
    interactWithPullRequest: input.interactWithPullRequest,
    mcpServers: replayMcpServers(input.mcpServers),
  };
}

function redactJson(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redact(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [redact(key, secrets), redactJson(item, secrets)]),
  );
}

export async function replayCase(
  input: ReplayCase,
  checkout: string,
  runner: ReplayRunner = runReviewGoals,
): Promise<ReplayOutput> {
  const context = pullRequestContext(input.context);
  const mergeBaseSha = await verifyCheckout(checkout, context);
  const root = await realpath(checkout);
  const config = replayConfig(input.config);
  const files = await readPullRequestFilesFromCheckout(context, root);
  const contextFiles = await prepareContextFiles(config.reviewPrompts, root);
  let rawGoals: readonly GoalResult[];
  try {
    rawGoals = await runner(
      context,
      files,
      (input.conversation ?? { digest: "empty", entries: [] }) as ReviewConversationSnapshot,
      config,
      contextFiles.filesByGoal,
      root,
      undefined,
      undefined,
      { ...emptyReviewBriefing(), ...input.briefing },
    );
  } finally {
    await contextFiles.cleanup();
  }
  const secrets = reviewSecretCandidates(config);
  const goals = redactGoalResults(rawGoals, secrets);
  const review = aggregateReview(context, config, files, goals);
  return {
    version: 1,
    caseId: redact(input.caseId, secrets),
    ...(input.labels === undefined ? {} : { labels: redactJson(input.labels, secrets) }),
    repository: context.repository,
    pullRequest: context.number,
    baseSha: context.baseSha,
    mergeBaseSha,
    headSha: context.headSha,
    partial: review.partial,
    allGoalsFailed: review.allGoalsFailed,
    findings: redactJson(review.findings, secrets),
    goals: redactJson(
      goals.map((goal) =>
        Object.fromEntries(Object.entries(goal).filter(([key]) => key !== "prompt")),
      ),
      secrets,
    ) as readonly Omit<GoalResult, "prompt">[],
  };
}

export function serializeReplayOutput(output: ReplayOutput): string {
  return `${JSON.stringify(output, null, 2)}\n`;
}

export async function validateReplayOutputPath(
  outputPath: string,
  checkout: string,
): Promise<string> {
  const root = await realpath(checkout);
  const absolute = resolve(outputPath);
  const parent = await realpath(dirname(absolute));
  const target = join(parent, basename(absolute));
  if (isWithinRepository(root, target)) {
    throw new Error("Replay output must be outside the checkout.");
  }
  let exists = false;
  try {
    await lstat(target);
    exists = true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (exists) throw new Error("Replay output path already exists.");
  return target;
}

export async function writeReplayOutput(
  output: ReplayOutput,
  outputPath: string,
  checkout: string,
): Promise<void> {
  const target = await validateReplayOutputPath(outputPath, checkout);
  await writeFile(target, serializeReplayOutput(output), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

export function parseReplayCase(value: unknown): ReplayCase {
  return caseSchema.parse(value);
}

function argumentValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index < 0 ? undefined : args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(
      `Usage: npm run replay:review -- --case <json> --checkout <repo> --output <json>`,
    );
  }
  return value;
}

export async function runReplayCli(args = process.argv.slice(2)): Promise<void> {
  const casePath = resolve(argumentValue(args, "--case"));
  const checkout = resolve(argumentValue(args, "--checkout"));
  const outputPath = resolve(argumentValue(args, "--output"));
  const input = parseReplayCase(JSON.parse(await readFile(casePath, "utf8")) as unknown);
  await validateReplayOutputPath(outputPath, checkout);
  const output = await replayCase(input, checkout);
  await writeReplayOutput(output, outputPath, checkout);
  process.stdout.write(`Redacted replay result written outside the checkout: ${outputPath}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  await runReplayCli();
}
