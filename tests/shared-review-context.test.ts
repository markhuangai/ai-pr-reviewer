import { query } from "@anthropic-ai/claude-agent-sdk";
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { prepareContextFiles } from "../src/lib/context-files.js";
import { readPullRequestFilesFromSnapshots } from "../src/lib/git-changed-files.js";
import type { ReviewConversationSnapshot } from "../src/lib/review-context.js";
import type { ChangedFile, ReviewSourceRange } from "../src/lib/types.js";
import { isRecord } from "../src/runtime/agent-logging.js";
import { mergeDeliveredRanges } from "../src/runtime/agent-review-tools.js";
import { createReviewGoalsRunner } from "../src/runtime/agent-session.js";
import { runReviewGoal, runReviewGoals } from "../src/runtime/agent.js";
import { startCodexMcpServer } from "../src/runtime/codex-mcp-server.js";
import { ReviewEvidenceLedger } from "../src/runtime/review-assessment.js";
import { ReviewBriefingReader } from "../src/runtime/review-briefing.js";
import { ReviewContextDelivery } from "../src/runtime/review-context-delivery.js";
import {
  REVIEW_CONTEXT_PACKET_PREFIX,
  REVIEW_CONTEXT_WIRE_BYTES,
  stageReviewContext,
} from "../src/runtime/review-context-packets.js";
import { tool } from "../src/runtime/review-tool.js";
import { runSharedDiscovery } from "../src/runtime/shared-discovery.js";
import { emptyConversation, reviewConfig } from "./agent-test-helpers.js";
import {
  historyDocuments,
  historyText,
  isolatedTemporaryRoot,
  modelFixture,
  toolNames,
  type ModelReply,
} from "./codex-test-helpers.js";
import {
  commitFixtureSnapshot,
  makeDiffFromSnapshots,
  makeReplayRepository,
} from "./git-test-helpers.js";

const file: ChangedFile = {
  path: "review.txt",
  status: "modified",
  additions: 1,
  deletions: 0,
  changes: 1,
  addedLines: new Set([2]),
};
const briefing = { linkedIssues: [], linkedIssueReferencesTruncated: false };

function providerPackets(body: Record<string, unknown>): Record<string, unknown>[] {
  const messages = body.messages ?? body.input;
  if (!Array.isArray(messages)) return [];
  const packets = messages.flatMap((message: unknown) => {
    if (!isRecord(message) || message.role !== "user") return [];
    const blocks: unknown[] = Array.isArray(message.content) ? message.content : [message.content];
    return blocks.flatMap((block) => {
      const text = isRecord(block) ? block.text : block;
      if (typeof text !== "string" || !text.startsWith(REVIEW_CONTEXT_PACKET_PREFIX)) return [];
      assert.ok(Buffer.byteLength(JSON.stringify(message)) <= REVIEW_CONTEXT_WIRE_BYTES);
      const packet: unknown = JSON.parse(text.slice(REVIEW_CONTEXT_PACKET_PREFIX.length));
      assert.ok(isRecord(packet) && Array.isArray(packet.pages));
      assert.ok(packet.pages.length <= 4);
      return [packet];
    });
  });
  assert.equal(
    new Set(packets.map(({ id }) => id)).size,
    packets.length,
    "Native input must not contain duplicate shared packets.",
  );
  return packets;
}

function digestRanges(ranges: readonly ReviewSourceRange[]): string {
  const paths = new Map<string, [readonly string[], number, [number, number][]]>();
  for (const range of ranges) {
    const key = JSON.stringify(range.paths);
    const previous = paths.get(key);
    paths.set(key, [
      range.paths,
      range.totalBytes,
      mergeDeliveredRanges(previous?.[2] ?? [], range.start, range.end).intervals,
    ]);
  }
  const ordered = [...paths].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  return createHash("sha256")
    .update(JSON.stringify(ordered.map(([, value]) => value)))
    .digest("hex");
}

