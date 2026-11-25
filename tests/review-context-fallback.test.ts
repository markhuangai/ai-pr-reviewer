import { strict as assert } from "node:assert";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { globSync } from "node:fs";
import { appendFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readPullRequestFilesFromSnapshots } from "../src/lib/git-changed-files.js";
import { isRecord } from "../src/runtime/agent-logging.js";
import { RepositoryFilePageReader } from "../src/runtime/agent-review-tools.js";
import {
  POST_COVERAGE_WRAP_UP_ROUNDS,
  runReviewGoal,
  runReviewGoals,
} from "../src/runtime/agent.js";
import { createReviewGoalsRunner, type AgentQuery } from "../src/runtime/agent-session.js";
import { CodexAppServer, CodexRpcError } from "../src/runtime/codex-app-server.js";
import { ReviewEvidenceLedger } from "../src/runtime/review-assessment.js";
import { ReviewBriefingReader } from "../src/runtime/review-briefing.js";
import {
  ReviewContextDelivery,
  STARTUP_PRELOAD_WIRE_BYTES,
} from "../src/runtime/review-context-delivery.js";
import {
  ADVANCE_REVIEW_CONTEXT_CALL,
  REVIEW_CONTEXT_PACKET_PREFIX,
  stageReviewContext,
} from "../src/runtime/review-context-packets.js";
import { runSharedDiscovery } from "../src/runtime/shared-discovery.js";
import { emptyConversation, reviewConfig } from "./agent-test-helpers.js";
import {
  historyDocuments,
  historyText,
  isolatedTemporaryRoot,
  modelFixture,
  toolNames,
} from "./codex-test-helpers.js";
import {
  commitFixtureSnapshot,
  makeDiffFromSnapshots,
  makeReplayRepository,
} from "./git-test-helpers.js";

const briefing = { linkedIssues: [], linkedIssueReferencesTruncated: false };

