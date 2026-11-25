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
import { runReviewGoals } from "../src/runtime/agent.js";
import { CodexAppServer, CodexRpcError } from "../src/runtime/codex-app-server.js";
import { ReviewEvidenceLedger } from "../src/runtime/review-assessment.js";
import { ReviewBriefingReader } from "../src/runtime/review-briefing.js";
import {
  ReviewContextDelivery,
  STARTUP_PRELOAD_PACKETS,
  STARTUP_PRELOAD_WIRE_BYTES,
} from "../src/runtime/review-context-delivery.js";
import {
  REVIEW_CONTEXT_PACKET_PREFIX,
  stageReviewContext,
} from "../src/runtime/review-context-packets.js";
import { runSharedDiscovery } from "../src/runtime/shared-discovery.js";
import {
  emptyConversation,
  goalContext,
  makeReviewDiff,
  reviewConfig,
} from "./agent-test-helpers.js";
import {
  historyDocuments,
  historyText,
  isolatedTemporaryRoot,
  modelFixture,
} from "./codex-test-helpers.js";
import {
  commitFixtureSnapshot,
  makeDiffFromSnapshots,
  makeReplayRepository,
} from "./git-test-helpers.js";

const briefing = { linkedIssues: [], linkedIssueReferencesTruncated: false };

test("startup packet staging obeys count and wire limits across a partial failure", async (t) => {
  const home = await isolatedTemporaryRoot(t);
  const diff = await makeReviewDiff(t, "+start-up fixture data\n".repeat(7_400));
  const reader = new ReviewBriefingReader(goalContext, [], emptyConversation, briefing);
  const prepared = await stageReviewContext(reader, diff, goalContext.headSha);
  const ledger = new ReviewEvidenceLedger(
    home,
    [],
    { mergeBaseSha: diff.mergeBaseSha, headSha: goalContext.headSha },
    diff.files,
  );
  const delivery = new ReviewContextDelivery(prepared, home, reader, ledger, () => undefined);
  const [first, second, third] = prepared.packets;
  assert.ok(first && second && third);
  assert.equal(delivery.stageStartupPacket(2, first.wireBytes - 1), undefined);
  assert.equal(delivery.stageStartupPacket(), first);
  assert.equal(delivery.stage(), undefined);
  assert.equal(delivery.stageStartupPacket(2, first.wireBytes + second.wireBytes - 1), undefined);
  assert.equal(delivery.stageStartupPacket(), second);
  assert.equal(STARTUP_PRELOAD_PACKETS, 2);
  assert.ok(first.wireBytes + second.wireBytes <= STARTUP_PRELOAD_WIRE_BYTES);
  delivery.deferInFlight(second.id);
  assert.equal(delivery.stageStartupPacket(), undefined);
  assert.equal(
    delivery.stage(),
    undefined,
    "Deferring the second packet preserves the first in flight.",
  );
  assert.equal(delivery.hasUnstagedPackets, true);
  await delivery.boundary();
  assert.equal(delivery.stage(), third);
});

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
    if (executor === "codex") {
      await append(
        turnStarted,
        message("user", packet.text),
        message("assistant", "Replay received."),
      );
      await append(successfulExchange);
    } else {
      await append({ ...message("user", packet.text), uuid: randomUUID() });
      await delivery.refresh(randomUUID());
      assert.equal(ledger.uniqueSourceBytes, 0);
      await delivery.refresh(sessionId);
      assert.equal(ledger.uniqueSourceBytes, packet.sourceBytes);
      await append({ type: "attachment", sessionId });
      await delivery.refresh();
      assert.equal(ledger.uniqueSourceBytes, packet.sourceBytes);
    }
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