for (const executor of ["claude", "codex"] as const) {
  test(`native ${executor} transcript only credits exact responded-to user packets`, async (t) => {
    const home = await isolatedTemporaryRoot(t);
    const repository = await makeReplayRepository(t);
    const diff = await makeDiffFromSnapshots(
      repository.root,
      repository.baseSha,
      repository.headSha,
      home,
    );
    t.after(() => diff.cleanup());
    const briefingReader = new ReviewBriefingReader(
      repository.context,
      [file],
      emptyConversation,
      briefing,
    );
    const staged = await stageReviewContext(briefingReader, diff, repository.headSha);
    const ledger = new ReviewEvidenceLedger(
      repository.root,
      [file],
      { mergeBaseSha: diff.mergeBaseSha, headSha: repository.headSha },
      diff.files,
    );
    const events: string[] = [];
    const delivery = new ReviewContextDelivery(staged, home, briefingReader, ledger, (event) =>
      events.push(event),
    );
    const packet = delivery.stage();
    assert.ok(packet);
    assert.equal(delivery.stage(), undefined);
    const sessionId = randomUUID();
    const turnId = randomUUID();
    const path = join(home, `${sessionId}.jsonl`);
    delivery.history.attach({ executor, sessionId, path });
    const append = async (...entries: Record<string, unknown>[]) => {
      await appendFile(path, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    };
    const message = (role: string, content: string, id = sessionId) =>
      executor === "codex"
        ? { type: "response_item", payload: { type: "message", role, content } }
        : { type: role, sessionId: id, message: { role, content } };
    const successfulExchange = {
      type: "token_usage_record",
      payload: {
        thread_id: sessionId,
        session_id: sessionId,
        turn_id: turnId,
        response_id: randomUUID(),
      },
    };
    const turnStarted = { type: "event_msg", payload: { type: "task_started", turn_id: turnId } };
    if (executor === "codex")
      await append({ type: "session_meta", payload: { id: sessionId } }, turnStarted);
    else await append(message("user", packet.text, randomUUID()));
    await append(
      message("assistant", packet.text),
      message("user", `${packet.text} `),
      message("assistant", "Acknowledged."),
    );
    await append(message("user", packet.text));
    if (executor === "claude")
      await append({ ...message("assistant", "API error."), isApiErrorMessage: true });
    else
      await append(
        message("assistant", "Partial response."),
        { type: "event_msg", payload: { type: "error" } },
        { type: "event_msg", payload: { type: "task_complete" } },
      );
    await delivery.boundary();
    assert.equal(ledger.uniqueSourceBytes, 0);
    assert.equal(briefingReader.complete, false);
    assert.ok(events.includes("context-packet-unconfirmed"));
    await append(message("assistant", "Received."));
    if (executor === "codex") await append(successfulExchange);
    await delivery.refresh();
    assert.equal(ledger.uniqueSourceBytes, packet.sourceBytes);
    assert.equal(briefingReader.complete, true);
    await append(message("user", packet.text), message("assistant", "Received again."));
    if (executor === "codex") await append(successfulExchange);
    await delivery.refresh();
    assert.equal(ledger.uniqueSourceBytes, packet.sourceBytes);
    assert.equal(events.filter((event) => event === "context-packet-confirmed").length, 1);
    await append(
      executor === "codex"
        ? {
            type: "compacted",
            payload: {
              replacement_history: [
                { type: "message", role: "assistant", content: "Summary only." },
              ],
            },
          }
        : { type: "system", subtype: "compact_boundary", sessionId },
    );
    await delivery.refresh();
    assert.equal(ledger.uniqueSourceBytes, 0);
    assert.equal(briefingReader.complete, false);
    assert.equal(delivery.stage()?.id, packet.id);
    assert.ok(events.includes("context-packet-compacted"));
  });
}

for (const executor of ["claude", "codex"] as const) {
  test(
    `real ${executor} exchanges for fitting and overflow shared evidence`,
    { timeout: 180_000 },
    async (t) => {
      await isolatedTemporaryRoot(t);
      const repository = await makeReplayRepository(t, async (root) => {
        await writeFile(join(root, "remove.txt"), "removed fixture body\n");
        await writeFile(join(root, "rename.txt"), "renamed stable fixture\n".repeat(15));
      });
      const fixtureMarker = "SHARED_OVERFLOW_MARKER_ç";
      const lateMarker = "SHARED_LATE_FILE_MARKER";
      const output: string[] = [];
      const emit = process.stdout.write.bind(process.stdout);
      t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
        output.push(chunk.toString());
        return true;
      });
      const baselineModule = process.env.SHARED_CONTEXT_BASELINE_MODULE;
      const baselineRunner =
        baselineModule === undefined
          ? createReviewGoalsRunner(runReviewGoal, query, (input) => {
              const { sharedContext: staged, ...legacy } = input;
              assert.ok(staged !== undefined);
              return runSharedDiscovery(legacy);
            })
          : (
              (await import(pathToFileURL(baselineModule).href)) as {
                runReviewGoals: typeof runReviewGoals;
              }
            ).runReviewGoals;
      for (const fixtureSize of ["fitting", "overflow"] as const) {
        const overflow = fixtureSize === "overflow";
        if (overflow) {
          await rename(join(repository.root, "rename.txt"), join(repository.root, "renamed.txt"));
          await rm(join(repository.root, "remove.txt"));
          await writeFile(
            join(repository.root, "middle.txt"),
            `${fixtureMarker}${"0123456789".repeat(18)}\n`.repeat(770),
          );
          await writeFile(join(repository.root, "zz-late.txt"), `${lateMarker}\n`);
        }
        const context = overflow
          ? {
              ...repository.context,
              headSha: await commitFixtureSnapshot(
                repository.root,
                repository.temporaryRoot,
                repository.headSha,
              ),
            }
          : repository.context;
        const files = await readPullRequestFilesFromSnapshots(
          context,
          repository.root,
          repository.baseSha,
        );
        const diff = await makeDiffFromSnapshots(
          repository.root,
          repository.baseSha,
          context.headSha,
          repository.temporaryRoot,
        );
        const expectedDigest = digestRanges(
          diff.files.map(({ paths, size }) => ({ paths, start: 0, end: size, totalBytes: size })),
        );
        await diff.cleanup();
        const reports: {
          mode: string;
          exchanges: number[];
          digests: string[];
          requests: number;
        }[] = [];
        for (const candidate of overflow ? [false, true] : [true]) {
          output.length = 0;
          const labels = Array.from({ length: 6 }, (_, index) => `SWEEP_GOAL_${index + 1}`);
          const counts = labels.map(() => 0);
          const seenPackets = labels.map(() => new Set<unknown>());
          const ranges: ReviewSourceRange[][] = labels.map(() => []);
          const upstream = await modelFixture(t, ({ body }): ModelReply => {
            const history = historyText(body);
            const packets = providerPackets(body);
            const index = labels.findIndex((label) => history.includes(label));
            if (index === -1) {
              if (history.includes("Discovery change map accepted."))
                return { text: "Orientation complete." };
              assert.equal(
                packets.length > 0,
                candidate,
                "Discovery starts with raw user-role evidence only in candidate mode.",
              );
              if (candidate)
                assert.deepEqual(
                  (packets[0]?.pages as Record<string, unknown>[])
                    .slice(0, 2)
                    .map(({ kind }) => kind),
                  ["briefing", "diff"],
                );
              return {
                tool: "finish_discovery",
                args: {
                  changeMap: "Trace the changed fixture paths.",
                  ...(candidate ? { observations: [], unknowns: ["No callers inspected."] } : {}),
                },
              };
            }
            assert.ok(
              labels.every((label, otherIndex) => otherIndex === index || !history.includes(label)),
            );
            if (history.includes("Review submission accepted."))
              return { text: "Review complete." };
            if (!candidate) {
              const docs = historyDocuments(body);
              for (const doc of docs.filter(
                ({ remaining, ranges }) => remaining === true && Array.isArray(ranges),
              ))
                ranges[index]?.push(...(doc.ranges as ReviewSourceRange[]));
              if (!docs.some((doc) => doc.done === true && Array.isArray(doc.records))) {
                counts[index] = (counts[index] ?? 0) + 1;
                return { tool: "read_review_briefing", args: {} };
              }
              if (!docs.some((doc) => doc.done === true && doc.remaining === true)) {
                counts[index] = (counts[index] ?? 0) + 1;
                return { tool: "read_pr_diff", args: { remaining: true } };
              }
            } else {
              assert.ok(
                packets.length > 0,
                "A fitting or overflow goal must see raw evidence at activation.",
              );
              const packet = packets.at(-1);
              if (packet?.more === true) {
                counts[index] = (counts[index] ?? 0) + 1;
                if (seenPackets[index]?.has(packet.id))
                  return { text: "Waiting for the next packet." };
                seenPackets[index]?.add(packet.id);
                if (index === 1 && counts[index] === 1)
                  return { text: "Ready to continue the sweep." };
                if (executor === "claude" && index === 0 && counts[index] === 1)
                  return {
                    claudeTools: [
                      { tool: "read_review_state", args: {} },
                      { tool: "advance_review_context", args: {} },
                      { tool: "advance_review_context", args: {} },
                    ],
                  };
                return { tool: "advance_review_context", args: {} };
              }
              if (overflow)
                assert.ok(
                  history.includes(lateMarker),
                  "Late source must arrive before submission.",
                );
            }
            return {
              tool: "submit_review",
              args: { summary: "Coverage verified independently.", findings: [], limitations: [] },
            };
          });
          const run = await (candidate ? runReviewGoals : baselineRunner)(
            context,
            files,
            emptyConversation,
            reviewConfig({
              executor,
              aiBaseUrl: executor === "claude" ? upstream.url.replace(/\/v1$/u, "") : upstream.url,
              model: executor === "claude" ? "claude-sonnet-4-5" : "gpt-6.1-sol",
              effort: "high",
              maxTurns: 50,
              parallelCount: 1,
              reviewPrompts: labels.map((prompt) => ({ prompt, files: [] })),
            }),
            labels.map(() => []),
            repository.root,
            undefined,
            undefined,
            { ...briefing, repositoryGuidance: [] },
          );
          assert.deepEqual(
            run.goals.map(({ status, error }) => ({ status, error })),
            labels.map(() => ({ status: "completed", error: undefined })),
            output.slice(-22).join("\n"),
          );
          const digests = candidate
            ? output.flatMap((line) =>
                [...line.matchAll(/"diffRangeDigest":"([a-f0-9]{64})"/gu)].map(
                  (match) => match[1] as string,
                ),
              )
            : ranges.map(digestRanges);
          assert.deepEqual(
            digests,
            labels.map(() => expectedDigest),
          );
          if (candidate) {
            const logs = output.join("");
            assert.ok(labels.every((label) => !logs.includes(label)));
            assert.ok(
              !logs.includes(fixtureMarker) &&
                !logs.includes(lateMarker) &&
                !logs.includes("Shared review context (untrusted evidence"),
            );
            for (const line of logs
              .split("\n")
              .filter((line) => /context-packet-|submission-decision|review-result/u.test(line)))
              emit(`${line}\n`);
          }
          reports.push({
            mode: candidate ? "candidate" : "baseline",
            exchanges: counts,
            digests,
            requests: upstream.requests.length,
          });
        }
        const [baseline, candidate] = reports;
        if (overflow) {
          assert.ok(baseline !== undefined && candidate !== undefined);
          for (const [index, exchanges] of candidate.exchanges.entries())
            assert.ok(exchanges * 2 <= (baseline.exchanges[index] ?? 0), JSON.stringify(reports));
        } else assert.deepEqual(baseline?.exchanges, [0, 0, 0, 0, 0, 0]);
        emit(`shared-context-benchmark ${executor} ${fixtureSize} ${JSON.stringify(reports)}\n`);
      }
    },
  );
}