test(
  "Claude's post-tool hook steers to packet four and switches to paged reads after deferral",
  { timeout: 120_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const { root, baseSha, temporaryRoot, ...repository } = await makeReplayRepository(t);
    await writeFile(
      join(root, "overflow.txt"),
      "Source spread across several packets.\n".repeat(4_500),
    );
    const headSha = await commitFixtureSnapshot(root, temporaryRoot, repository.headSha);
    const context = { ...repository.context, headSha };
    const files = await readPullRequestFilesFromSnapshots(context, root, baseSha);
    const observed = new Set<ReviewContextDelivery>();
    const stage = Reflect.get<ReviewContextDelivery, "stageStartupPacket">(
      ReviewContextDelivery.prototype,
      "stageStartupPacket",
    );
    t.mock.method(
      ReviewContextDelivery.prototype,
      "stageStartupPacket",
      function (this: ReviewContextDelivery, maxPackets?: number, maxWireBytes?: number) {
        observed.add(this);
        return stage.call(this, maxPackets, maxWireBytes);
      },
    );
    let stateRequested = false;
    let deferred = false;
    let pagedCue = false;
    const observeClaude: AgentQuery = (input) => {
      const options = input.options;
      const batches = options?.hooks?.PostToolBatch;
      const evidence = batches?.[0]?.hooks[0];
      if (options?.forkSession !== true || evidence === undefined || batches === undefined)
        return query(input);
      return query({
        ...input,
        options: {
          ...options,
          hooks: {
            ...options.hooks,
            PostToolBatch: [
              {
                hooks: [
                  async (...args) => {
                    const result = await evidence(...args);
                    const [event] = args;
                    if (event.hook_event_name !== "PostToolBatch") return result;
                    const detail =
                      "hookSpecificOutput" in result ? result.hookSpecificOutput : undefined;
                    const context =
                      detail?.hookEventName === "PostToolBatch"
                        ? (detail.additionalContext ?? "")
                        : "";
                    const name = event.tool_calls[0]?.tool_name;
                    if (!deferred && name?.endsWith("__read_review_state")) {
                      assert.match(
                        context,
                        /"nextCall":\{"tool":"advance_review_context","arguments":\{\}\}/u,
                      );
                      const delivery = [...observed].at(-1);
                      const packet = delivery?.stage();
                      assert.ok(delivery && packet);
                      assert.ok(packet.id.endsWith(":4"));
                      delivery.deferInFlight(packet.id);
                      deferred = true;
                    } else if (deferred && !pagedCue && name?.endsWith("__read_pr_diff")) {
                      assert.match(
                        context,
                        /"nextCall":\{"tool":"read_pr_diff","arguments":\{"remaining":true\}\}/u,
                      );
                      pagedCue = true;
                    }
                    return result;
                  },
                ],
              },
              ...batches.slice(1),
            ],
          },
        },
      });
    };
    const upstream = await modelFixture(t, ({ body }) => {
      const history = historyText(body);
      if (!history.includes("STEERING_PROBE_GOAL") && !history.includes("STEERING_CONTROL_GOAL"))
        return history.includes("Discovery change map accepted.")
          ? { text: "Orientation complete." }
          : {
              tool: "finish_discovery",
              args: { changeMap: "Inspect the changed source.", observations: [], unknowns: [] },
            };
      if (history.includes("Review submission accepted.")) return { text: "Review complete." };
      if (!stateRequested) {
        stateRequested = true;
        return { tool: "read_review_state", args: {} };
      }
      if (
        !historyDocuments(body).some(({ remaining, done }) => remaining === true && done === true)
      )
        return { tool: "read_pr_diff", args: { remaining: true } };
      return {
        tool: "submit_review",
        args: { summary: "Reviewed.", findings: [], limitations: [] },
      };
    });
    const run = await createReviewGoalsRunner(runReviewGoal, observeClaude, runSharedDiscovery)(
      context,
      files,
      emptyConversation,
      reviewConfig({
        executor: "claude",
        aiBaseUrl: upstream.url.replace(/\/v1$/u, ""),
        model: "claude-sonnet-4-5",
        parallelCount: 1,
        maxTurns: 24,
        reviewPrompts: ["STEERING_PROBE_GOAL", "STEERING_CONTROL_GOAL"].map((prompt) => ({
          prompt,
          files: [],
        })),
      }),
      [[], []],
      root,
      undefined,
      undefined,
      { ...briefing, repositoryGuidance: [] },
    );
    assert.ok(deferred && pagedCue);
    assert.deepEqual(
      run.goals.map(({ status }) => status),
      ["completed", "completed"],
    );
  },
);

