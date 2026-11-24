import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
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
import { ReviewContextDelivery } from "../src/runtime/review-context-delivery.js";
import {
  REVIEW_CONTEXT_PACKET_PREFIX,
  stageReviewContext,
} from "../src/runtime/review-context-packets.js";
import { emptyConversation, reviewConfig } from "./agent-test-helpers.js";
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
  "real Codex recovers a rejected overflow turn with unread paged source",
  { timeout: 120_000 },
  async (t) => {
    await isolatedTemporaryRoot(t);
    const repository = await makeReplayRepository(t, async (root) => {
      await writeFile(join(root, "overflow.txt"), "baseline\n");
    });
    await writeFile(
      join(repository.root, "overflow.txt"),
      `${"overflow fallback fixture ".repeat(5)}\n`.repeat(900),
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
    t.mock.method(
      CodexAppServer.prototype,
      "request",
      function (
        this: CodexAppServer,
        method: string,
        params: unknown,
        timeout?: number,
      ): Promise<unknown> {
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
      if (firstGoal && rejectedPacket !== undefined) {
        assert.ok(!history.includes(rejectedPacket));
        assert.ok(
          history.includes("finish unread changed ranges with read_pr_diff remaining=true"),
        );
        recovered = historyDocuments(body).some(
          ({ done, remaining }) => done === true && remaining === true,
        );
        if (!recovered) return { tool: "read_pr_diff", args: { remaining: true } };
      } else if (
        history.includes(String.raw`\"more\":true`) &&
        !history.includes(String.raw`\"more\":false`)
      )
        return { tool: "advance_review_context", args: {} };
      return {
        tool: "submit_review",
        args: { summary: "Reviewed.", findings: [], limitations: [] },
      };
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
    assert.deepEqual(
      run.goals.map(({ status }) => status),
      ["completed", "completed"],
    );
  },
);