test(
  "real Codex recovers a rejected overflow turn with unread paged source",
  { timeout: 120_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const repository = await makeReplayRepository(t, async (root) => {
      await writeFile(join(root, "overflow.txt"), "baseline\n");
    });
    await writeFile(
      join(repository.root, "overflow.txt"),
      `${"overflow fallback fixture ".repeat(5)}\n`.repeat(1_350),
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
    let rejectedStartupPacket: string | undefined;
    let thirdInjections = 0;
    t.mock.method(
      CodexAppServer.prototype,
      "request",
      function (
        this: CodexAppServer,
        method: string,
        params: unknown,
        timeout?: number,
      ): Promise<unknown> {
        if (method === "thread/inject_items" && isRecord(params) && Array.isArray(params.items)) {
          const item: unknown = params.items[0];
          const block: unknown =
            isRecord(item) && Array.isArray(item.content) ? item.content[0] : undefined;
          if (
            isRecord(block) &&
            typeof block.text === "string" &&
            block.text.startsWith(REVIEW_CONTEXT_PACKET_PREFIX)
          ) {
            const packet: unknown = JSON.parse(
              block.text.slice(REVIEW_CONTEXT_PACKET_PREFIX.length),
            );
            assert.ok(isRecord(packet) && typeof packet.id === "string");
            if (packet.id.endsWith(":3") && ++thirdInjections === 2) {
              rejectedStartupPacket = packet.id;
              return request.call(this, method, { ...params, threadId: randomUUID() }, timeout);
            }
          }
        }
        if (
          method === "turn/start" &&
          rejectedPacket === undefined &&
          isRecord(params) &&
          Array.isArray(params.input)
        ) {
          const item: unknown = params.input[0];
          if (
            isRecord(item) &&
            typeof item.text === "string" &&
            item.text.startsWith(REVIEW_CONTEXT_PACKET_PREFIX)
          ) {
            const packet: unknown = JSON.parse(
              item.text.slice(REVIEW_CONTEXT_PACKET_PREFIX.length),
            );
            assert.ok(isRecord(packet) && typeof packet.id === "string");
            assert.equal(packet.more, false);
            assert.ok(packet.id.endsWith(":4"));
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
    t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
      output.push(chunk.toString());
      return true;
    });
    let recovered = false;
    let startupRecovered = false;
    let overflowStep = 0;
    let fallbackStateRead = false;
    const readState = { tool: "read_review_state", args: {} };
    const advance = { tool: "advance_review_context", args: {} };
    const submit = {
      tool: "submit_review",
      args: { summary: "Reviewed.", findings: [], limitations: [] },
    };
    const advanceCall = { tool: "advance_review_context", arguments: {} };
    const pagedCall = { tool: "read_pr_diff", arguments: { remaining: true } };
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
      if (firstGoal && rejectedPacket === undefined) {
        const step = overflowStep++;
        if (step === 0) return readState;
        const state = documents.find((doc) => doc.briefingComplete === true);
        assert.deepEqual(state?.nextCall, advanceCall);
        assert.deepEqual((state?.records as unknown[])[0], { kind: "next_call", ...advanceCall });
        if (step === 1) return readState;
        assert.ok(
          documents.some(
            (doc) =>
              doc.inspection !== undefined &&
              !Array.isArray(doc.records) &&
              JSON.stringify(doc.nextCall) === JSON.stringify(advanceCall),
          ),
        );
        if (step === 2) return submit;
        const rejection = documents.find((doc) => Array.isArray(doc.categories));
        assert.deepEqual(rejection?.nextCall, advanceCall);
      }
      if (firstGoal && rejectedPacket !== undefined) {
        assert.ok(!history.includes(rejectedPacket));
        assert.ok(
          history.includes("finish unread changed ranges with read_pr_diff remaining=true"),
        );
        if (!fallbackStateRead) {
          fallbackStateRead = true;
          return readState;
        }
        assert.deepEqual(
          documents.findLast((doc) => doc.briefingComplete === true)?.nextCall,
          pagedCall,
        );
        recovered = documents.some(({ done, remaining }) => done === true && remaining === true);
        if (!recovered) return { tool: "read_pr_diff", args: { remaining: true } };
      } else if (
        history.includes(String.raw`\"more\":true`) &&
        !history.includes(String.raw`\"more\":false`)
      )
        return advance;
      if (!firstGoal && rejectedStartupPacket !== undefined) {
        assert.ok(!history.includes(rejectedStartupPacket));
        startupRecovered = documents.some(
          ({ done, remaining }) => done === true && remaining === true,
        );
        if (!startupRecovered) return { tool: "read_pr_diff", args: { remaining: true } };
      }
      return submit;
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
    assert.ok(
      output.some(
        (line) => line.includes("context-packet-unconfirmed") && line.includes(rejectedId),
      ),
    );
    const rejectedStartupId = rejectedStartupPacket;
    assert.ok(rejectedStartupId && startupRecovered);
    const packetLogs = output.filter((line) => /\[goal 2\] session context-packet-/u.test(line));
    const unconfirmed = packetLogs.findIndex(
      (line) => line.includes("context-packet-unconfirmed") && line.includes(rejectedStartupId),
    );
    assert.ok(unconfirmed >= 0);
    assert.match(
      packetLogs[unconfirmed] ?? "",
      /"snapshot":"[a-f0-9]{64}".*"unreadBytes":[1-9]\d*,"fallback":"paged tools","reason":"no-native-receipt"/u,
    );
    assert.ok(
      packetLogs
        .slice(unconfirmed + 1)
        .some(
          (line) =>
            line.includes("context-packet-confirmed") &&
            line.includes(rejectedStartupId.replace(/:3$/u, ":2")),
        ),
    );
    assert.ok(!packetLogs.join("").includes("overflow fallback fixture"));
    assert.deepEqual(
      run.goals.map(({ status }) => status),
      ["completed", "completed"],
    );
  },
);