test(
  "native Codex resets and re-arms the wrap-up advisory after packet compaction",
  { timeout: 120_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const { root, baseSha, temporaryRoot, ...repository } = await makeReplayRepository(t);
    await writeFile(
      join(root, "overflow.txt"),
      ("Compaction drops older raw packets. ".repeat(6) + "\n").repeat(1_650),
    );
    const headSha = await commitFixtureSnapshot(root, temporaryRoot, repository.headSha);
    const context = { ...repository.context, headSha };
    const files = await readPullRequestFilesFromSnapshots(context, root, baseSha);
    const logs: string[] = [];
    const emit = process.stdout.write.bind(process.stdout);
    t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
      logs.push(chunk.toString());
      return true;
    });
    let rounds = 0;
    let recovery = 0;
    let postRecoveryRounds = 0;
    let compacted = false;
    const state = { tool: "read_review_state", args: {} } as const;
    const submit = {
      tool: "submit_review",
      args: { summary: "Reviewed.", findings: [], limitations: [] },
    } as const;
    const upstream = await modelFixture(t, ({ body }) => {
      const history = historyText(body);
      if (toolNames(body).length === 0) {
        compacted = true;
        return { text: "Continue WRAP_UP_COMPACT_PROBE. Recover the host's source coverage." };
      }
      const probe = history.includes("WRAP_UP_COMPACT_PROBE");
      if (!probe && !history.includes("WRAP_UP_COMPACT_CONTROL"))
        return history.includes("Discovery change map accepted.")
          ? { text: "Orientation complete." }
          : {
              tool: "finish_discovery",
              args: { changeMap: "Inspect review.txt.", observations: [], unknowns: [] },
            };
      if (history.includes("Review submission accepted.")) return { text: "Review complete." };
      const advance = { tool: "advance_review_context", args: {} } as const;
      const finalPacket = history.includes(String.raw`\"more\":false`);
      if (!probe) return finalPacket ? submit : advance;
      if (!compacted && !finalPacket) return advance;
      const count = [...history.matchAll(/Wrap-up advisory:/gu)].length;
      if (!compacted) {
        if (++rounds <= POST_COVERAGE_WRAP_UP_ROUNDS + 1) return state;
        assert.equal(count, 1);
        if (rounds === POST_COVERAGE_WRAP_UP_ROUNDS + 2) return advance;
        assert.match(history, /Shared context sweep ended/u);
        return { ...state, inputTokens: 300_000 };
      }
      ++recovery;
      if (recovery === 1) return state;
      if (recovery === 2) {
        assert.equal(count, 0, "The first internal result after compaction has no stale advisory.");
        const after = historyDocuments(body).findLast(({ inspection }) => isRecord(inspection));
        assert.ok(isRecord(after?.inspection) && Number(after.inspection.missing) > 0);
        return { tool: "read_review_briefing", args: {} };
      }
      if (
        !historyDocuments(body).some(({ done, remaining }) => done === true && remaining === true)
      )
        return { tool: "read_pr_diff", args: { remaining: true } };
      assert.ok(++postRecoveryRounds <= POST_COVERAGE_WRAP_UP_ROUNDS + 2);
      return count > 0 ? submit : state;
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
        parallelCount: 1,
        reviewPrompts: ["WRAP_UP_COMPACT_PROBE", "WRAP_UP_COMPACT_CONTROL"].map((prompt) => ({
          prompt,
          files: [],
        })),
      }),
      [[], []],
      root,
      undefined,
      undefined,
      { ...briefing, repositoryGuidance: [] },
    );
    assert.ok(compacted && postRecoveryRounds > 0);
    const advisories = logs.filter((line) => line.includes("session post-coverage-wrap-up"));
    assert.deepEqual(
      advisories.map((line) => line.match(/"delivery_epoch":(\d+)/u)?.[1]),
      ["0", "1"],
    );
    assert.deepEqual(
      run.goals.map(({ status }) => status),
      ["completed", "completed"],
    );
    emit(advisories.join(""));
  },
);

test("a staging read failure leaves the immutable diff readable through paged fallback", async (t) => {
  const home = await isolatedTemporaryRoot(t);
  const repository = await makeReplayRepository(t);
  const files = await readPullRequestFilesFromSnapshots(
    repository.context,
    repository.root,
    repository.baseSha,
  );
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    home,
  );
  t.after(() => diff.cleanup());
  const briefingReader = new ReviewBriefingReader(
    repository.context,
    files,
    emptyConversation,
    briefing,
  );
  const hidden = `${diff.path}.temporarily-unavailable`;
  await rename(diff.path, hidden);
  try {
    const prepared = await stageReviewContext(briefingReader, diff, repository.headSha);
    assert.deepEqual(prepared.packets, []);
    assert.equal(prepared.briefing.complete, false);
    const controller = new AbortController();
    controller.abort(new Error("Cancelled fixture"));
    await assert.rejects(
      stageReviewContext(briefingReader, diff, repository.headSha, controller.signal),
      /Cancelled fixture/u,
    );
  } finally {
    await rename(hidden, diff.path);
  }
  const paged = new RepositoryFilePageReader(diff.path, diff.size, undefined, diff.files);
  try {
    const page = await paged.readNext();
    assert.match(page.content, /\+after/u);
    assert.equal(page.done, true);
  } finally {
    await paged.close();
  }
});