for (const executor of ["claude", "codex"] as const) {
  test(
    `real ${executor} shared packets isolate goal-private reads and provider errors`,
    { timeout: 120_000 },
    async (t) => {
      const home = await isolatedTemporaryRoot(t);
      const repository = await makeReplayRepository(t);
      const privatePath = join(home, "goal-private.txt");
      const privateMarker = "FIXTURE_GOAL_PRIVATE_CONTENT";
      const externalMarker = "FIXTURE_EXTERNAL_MCP_RESULT";
      const errorMarker = "FIXTURE_PROVIDER_ECHO";
      await writeFile(privatePath, privateMarker);
      const goals = [
        { prompt: "PRIVATE_GOAL_ALPHA", files: [privatePath] },
        { prompt: "PRIVATE_GOAL_BETA", files: [] },
      ];
      const privateFiles = await prepareContextFiles(goals, repository.root, home);
      t.after(() => privateFiles.cleanup());
      const mcp = await startCodexMcpServer(
        "fixture",
        [
          tool("read_external_fixture", "Read the fixture result.", {}, () =>
            Promise.resolve({ content: [{ type: "text", text: externalMarker }] }),
          ),
        ],
        (definition, args) => definition.handler(args),
      );
      t.after(() => mcp.close());
      const output: string[] = [];
      t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
        output.push(chunk.toString());
        return true;
      });
      const upstream = await modelFixture(t, ({ body }) => {
        const history = historyText(body);
        if (history.includes("PRIVATE_GOAL_ALPHA")) {
          assert.ok(!history.includes("PRIVATE_GOAL_BETA"));
          if (history.includes("Review submission accepted.")) return { text: "Review completed." };
          if (!history.includes(privateMarker))
            return { tool: "read_context_file", args: { path: privatePath } };
          if (!history.includes(externalMarker)) return { tool: "read_external_fixture", args: {} };
          return {
            tool: "submit_review",
            args: { summary: "Checked the fixture.", findings: [], limitations: [] },
          };
        }
        assert.ok(
          !history.includes(privatePath) &&
            !history.includes(privateMarker) &&
            !history.includes(externalMarker),
        );
        assert.ok(!toolNames(body).some((name) => name.endsWith("read_context_file")));
        if (history.includes("PRIVATE_GOAL_BETA")) return { error: 400, message: errorMarker };
        assert.ok(!toolNames(body).some((name) => name.endsWith("read_external_fixture")));
        return history.includes("Discovery change map accepted.")
          ? { text: "Orientation completed." }
          : {
              tool: "finish_discovery",
              args: {
                changeMap: "Inspect review.txt.",
                observations: [],
                unknowns: ["Caller unknown."],
              },
            };
      });
      const run = await runReviewGoals(
        repository.context,
        [file],
        emptyConversation,
        reviewConfig({
          executor,
          aiBaseUrl: executor === "claude" ? upstream.url.replace(/\/v1$/u, "") : upstream.url,
          model: executor === "claude" ? "claude-sonnet-4-5" : "gpt-6.1-sol",
          reviewPrompts: goals,
          parallelCount: 1,
          maxTurns: 12,
          mcpServers: {
            fixture: {
              type: "http",
              url: mcp.url,
              headers: { Authorization: `Bearer ${mcp.token}` },
            },
          },
        }),
        privateFiles.filesByGoal,
        repository.root,
        undefined,
        undefined,
        { ...briefing, repositoryGuidance: [] },
      );
      assert.deepEqual(
        run.goals.map(({ status }) => status),
        ["completed", "failed"],
        JSON.stringify({
          discovery: run.discovery?.status,
          goals: run.goals.map(({ error, diagnostics }) => ({ error, diagnostics })),
          stages: upstream.requests.map(({ body }) => {
            const history = historyText(body);
            return {
              alpha: history.includes("PRIVATE_GOAL_ALPHA"),
              beta: history.includes("PRIVATE_GOAL_BETA"),
              context: history.includes(privateMarker),
              external: history.includes(externalMarker),
              externalTool: toolNames(body).some((name) => name.endsWith("read_external_fixture")),
              accepted: history.includes("Review submission accepted."),
            };
          }),
        }),
      );
      assert.ok(
        upstream.requests.some(({ body }) => historyText(body).includes("PRIVATE_GOAL_BETA")),
      );
      for (const marker of [
        privatePath,
        privateMarker,
        externalMarker,
        errorMarker,
        ...goals.map(({ prompt }) => prompt),
      ])
        assert.ok(
          !output.some((line) => line.includes(marker)),
          "Private fixture data must stay out of normal logs.",
        );
      assert.ok(!JSON.stringify(run.goals[1]?.error).includes(errorMarker));
    },
  );
}

