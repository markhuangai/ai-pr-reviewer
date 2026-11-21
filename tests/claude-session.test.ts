import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../src/runtime/agent-logging.js";
import test from "node:test";
import { aggregateReview } from "../src/lib/aggregate.js";
import { readPullRequestFilesFromSnapshots } from "../src/lib/git-changed-files.js";
import { runReviewGoals } from "../src/runtime/agent.js";
import {
  modelFixture,
  sharedReviewRun,
  sharedReviewScript,
  historyText,
  historyDocuments,
  isolatedTemporaryRoot,
  type ModelReply,
} from "./codex-test-helpers.js";
import { runSharedDiscovery } from "../src/runtime/shared-discovery.js";
import { makeReplayRepository, makeDiffFromSnapshots } from "./git-test-helpers.js";
import { emptyConversation, reviewConfig } from "./agent-test-helpers.js";
import { query } from "@anthropic-ai/claude-agent-sdk";

test(
  "real Claude forks inherit discovery while private evidence and queued reviewers stay isolated",
  { timeout: 180_000 },
  async (t) => {
    const script = sharedReviewScript();
    const fixture = await modelFixture(t, script.next);
    const { run, config, context } = await sharedReviewRun(t, fixture.url, "claude", script);
    assert.equal(run.discovery?.status, "completed");
    assert.equal(script.reads.filter((read) => read.tool === "read_pr_diff").length, 1);
    const totals = aggregateReview(context, config, [], run.goals, {
      discovery: run.discovery,
    }).tokenUsage;
    assert.equal(totals.complete, true);
    assert.equal(totals.totals.inputTokens, fixture.requests.length * 100);
    assert.equal(totals.totals.outputTokens, fixture.requests.length * 10);
  },
);

test(
  "real Claude single-goal reviews retain full coverage without discovery",
  { timeout: 180_000 },
  async (t) => {
    const script = sharedReviewScript({ goalCount: 1 });
    const fixture = await modelFixture(t, script.next);
    const { run } = await sharedReviewRun(t, fixture.url, "claude", script);
    assert.equal(run.discovery, undefined);
    assert.equal(script.reads.filter((read) => read.tool === "read_pr_diff").length, 1);
  },
);

test(
  "real Claude native Reads record delivered lines, repeated lines and unverified ranges",
  { timeout: 60_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const fileReadLimit = process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;
    process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS = "30";
    t.after(() => {
      if (fileReadLimit === undefined) delete process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS;
      else process.env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS = fileReadLimit;
    });
    const secret = "NATIVE_READ_TEST_SECRET";
    const caller = `caller-${secret}.ts`;
    const repository = await makeReplayRepository(t, async (root) => {
      await writeFile(join(root, caller), "first\r\n\tsecond\r\nthird\r\n");
      await writeFile(
        join(root, "wide.ts"),
        "const value = firstSymbol + secondSymbol;\n".repeat(32),
      );
    });
    const files = await readPullRequestFilesFromSnapshots(
      repository.context,
      repository.root,
      repository.baseSha,
    );
    const calls: ModelReply[] = [
      { tool: "read_review_briefing", args: {} },
      {
        claudeTools: [
          { tool: "Read", args: { file_path: join(repository.root, "review.txt") } },
          { tool: "Read", args: { file_path: join(repository.root, caller), offset: 2, limit: 2 } },
        ],
      },
      ...[
        [3, 2],
        [3, 3],
        [10, 2],
      ].map(([offset, limit]) => ({
        tool: "Read",
        args: { file_path: join(repository.root, caller), offset, limit },
      })),
      { tool: "Read", args: { file_path: join(repository.root, "wide.ts") } },
      { tool: "Read", args: { file_path: join(repository.root, "wide.ts"), offset: 1, limit: 32 } },
      { tool: "submit_review", args: { summary: "Inspected", findings: [], limitations: [] } },
    ];
    const fixture = await modelFixture(
      t,
      (_request, index) => calls[index] ?? { text: "Review complete." },
    );
    const output: string[] = [];
    t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
      output.push(chunk.toString());
      return true;
    });
    const controller = new AbortController();
    t.signal.addEventListener(
      "abort",
      () => {
        controller.abort(t.signal.reason);
      },
      { once: true },
    );
    const { goals } = await runReviewGoals(
      repository.context,
      files,
      emptyConversation,
      reviewConfig({
        aiBaseUrl: fixture.url.replace(/\/v1$/u, ""),
        aiSecret: secret,
        model: "claude-sonnet-4-5",
        maxTurns: 16,
      }),
      [[]],
      repository.root,
      undefined,
      controller,
    );
    assert.equal(goals[0]?.status, "completed", goals[0]?.error ?? "Review did not complete.");
    assert.deepEqual(goals[0]?.inspection?.observedPaths, ["review.txt"]);
    assert.ok(
      fixture.requests.some(
        ({ body }) =>
          Array.isArray(body.messages) &&
          body.messages.some(
            (message: unknown) =>
              isRecord(message) &&
              message.role === "assistant" &&
              Array.isArray(message.content) &&
              message.content.filter((block: unknown) => isRecord(block) && block.name === "Read")
                .length === 2,
          ),
      ),
      "Both interleaved Reads must travel in one assistant tool batch.",
    );
    const deliveries = output.flatMap((line) => {
      const prefix = "[ai-pr-reviewer][goal 1] diagnostic source-delivery details: ";
      if (!line.startsWith(prefix)) return [];
      assert.ok(!line.includes(secret));
      const record: unknown = JSON.parse(line.slice(prefix.length));
      return isRecord(record) && record.kind === "repository_read" ? [record] : [];
    });
    const callerDeliveries = deliveries.filter((record) => record.path === "caller-[REDACTED].ts");
    assert.deepEqual(
      callerDeliveries.map(({ status, newLines, repeatedLines }) => [
        status,
        newLines,
        repeatedLines,
      ]),
      [
        ["complete", 2, 0],
        ["complete", 1, 1],
        ["complete", 0, 2],
        ["partial", 0, 0],
      ],
    );
    assert.match(String(callerDeliveries.at(-1)?.reason), /did not match the path and range/u);
    const wideDeliveries = deliveries.filter((record) => record.path === "wide.ts");
    assert.deepEqual(
      wideDeliveries.map(({ status, newLines, repeatedLines }) => [
        status,
        newLines,
        repeatedLines,
      ]),
      [
        ["partial", 0, 0],
        ["partial", 0, 0],
      ],
    );
    assert.match(String(wideDeliveries[0]?.reason), /was truncated/u);
    assert.match(String(wideDeliveries[1]?.reason), /metadata was missing/u);
    assert.ok(
      output.some((line) =>
        /agent tool result Read output:.*"is_error":true.*exceeds maximum allowed tokens/u.test(
          line,
        ),
      ),
    );
    assert.ok(deliveries.every(({ toolCallId }) => typeof toolCallId === "string"));
    assert.equal(new Set(deliveries.map(({ toolCallId }) => toolCallId)).size, 7);
  },
);