for (const executor of ["claude", "codex"] as const) {
  test(`native ${executor} transcript only credits exact responded-to user packets`, async (t) => {
    const home = await isolatedTemporaryRoot(t);
    const repository = await makeReplayRepository(t);
    const files = await readPullRequestFilesFromSnapshots(
      repository.context,
      repository.root,
      repository.baseSha,
    );
    const diff = await makeDiffFromSnapshots(
      repository.root,
      repository.baseSha,
      repository.headSha,
      home,
    );
    t.after(() => diff.cleanup());
    const briefingReader = new ReviewBriefingReader(
      repository.context,
      files,
      emptyConversation,
      briefing,
    );
    const staged = await stageReviewContext(briefingReader, diff, repository.headSha);
    const ledger = new ReviewEvidenceLedger(
      repository.root,
      files,
      { mergeBaseSha: diff.mergeBaseSha, headSha: repository.headSha },
      diff.files,
    );
    const events: string[] = [];
    const delivery = new ReviewContextDelivery(staged, home, briefingReader, ledger, (event) =>
      events.push(event),
    );
    const stagedPacket = staged.packets[0];
    assert.ok(stagedPacket);
    assert.equal(delivery.stageStartupPacket(2, stagedPacket.wireBytes - 1), undefined);
    const packet = delivery.stageStartupPacket();
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
    const compaction =
      executor === "codex"
        ? {
            type: "compacted",
            payload: {
              replacement_history: [
                { type: "message", role: "assistant", content: "Summary only." },
              ],
            },
          }
        : { type: "system", subtype: "compact_boundary", sessionId };
    await append(compaction);
    await delivery.refresh();
    assert.equal(ledger.uniqueSourceBytes, 0);
    assert.equal(briefingReader.complete, false);
    assert.equal(delivery.stage()?.id, packet.id);
    assert.ok(events.includes("context-packet-compacted"));
    if (executor === "codex") await append(turnStarted);
    await append(message("user", packet.text), message("assistant", "Replay received."));
    if (executor === "codex") await append(successfulExchange);
    await delivery.boundary();
    assert.equal(ledger.uniqueSourceBytes, packet.sourceBytes);
    await append(compaction);
    assert.equal(await delivery.boundary(), true);
    assert.equal(ledger.uniqueSourceBytes, 0);
    assert.equal(briefingReader.complete, false);
    const fallback = delivery.nextMessage();
    assert.equal(fallback?.packet, false);
    assert.match(fallback.text, /finish unread changed ranges with read_pr_diff remaining=true/u);
    assert.equal(delivery.stage(), undefined);
  });
}

test(
  "real Codex discovery rejects stale source cursors when packet verification is lost",
  { timeout: 120_000 },
  async (t) => {
    const home = await isolatedTemporaryRoot(t);
    const path = "reference.txt";
    const repository = await makeReplayRepository(t, (root) =>
      writeFile(join(root, path), "Repository context for the cursor.\n".repeat(1_000)),
    );
    const { context, root, baseSha, headSha } = repository;
    const files = await readPullRequestFilesFromSnapshots(context, root, baseSha);
    const diff = await makeDiffFromSnapshots(root, baseSha, headSha, home);
    t.after(() => diff.cleanup());
    const sharedContext = await stageReviewContext(
      new ReviewBriefingReader(context, files, emptyConversation, briefing),
      diff,
      headSha,
    );
    const selection = { revision: "head", path };
    let step = 0;
    let cursor: string | undefined;
    let rejected = false;
    const upstream = await modelFixture(t, async ({ body }) => {
      switch (step++) {
        case 0:
          return { tool: "read_repository_file", args: selection };
        case 1: {
          const page = historyDocuments(body).find((document) => document.path === path);
          assert.ok(typeof page?.nextCursor === "string");
          cursor = page.nextCursor;
          const sessions = globSync("ai-pr-reviewer-discovery-*/sessions/**/*.jsonl", {
            cwd: home,
          });
          assert.equal(sessions.length, 1);
          const [transcript] = sessions;
          assert.ok(transcript);
          const session = join(home, transcript);
          await rename(session, session + ".unavailable");
          return { tool: "read_discovery_evidence", args: {} };
        }
        case 2:
          return { tool: "read_repository_file", args: { ...selection, cursor } };
        case 3:
          assert.ok(
            historyText(body).includes("The cursor's evidence was reset."),
            "The stale cursor must return a restart instruction.",
          );
          rejected = true;
          return {
            tool: "finish_discovery",
            args: { changeMap: "Inspect the changed text.", observations: [], unknowns: [] },
          };
        default:
          return { text: "Discovery complete." };
      }
    });
    const discovery = await runSharedDiscovery({
      context,
      files,
      conversation: emptyConversation,
      config: reviewConfig({ executor: "codex", aiBaseUrl: upstream.url, model: "gpt-6.1-sol" }),
      diff,
      cwd: root,
      queryAgent: query,
      abortController: undefined,
      briefing,
      sharedContext,
    });
    t.after(() => discovery.cleanup());
    assert.equal(discovery.result.status, "completed");
    assert.equal(rejected, true);
  },
);