test(
  "real Codex discovery hands off prior decisions and immutable source citations",
  { timeout: 120_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const repository = await makeReplayRepository(t);
    const timestamp = "2026-01-01T00:00:00Z";
    const decision = "Fixture middle decision: preserve the existing caller contract.";
    const conversation: ReviewConversationSnapshot = {
      ...emptyConversation,
      digest: "fixture-decision",
      entries: [
        {
          kind: "inline_thread",
          id: 1,
          path: "review.txt",
          rootAvailable: true,
          createdAt: timestamp,
          isResolved: false,
          isOutdated: false,
          messages: ["Start of the discussion.", decision, "End of the discussion."].map(
            (body, index) => ({
              id: index + 1,
              authorRole: "human" as const,
              body,
              createdAt: timestamp,
              updatedAt: timestamp,
            }),
          ),
        },
      ],
    };
    const completedForks = new Set<string>();
    let discoveryStep = 0;
    const upstream = await modelFixture(t, ({ body }) => {
      const history = historyText(body);
      const goal = history.match(/CITATION_GOAL_(ALPHA|BETA)/u)?.[0];
      if (goal !== undefined) {
        assert.ok(
          history.includes(decision) &&
            history.includes("repository_file") &&
            history.includes(repository.headSha),
        );
        assert.ok(history.includes("Caller behavior remains unverified."));
        completedForks.add(goal);
        return history.includes("Review submission accepted.")
          ? { text: "Review complete." }
          : {
              tool: "submit_review",
              args: { summary: "Checked the source independently.", findings: [], limitations: [] },
            };
      }
      if (history.includes("Discovery change map accepted."))
        return { text: "Orientation complete." };
      discoveryStep++;
      if (discoveryStep === 1) {
        assert.ok(!history.includes(decision), "The packet contains only a discussion index.");
        return { tool: "read_pr_threads", args: { id: 1 } };
      }
      assert.ok(history.includes(decision));
      if (discoveryStep === 2)
        return { tool: "read_repository_file", args: { revision: "head", path: "review.txt" } };
      if (discoveryStep === 3) return { tool: "read_discovery_evidence", args: {} };
      const evidence = history.match(/(ev-\d+) complete repository_file/u)?.[1];
      assert.ok(
        evidence,
        "Discovery must be able to retrieve a host-issued reference for the source read.",
      );
      return {
        tool: "finish_discovery",
        args: {
          changeMap: decision,
          observations: [
            { fact: "The head appends a line to review.txt.", evidenceRefs: [evidence] },
          ],
          unknowns: ["Caller behavior remains unverified."],
        },
      };
    });
    const run = await runReviewGoals(
      repository.context,
      [file],
      conversation,
      reviewConfig({
        executor: "codex",
        aiBaseUrl: upstream.url,
        model: "gpt-6.1-sol",
        maxTurns: 12,
        reviewPrompts: ["CITATION_GOAL_ALPHA", "CITATION_GOAL_BETA"].map((prompt) => ({
          prompt,
          files: [],
        })),
        parallelCount: 1,
      }),
      [[], []],
      repository.root,
      undefined,
      undefined,
      { ...briefing, repositoryGuidance: [] },
    );
    assert.equal(completedForks.size, 2);
    assert.deepEqual(
      run.goals.map(({ status }) => status),
      ["completed", "completed"],
    );
  },
);

