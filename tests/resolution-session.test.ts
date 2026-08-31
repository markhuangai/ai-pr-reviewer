import {
  assert,
  CancellationError,
  test,
  type Options,
  type PullRequestContext,
  type ReviewConfig,
} from "./agent-test-helpers.js";
import {
  runResolutionVerifiers,
  resolutionInternals,
  verifyResolution,
  type ResolutionQuery,
} from "../src/runtime/resolution-session.js";
import type { ReviewLifecycleThreadRecord } from "../src/lib/github-review-lifecycle.js";
import type { SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const context: PullRequestContext = {
  repository: "owner/repository",
  owner: "owner",
  name: "repository",
  number: 1,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  baseRef: "main",
  title: "Resolution",
  htmlUrl: "https://github.com/owner/repository/pull/1",
};
const config: ReviewConfig = {
  githubToken: "token",
  aiBaseUrl: "https://ai.example.test",
  aiSecret: "secret",
  model: "review-model",
  reviewPrompts: [{ prompt: "correctness", files: [] }],
  parallelCount: 1,
  maxTurns: 4,
  autoApprove: false,
  interactWithPullRequest: true,
  mcpServers: {},
};
const thread: ReviewLifecycleThreadRecord = {
  nodeId: "thread-node",
  isResolved: false,
  isOutdated: true,
  path: "src/change.ts",
  line: 4,
  originalLine: 4,
  reviewId: 10,
  reviewNodeId: "review-node",
  comments: [
    {
      nodeId: "comment-node",
      databaseId: 11,
      reviewId: 10,
      reviewNodeId: "review-node",
      author: { login: "review-action", type: "User" },
      body: "The old failure path is unsafe.",
      commitId: context.baseSha,
      createdAt: "2026-08-31T00:00:00Z",
      updatedAt: "2026-08-31T00:00:00Z",
    },
  ],
};

function fakeQuery(
  inputHandler: (tool: {
    handler(input: Record<string, unknown>): Promise<{ content: readonly { text?: string }[] }>;
  }) => Promise<unknown>,
): ResolutionQuery {
  return ((input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const output = input.options.mcpServers?.resolution_output as unknown as {
      readonly instance: {
        readonly _registeredTools: Record<
          string,
          {
            handler(
              input: Record<string, unknown>,
            ): Promise<{ content: readonly { text?: string }[] }>;
          }
        >;
      };
    };
    const submit = output.instance._registeredTools.submit_resolution;
    assert.ok(submit);
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
        const message = await input.prompt[Symbol.asyncIterator]().next();
        assert.equal(message.done, false);
        const content = message.value.message.content;
        const contentText = typeof content === "string" ? content : JSON.stringify(content);
        assert.ok(contentText.includes(context.headSha));
        await inputHandler(submit);
        yield {
          type: "result",
          subtype: "success",
          errors: [],
          num_turns: 1,
          duration_ms: 1,
          duration_api_ms: 1,
          is_error: false,
          session_id: "resolution-session",
          uuid: "resolution-result",
          modelUsage: {},
        } as unknown as SDKResultMessage;
      },
      mcpServerStatus: () => Promise.resolve([]),
    };
  }) as unknown as ResolutionQuery;
}

interface ScriptedTurn {
  readonly hasSubmission?: boolean;
  readonly submission?: unknown;
  readonly duplicateSubmission?: unknown;
  readonly subtype?: string;
  readonly errors?: readonly string[];
  readonly failure?: Error;
}

function scriptedQuery(
  turns: readonly ScriptedTurn[],
  onSubmission?: (result: { readonly content: readonly { readonly text?: string }[] }) => void,
  onQuery?: () => void,
): ResolutionQuery {
  return ((input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    onQuery?.();
    const output = input.options.mcpServers?.resolution_output as unknown as {
      readonly instance: {
        readonly _registeredTools: Record<
          string,
          {
            handler(
              input: Record<string, unknown>,
            ): Promise<{ content: readonly { text?: string }[] }>;
          }
        >;
      };
    };
    const submit = output.instance._registeredTools.submit_resolution;
    assert.ok(submit);
    return {
      async *[Symbol.asyncIterator](): AsyncGenerator<SDKResultMessage> {
        const iterator = input.prompt[Symbol.asyncIterator]();
        for (const turn of turns) {
          const message = await iterator.next();
          assert.equal(message.done, false);
          if (turn.failure !== undefined) throw turn.failure;
          if (turn.hasSubmission === true) {
            const result = await submit.handler(turn.submission as Record<string, unknown>);
            onSubmission?.(result);
            if (turn.duplicateSubmission !== undefined) {
              const duplicate = await submit.handler(
                turn.duplicateSubmission as Record<string, unknown>,
              );
              onSubmission?.(duplicate);
            }
          }
          yield {
            type: "result",
            subtype: turn.subtype ?? "success",
            errors: [...(turn.errors ?? [])],
            num_turns: 1,
            duration_ms: 1,
            duration_api_ms: 1,
            is_error: turn.subtype !== undefined && turn.subtype !== "success",
            session_id: "resolution-session",
            uuid: "resolution-result",
            modelUsage: {},
          } as unknown as SDKResultMessage;
        }
      },
      mcpServerStatus: () => Promise.resolve([]),
    };
  }) as unknown as ResolutionQuery;
}

test("resolution verifier accepts an explicit high-confidence fixed verdict", async () => {
  const result = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    fakeQuery((submit) =>
      submit.handler({ verdict: "fixed", confidence: "high", rationale: "guard restored" }),
    ),
  );
  assert.deepEqual(result, {
    status: "completed",
    verdict: "fixed",
    confidence: "high",
    rationale: "guard restored",
  });
});

