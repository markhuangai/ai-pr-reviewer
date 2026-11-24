import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readPullRequestFilesFromSnapshots } from "../src/lib/git-changed-files.js";
import { isRecord } from "../src/runtime/agent-logging.js";
import { runReviewGoals } from "../src/runtime/agent.js";
import { CodexAppServer, CodexRpcError } from "../src/runtime/codex-app-server.js";
import { REVIEW_CONTEXT_PACKET_PREFIX } from "../src/runtime/review-context-packets.js";
import { emptyConversation, reviewConfig } from "./agent-test-helpers.js";
import {
  historyDocuments,
  historyText,
  isolatedTemporaryRoot,
  modelFixture,
} from "./codex-test-helpers.js";
import { commitFixtureSnapshot, makeReplayRepository } from "./git-test-helpers.js";

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