test(
  "real Claude caps native turns across continued source tool use",
  { timeout: 120_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const repository = await makeReplayRepository(t);
    let boundedExchanges = 0;
    const upstream = await modelFixture(t, ({ body }) => {
      const history = historyText(body);
      if (history.includes("TURN_BUDGET_GOAL")) {
        if (toolNames(body).length === 0) return { text: "The goal remains incomplete." };
        boundedExchanges++;
        if (boundedExchanges === 1) return { text: "Continue the independent review." };
        return { tool: "read_review_state", args: {} };
      }
      if (history.includes("Review submission accepted.")) return { text: "Review completed." };
      if (history.includes("CONTROL_REVIEW_GOAL"))
        return {
          tool: "submit_review",
          args: { summary: "Reviewed independently.", findings: [], limitations: [] },
        };
      return {
        tool: "finish_discovery",
        args: { changeMap: "Inspect review.txt.", observations: [], unknowns: [] },
      };
    });
    const run = await runReviewGoals(
      repository.context,
      [file],
      emptyConversation,
      reviewConfig({
        executor: "claude",
        aiBaseUrl: upstream.url.replace(/\/v1$/u, ""),
        model: "claude-sonnet-4-5",
        maxTurns: 2,
        reviewPrompts: ["TURN_BUDGET_GOAL", "CONTROL_REVIEW_GOAL"].map((prompt) => ({
          prompt,
          files: [],
        })),
        parallelCount: 1,
      }),
      [[], []],
      repository.root,
      undefined,
      undefined,
      { ...briefing, repositoryGuidance: [] },
    );
    assert.equal(boundedExchanges, 2);
    assert.equal(run.goals[0]?.diagnostics?.termination, "max-turns-exhausted");
    assert.equal(run.goals[1]?.status, "completed");
  },
);