test(
  "real Claude resumes discovery after exhausted SDK provider retries",
  { timeout: 180_000 },
  async (t) => {
    const script = sharedReviewScript();
    let failures = 0;
    const fixture = await modelFixture(t, (request) =>
      failures++ < 2 ? { error: 500 } : script.next(request),
    );
    const schedule = globalThis.setTimeout;
    const delays: number[] = [];
    t.mock.method(
      globalThis,
      "setTimeout",
      (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
        if (milliseconds !== undefined && milliseconds >= 120_000 && milliseconds <= 255_000) {
          delays.push(milliseconds);
          return schedule(callback, 1, ...args);
        }
        return schedule(callback, milliseconds, ...args);
      },
    );
    const { run } = await sharedReviewRun(t, fixture.url, "claude", script);
    assert.equal(run.discovery?.status, "completed");
    assert.ok(run.goals.every((goal) => goal.status === "completed"));
    assert.equal(delays.length, 1);
  },
);

test(
  "real Claude finishes discovery after its normal turn limit without further reads",
  { timeout: 120_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const repository = await makeReplayRepository(t);
    let finishing = false;
    const fixture = await modelFixture(t, ({ body }) => {
      if (historyText(body).includes("Finish the change map from evidence already delivered.")) {
        finishing = true;
        return {
          tool: "finish_discovery",
          args: {
            changeMap:
              "The overview identifies the changed paths; source investigation remains for each goal.",
          },
        };
      }
      return { tool: "read_change_overview", args: {} };
    });
    const diff = await makeDiffFromSnapshots(
      repository.root,
      repository.baseSha,
      repository.headSha,
      repository.temporaryRoot,
    );
    t.after(() => diff.cleanup());
    const result = await runSharedDiscovery({
      context: repository.context,
      files: [],
      conversation: emptyConversation,
      config: reviewConfig({
        executor: "claude",
        model: "claude-sonnet-4-5",
        aiBaseUrl: fixture.url.replace(/\/v1$/u, ""),
        maxTurns: 2,
      }),
      diff,
      cwd: repository.root,
      queryAgent: query,
      abortController: undefined,
      briefing: { linkedIssues: [], linkedIssueReferencesTruncated: false },
    });
    t.after(() => result.cleanup());
    assert.ok(finishing);
    assert.equal(result.result.status, "completed", result.result.error ?? "Discovery failed");
    assert.equal(result.result.diagnostics.readCalls, 1);
    assert.ok(result.seed);
  },
);

test(
  "real claude accepts informational limitations without a correction turn",
  { timeout: 180_000 },
  async (t) => {
    const limitations = [
      { paths: ["review.txt"], reason: "This feature is intentionally unsupported." },
      { paths: [], reason: "Optional external verification is unavailable." },
    ];
    const script = sharedReviewScript({ goalCount: 1 });
    const fixture = await modelFixture(t, (request) => {
      const reply = script.next(request);
      if (!("tool" in reply) || reply.tool !== "submit_review") return reply;
      const records: unknown[] = historyDocuments(request.body).flatMap((doc) =>
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
      assert.ok(isRecord(evidence) && isRecord(evidence.reference));
      return {
        ...reply,
        args: {
          ...reply.args,
          limitations,
          findings: [
            {
              title: "Check the changed line",
              severity: "LOW",
              why: "The changed value is unchecked.",
              fix: "Validate the value.",
              path: "review.txt",
              line: 2,
              evidenceRefs: [evidence.reference.id],
              countercheck: "Checked the complete diff for a guard.",
              counterevidenceRefs: [],
            },
          ],
        },
      };
    });
    const { run, config, context } = await sharedReviewRun(t, fixture.url, "claude", script);
    assert.equal(run.goals[0]?.status, "completed");
    assert.equal(run.goals[0]?.error, undefined);
    assert.deepEqual(run.goals[0]?.submission?.limitations, limitations);
    assert.equal(run.goals[0]?.submission?.findings[0]?.title, "Check the changed line");
    assert.equal(run.goals[0]?.diagnostics?.submissionAttempts, 1);
    assert.equal(run.goals[0]?.diagnostics?.validationFailures, 0);
    const review = aggregateReview(
      context,
      config,
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
      run.goals,
    );
    assert.equal(review.partial, false);
    assert.equal(review.event, "APPROVE");
  },
);