for (const startupFailure of [false, true])
  test(
    `real Codex recovers a rejected ${startupFailure ? "startup injection" : "overflow turn"} with unread paged source`,
    { timeout: 120_000 },
    async (t) => {
      await isolatedTemporaryRoot(t);
      const repository = await makeReplayRepository(t, async (root) => {
        await writeFile(join(root, "overflow.txt"), "baseline\n");
      });
      await writeFile(
        join(repository.root, "overflow.txt"),
        `${"overflow fallback fixture ".repeat(5)}\n`.repeat(startupFailure ? 720 : 1_350),
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
      const request = Reflect.get<CodexAppServer, "request">(CodexAppServer.prototype, "request");
      let rejectedPacket: string | undefined;
      let earlierPacket: string | undefined;
      let startupBytes = 0;
      t.mock.method(
        CodexAppServer.prototype,
        "request",
        function (
          this: CodexAppServer,
          method: string,
          params: unknown,
          timeout?: number,
        ): Promise<unknown> {
          if (rejectedPacket === undefined && isRecord(params)) {
            const item: unknown =
              startupFailure &&
              method === "thread/inject_items" &&
              Array.isArray(params.items) &&
              isRecord(params.items[0]) &&
              Array.isArray(params.items[0].content)
                ? params.items[0].content[0]
                : !startupFailure && method === "turn/start" && Array.isArray(params.input)
                  ? params.input[0]
                  : undefined;
            if (
              isRecord(item) &&
              typeof item.text === "string" &&
              item.text.startsWith(REVIEW_CONTEXT_PACKET_PREFIX)
            ) {
              const packet: unknown = JSON.parse(
                item.text.slice(REVIEW_CONTEXT_PACKET_PREFIX.length),
              );
              assert.ok(isRecord(packet) && typeof packet.id === "string");
              if (startupFailure && !packet.id.endsWith(":3")) {
                if (packet.id.endsWith(":2")) {
                  earlierPacket = packet.id;
                  startupBytes += Buffer.byteLength(item.text);
                }
                return request.call(this, method, params, timeout);
              }
              assert.equal(packet.more, false);
              if (startupFailure) startupBytes += Buffer.byteLength(item.text);
              assert.ok(packet.id.endsWith(startupFailure ? ":3" : ":4"));
              rejectedPacket = packet.id;
              return request
                .call(this, method, { ...params, threadId: randomUUID() }, timeout)
                .catch((error: unknown) => {
                  assert.ok(error instanceof CodexRpcError);
                  throw error;
                });
            }
          }
          return request.call(this, method, params, timeout);
        },
      );
      const output: string[] = [];
      const emit = process.stdout.write.bind(process.stdout);
      t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
        output.push(chunk.toString());
        return true;
      });
      let recovered = false;
      let probe = 0;
      let fallbackStateRequested = false;
      const submission = {
        tool: "submit_review",
        args: { summary: "Reviewed.", findings: [], limitations: [] },
      } as const;
      const upstream = await modelFixture(t, ({ body }) => {
        const history = historyText(body);
        const firstGoal = history.includes("FALLBACK_SWEEP_GOAL");
        if (!firstGoal && !history.includes("CONTROL_SWEEP_GOAL"))
          return history.includes("Discovery change map accepted.")
            ? { text: "Orientation complete." }
            : {
                tool: "finish_discovery",
                args: { changeMap: "Inspect the overflow source.", observations: [], unknowns: [] },
              };
        if (history.includes("Review submission accepted.")) return { text: "Review complete." };
        const documents = historyDocuments(body);
        if (firstGoal && !startupFailure && rejectedPacket === undefined) {
          if (++probe === 1) return { tool: "read_review_state", args: {} };
          if (probe === 2) {
            const state = documents.findLast(({ inspection }) => isRecord(inspection));
            assert.deepEqual(
              state?.nextCall,
              ADVANCE_REVIEW_CONTEXT_CALL,
              "The fresh review state steers to packet four.",
            );
            assert.ok(
              Array.isArray(state.records) &&
                state.records.some(
                  (record: unknown) =>
                    isRecord(record) &&
                    record.kind === "next_call" &&
                    record.tool === ADVANCE_REVIEW_CONTEXT_CALL.tool,
                ),
            );
            return submission;
          }
          assert.match(
            history.replaceAll("\\", ""),
            /"categories":\[[^\]]*"inspection"[^\]]*\],"remainingCorrections":\d+,"nextCall":\{"tool":"advance_review_context","arguments":\{\}\}/u,
          );
          return { tool: "advance_review_context", args: {} };
        }
        if (firstGoal && rejectedPacket !== undefined) {
          assert.ok(!history.includes(rejectedPacket));
          if (!fallbackStateRequested) {
            fallbackStateRequested = true;
            return { tool: "read_review_state", args: {} };
          }
          const state = documents.findLast(({ inspection }) => isRecord(inspection));
          assert.deepEqual(state?.nextCall, {
            tool: "read_pr_diff",
            arguments: { remaining: true },
          });
          recovered = documents.some(({ done, remaining }) => done === true && remaining === true);
          if (!recovered) return { tool: "read_pr_diff", args: { remaining: true } };
        } else if (
          history.includes(String.raw`\"more\":true`) &&
          !history.includes(String.raw`\"more\":false`)
        )
          return { tool: "advance_review_context", args: {} };
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
          parallelCount: 1,
          maxTurns: 12,
          reviewPrompts: ["FALLBACK_SWEEP_GOAL", "CONTROL_SWEEP_GOAL"].map((prompt) => ({
            prompt,
            files: [],
          })),
        }),
        [[], []],
        repository.root,
        undefined,
        undefined,
        { linkedIssues: [], linkedIssueReferencesTruncated: false, repositoryGuidance: [] },
      );
      const rejectedId = rejectedPacket;
      assert.ok(
        rejectedId && recovered,
        output
          .filter((line) => /context-packet-|review-result/u.test(line))
          .slice(-25)
          .join("\n"),
      );
      if (startupFailure) {
        const earlierId = earlierPacket;
        assert.ok(earlierId && startupBytes <= STARTUP_PRELOAD_WIRE_BYTES);
        const failedAt = output.findIndex(
          (line) => line.includes("context-packet-unconfirmed") && line.includes(rejectedId),
        );
        const confirmedAt = output.findIndex(
          (line) => line.includes("context-packet-confirmed") && line.includes(earlierId),
        );
        assert.ok(failedAt !== -1 && confirmedAt > failedAt);
        assert.match(
          output[failedAt] ?? "",
          /"fallback":"paged tools".*"reason":"no-native-receipt"/u,
        );
        assert.doesNotMatch(output.join(""), /overflow fallback fixture/u);
        emit(output[failedAt] ?? "");
        emit(output[confirmedAt] ?? "");
      }
      assert.ok(
        output.some(
          (line) => line.includes("context-packet-unconfirmed") && line.includes(rejectedId),
        ),
      );
      assert.deepEqual(
        run.goals.map(({ status }) => status),
        ["completed", "completed"],
      );
    },
  );