test(
  "real Codex compacts a packet sweep without accepting summary-only coverage",
  { timeout: 120_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const repository = await makeReplayRepository(t);
    await writeFile(
      join(repository.root, "overflow.txt"),
      `${"compaction fixture text ".repeat(8)}\n`.repeat(2_100),
    );
    const context = {
      ...repository.context,
      headSha: await commitFixtureSnapshot(
        repository.root,
        repository.temporaryRoot,
        repository.headSha,
      ),
    };
    const files = await readPullRequestFilesFromSnapshots(
      context,
      repository.root,
      repository.baseSha,
    );
    let compacted = false;
    let probed = false;
    let lostRaw = false;
    let prematureSubmission = false;
    const visible = new Set<unknown>();
    const submission = {
      tool: "submit_review",
      args: { summary: "Reviewed the source.", findings: [], limitations: [] },
    } as const;
    const upstream = await modelFixture(t, ({ body }) => {
      const history = historyText(body);
      if (toolNames(body).length === 0) {
        compacted = true;
        return { text: "Keep reviewing COMPACT_SWEEP_GOAL; this summary is not raw source." };
      }
      if (!history.includes("COMPACT_SWEEP_GOAL") && !history.includes("CONTROL_SWEEP_GOAL")) {
        return history.includes("Discovery change map accepted.")
          ? { text: "Orientation complete." }
          : {
              tool: "finish_discovery",
              args: { changeMap: "Inspect review.txt.", observations: [], unknowns: [] },
            };
      }
      if (history.includes("Review submission accepted.")) return { text: "Review complete." };
      const packets = providerPackets(body);
      if (history.includes("COMPACT_SWEEP_GOAL") && !compacted)
        for (const packet of packets) visible.add(packet.id);
      const missing =
        history.includes("COMPACT_SWEEP_GOAL") &&
        compacted &&
        [...visible].some((id) => !packets.some((packet) => packet.id === id));
      if (missing && !prematureSubmission) {
        lostRaw = true;
        prematureSubmission = true;
        return submission;
      }
      if (packets.at(-1)?.more === true && (!probed || history.includes("CONTROL_SWEEP_GOAL")))
        return { tool: "advance_review_context", args: {} };
      if (history.includes("COMPACT_SWEEP_GOAL") && !probed) {
        probed = true;
        return { tool: "read_review_state", args: {}, inputTokens: 300_000 };
      }
      if (missing || packets.length === 0) {
        if (!historyDocuments(body).some((doc) => doc.remaining === true && doc.done === true))
          return { tool: "read_pr_diff", args: { remaining: true } };
        if (!historyDocuments(body).some((doc) => Array.isArray(doc.records) && doc.done === true))
          return { tool: "read_review_briefing", args: {} };
      }
      return submission;
    });
    const run = await runReviewGoals(
      context,
      files,
      emptyConversation,
      reviewConfig({
        executor: "codex",
        aiBaseUrl: upstream.url,
        model: "gpt-6.1-sol",
        maxTurns: 50,
        reviewPrompts: ["COMPACT_SWEEP_GOAL", "CONTROL_SWEEP_GOAL"].map((prompt) => ({
          prompt,
          files: [],
        })),
        parallelCount: 1,
      }),
      [[], []],
      repository.root,
      undefined,
      undefined,
      { ...briefing, repositoryGuidance: [] },
    );
    assert.equal(compacted, true);
    assert.equal(lostRaw, true, "Native compaction must omit at least one raw packet.");
    assert.equal(
      run.goals[0]?.diagnostics?.inspectionContinuations,
      1,
      "A summary-only submission must be rejected before recovering source.",
    );
    assert.deepEqual(
      run.goals.map(({ status }) => status),
      ["completed", "completed"],
    );
  },
);