test("resolution verifier preserves non-high confidence verdicts for the lifecycle guard", async () => {
  const result = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    fakeQuery((submit) =>
      submit.handler({ verdict: "fixed", confidence: "medium", rationale: "probably fixed" }),
    ),
  );
  assert.equal(result.status, "completed");
  assert.equal(result.verdict, "fixed");
  assert.equal(result.confidence, "medium");
});

test("resolution prompt bounds large untrusted thread content", () => {
  const originalComment = thread.comments[0];
  assert.ok(originalComment);
  const largeThread = {
    ...thread,
    comments: [{ ...originalComment, body: "x".repeat(100_000) }],
  };
  const prompt = resolutionInternals.resolutionPrompt(context, largeThread);
  assert.match(prompt, /thread context truncated/u);
  assert.ok(prompt.length < 40_000);
});

test("repairs invalid verifier submissions before accepting a valid result", async () => {
  const toolResults: string[] = [];
  const result = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery(
      [
        { hasSubmission: true, submission: null },
        {
          hasSubmission: true,
          submission: { verdict: "not_fixed", confidence: "high", rationale: "still present" },
        },
      ],
      (response) => toolResults.push(response.content[0]?.text ?? ""),
    ),
  );
  assert.deepEqual(result, {
    status: "completed",
    verdict: "not_fixed",
    confidence: "high",
    rationale: "still present",
  });
  assert.deepEqual(toolResults, [
    "Resolution submission rejected. Input must be an object.",
    "Resolution accepted.",
  ]);
});

test("rejects duplicate submissions and reports non-success or missing verdicts", async () => {
  const duplicateResults: string[] = [];
  const accepted = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery(
      [
        {
          hasSubmission: true,
          submission: { verdict: "fixed", confidence: "high", rationale: "fixed" },
          duplicateSubmission: { verdict: "not_fixed", confidence: "high", rationale: "late" },
        },
      ],
      (response) => {
        duplicateResults.push(response.content[0]?.text ?? "");
      },
    ),
  );
  assert.equal(accepted.status, "completed");

  const invalidResults: string[] = [];
  const invalid = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery(
      [
        {
          hasSubmission: true,
          submission: { verdict: "fixed", confidence: "high", rationale: "fixed", extra: true },
        },
        {
          hasSubmission: true,
          submission: { verdict: "uncertain", confidence: "low", rationale: "not enough evidence" },
        },
      ],
      (response) => invalidResults.push(response.content[0]?.text ?? ""),
    ),
  );
  assert.equal(invalid.status, "completed");
  assert.equal(invalid.verdict, "uncertain");
  assert.deepEqual(invalidResults, [
    "Resolution submission rejected. The verdict was invalid.",
    "Resolution accepted.",
  ]);
  assert.deepEqual(duplicateResults, [
    "Resolution accepted.",
    "Resolution submission rejected. A verdict was already accepted.",
  ]);

  const noVerdict = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery([{}, {}, {}]),
  );
  assert.deepEqual(noVerdict, {
    status: "failed",
    error: "The verifier did not submit a resolution verdict.",
  });

  const providerFailure = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery([{ subtype: "error", errors: ["provider failed"] }]),
  );
  assert.deepEqual(providerFailure, { status: "failed", error: "provider failed" });
  const unnamedFailure = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery([{ subtype: "error" }]),
  );
  assert.deepEqual(unnamedFailure, { status: "failed", error: "Claude returned error." });
});

test("contains provider and reader failures while preserving cancellation", async () => {
  const providerError = new Error("query failed");
  const providerFailure = await verifyResolution(context, thread, config, "/workspace", () => {
    throw providerError;
  });
  assert.deepEqual(providerFailure, { status: "failed", error: "query failed" });

  const readerFailure = await verifyResolution(
    context,
    thread,
    config,
    "/workspace",
    scriptedQuery([{ failure: new Error("reader failed") }]),
  );
  assert.deepEqual(readerFailure, { status: "failed", error: "reader failed" });

  const controller = new AbortController();
  const cancellation = new CancellationError("SIGTERM");
  controller.abort(cancellation);
  await assert.rejects(
    verifyResolution(context, thread, config, "/workspace", scriptedQuery([]), controller),
    (error: unknown) => error === cancellation,
  );
});

test("configures a read-only verifier and processes verifiers in bounded batches", async () => {
  const controller = new AbortController();
  const options = resolutionInternals.optionsForResolution(
    { ...config, effort: "high" },
    "/workspace",
    controller,
    {} as never,
  );
  assert.equal(options.cwd, "/workspace");
  assert.equal(options.effort, "high");
  assert.equal(options.abortController, controller);
  assert.deepEqual(options.tools, ["Read", "Glob", "Grep"]);
  assert.deepEqual(options.allowedTools, [
    "Read",
    "Glob",
    "Grep",
    "mcp__resolution_output__submit_resolution",
  ]);
  const noLine = { ...thread };
  delete noLine.line;
  assert.match(resolutionInternals.resolutionPrompt(context, noLine), /src\/change\.ts/u);
  assert.match(resolutionInternals.resolutionRepairPrompt(2), /repair attempt 2/u);

  const threads = Array.from({ length: 6 }, (_, index) => ({
    ...thread,
    nodeId: `thread-${index}`,
  }));
  let queryCount = 0;
  const results = await runResolutionVerifiers(
    context,
    threads,
    config,
    "/workspace",
    scriptedQuery(
      [
        {
          hasSubmission: true,
          submission: { verdict: "fixed", confidence: "high", rationale: "gone" },
        },
      ],
      undefined,
      () => {
        queryCount += 1;
      },
    ),
  );
  assert.equal(results.length, 6);
  assert.equal(queryCount, 6);
  assert.deepEqual(
    await runResolutionVerifiers(context, [], config, "/workspace", scriptedQuery([])),
    [],
  );
});
