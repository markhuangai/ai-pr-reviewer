import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { prepareReplayRuntime, runReplay } from "../scripts/run-replay.js";
import {
  parseReplayCase,
  replayCase,
  serializeReplayOutput,
  validateReplayOutputPath,
  writeReplayOutput,
  type ReplayCase,
  type ReplayRunner,
} from "../scripts/replay-review.js";
import { commitFixtureSnapshot, makeReplayRepository } from "./git-test-helpers.js";

const execFileAsync = promisify(execFile);
async function temporaryDirectory(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...args], { cwd, encoding: "utf8" });
  return result.stdout.trim();
}

test("old replay cases default to Claude and Codex cases retain explicit settings", () => {
  const input = {
    version: 1,
    caseId: "executor",
    context: {
      repository: "owner/repository",
      owner: "owner",
      name: "repository",
      number: 1,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      baseRef: "main",
      title: "fixture",
      htmlUrl: "https://github.com/owner/repository/pull/1",
    },
    config: {
      model: "literal-route",
      reviewPrompts: [{ prompt: "Review" }],
      parallelCount: 1,
      maxTurns: 5,
    },
  };
  assert.equal(parseReplayCase(input).config.executor, "claude");
  assert.equal("sharedDiscovery" in parseReplayCase(input).config, false);
  assert.throws(
    () => parseReplayCase({ ...input, config: { ...input.config, sharedDiscovery: false } }),
    /sharedDiscovery/u,
  );
  const selected = parseReplayCase({
    ...input,
    config: {
      ...input.config,
      executor: "codex",
      effort: "max",
      aiBaseUrl: "https://proxy.example/v1",
    },
  });
  assert.equal(selected.config.executor, "codex");
  assert.equal(selected.config.model, "literal-route");
  assert.equal(selected.config.effort, "max");
});

test("replays a frozen case without publishing, switching revisions, or exposing labels", async (t) => {
  const {
    root: checkout,
    temporaryRoot: results,
    baseSha,
    headSha,
  } = await makeReplayRepository(t);
  const canonicalCheckout = await realpath(checkout);
  const mergeBaseSha = baseSha;
  const changedPath = "review.txt";
  const context = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 123,
    baseSha,
    headSha,
    baseRef: "main",
    title: "Example mcp-replay-credential",
    body: "PR body replay-secret",
    htmlUrl: "https://github.com/owner/repository/pull/123",
  };
  const input: ReplayCase = parseReplayCase({
    version: 1,
    caseId: "case-replay-secret",
    labels: { expected: ["known-defect"], private: "replay-secret" },
    context,
    config: {
      aiBaseUrl: "https://api.example.test",
      model: "consumer-model-id",
      systemPrompt: "Consumer replacement prompt.",
      reviewPrompts: [{ prompt: "Review the changed behavior." }],
      parallelCount: 1,
      maxTurns: 25,
      interactWithPullRequest: false,
      mcpServers: {
        security: {
          type: "http",
          url: "https://mcp.example.test",
          headers: {
            "X-MCP-Key": "mcp-replay-credential",
            "X-Path-Secret": changedPath,
            "X-Repository-Secret": context.repository,
            "X-Base-Secret": baseSha,
            "X-Head-Secret": headSha,
            "X-Merge-Base-Secret": mergeBaseSha,
          },
        },
      },
    },
    conversation: {
      digest: "conversation-digest",
      entries: [
        {
          kind: "pr_comment",
          id: 1,
          createdAt: "2026-09-23T00:00:00Z",
          message: {
            id: 1,
            authorRole: "human",
            body: "Discussion mcp-replay-credential replay-secret",
            createdAt: "2026-09-23T00:00:00Z",
            updatedAt: "2026-09-23T00:00:00Z",
          },
        },
      ],
    },
    briefing: {
      linkedIssues: [
        {
          number: 321,
          title: "Issue mcp-replay-credential",
          state: "OPEN",
          body: "Issue body replay-secret",
          htmlUrl: "https://github.com/owner/repository/issues/321",
        },
      ],
      linkedIssueReferencesTruncated: false,
      unavailableLinkedIssues: [{ number: 322, status: 403 }],
    },
  });
  assert.throws(() =>
    parseReplayCase({
      ...input,
      briefing: { ...input.briefing, unavailableLinkedIssues: [{ number: 322, status: 500 }] },
    }),
  );
  assert.throws(() =>
    parseReplayCase({
      ...input,
      config: {
        ...input.config,
        reviewPrompts: [{ prompt: "Review", files: ["relative/context.txt"] }],
      },
    }),
  );

  const previousSecret = process.env.AI_PR_REVIEWER_SECRET;
  process.env.AI_PR_REVIEWER_SECRET = "replay-secret";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.AI_PR_REVIEWER_SECRET;
    else process.env.AI_PR_REVIEWER_SECRET = previousSecret;
  });
  const beforeHead = await git(checkout, ["rev-parse", "HEAD"]);
  const beforeBranch = await git(checkout, ["branch", "--show-current"]);
  let observedCalls = 0;
  let replayFindingPath = "";
  let replayFindingLine = 0;
  const runner: ReplayRunner = (
    replayContext,
    files,
    conversation,
    config,
    contextFiles,
    replayCheckout,
    _queryAgent,
    _abortController,
    briefing,
  ): ReturnType<ReplayRunner> => {
    observedCalls += 1;
    assert.equal(replayContext.headSha, headSha);
    assert.equal(replayContext.title, "Example [REDACTED]");
    assert.equal(replayContext.body, "PR body [REDACTED]");
    assert.equal(replayCheckout, canonicalCheckout);
    assert.doesNotMatch(JSON.stringify(conversation), /mcp-replay-credential|replay-secret/u);
    assert.ok(briefing);
    assert.equal(briefing.linkedIssues[0]?.title, "Issue [REDACTED]");
    assert.equal(briefing.linkedIssues[0]?.body, "Issue body [REDACTED]");
    assert.deepEqual(briefing.unavailableLinkedIssues, [{ number: 322, status: 403 }]);
    const changedFile = files[0];
    assert.ok(changedFile);
    assert.equal(files.length, 1);
    assert.equal(changedFile.path, changedPath);
    assert.deepEqual([...changedFile.addedLines], [2]);
    replayFindingPath = changedFile.path;
    replayFindingLine = 2;
    assert.equal(contextFiles[0]?.length, 0);
    assert.equal(config.reviewPrompts[0]?.prompt, "Review the changed behavior.");
    assert.equal("sharedDiscovery" in config, false);
    assert.equal(JSON.stringify(config).includes("known-defect"), false);
    return Promise.resolve({
      discovery: {
        status: "completed",
        error: "replay-secret",
        tokenUsage: {
          complete: false,
          models: [
            {
              model: "replay-secret",
              inputTokens: 111,
              outputTokens: 22,
              cacheReadInputTokens: 33,
              cacheCreationInputTokens: 44,
            },
          ],
        },
        diagnostics: {
          readCalls: 2,
          deliveredBytes: 700,
          elapsedMs: 1000,
          compactions: 1,
          termination: "replay-secret",
        },
      },
      goals: [
        {
          inspection: {
            observedPaths: [
              ...files.flatMap((file) => [
                file.path,
                ...(file.previousPath === undefined ? [] : [file.previousPath]),
              ]),
            ],
            missingPaths: [],
          },
          prompt: "Review the changed behavior.",
          status: "completed",
          diagnostics: {
            submissionAttempts: 2,
            repairAttempts: 1,
            evidenceReferences: 3,
            rejectionCounts: { "replay-secret": 1 },
            termination: "replay-secret",
          },
          submission: {
            summary: "Found a replay-secret example.",
            findings: [
              {
                title: "replay-secret defect",
                severity: "MODERATE",
                body: "The replay-secret value is dropped.",
                path: replayFindingPath,
                line: replayFindingLine,
              },
            ],
            limitations: [],
          },
        },
      ],
    });
  };
  const output = await replayCase(input, checkout, runner);
  assert.equal(observedCalls, 1);
  assert.equal(output.version, 2);
  assert.equal(output.caseId, "case-[REDACTED]");
  assert.deepEqual(output.labels, { expected: ["known-defect"], private: "[REDACTED]" });
  assert.equal(output.partial, false);
  assert.equal(output.discovery?.status, "completed");
  assert.equal(output.discovery?.error, "[REDACTED]");
  assert.equal(output.discovery?.tokenUsage.models[0]?.model, "[REDACTED]");
  assert.equal(output.discovery?.tokenUsage.complete, false);
  assert.deepEqual(output.discovery?.diagnostics, {
    readCalls: 2,
    deliveredBytes: 700,
    elapsedMs: 1000,
    compactions: 1,
    termination: "[REDACTED]",
  });
  assert.deepEqual(output.goals[0]?.diagnostics, {
    submissionAttempts: 2,
    repairAttempts: 1,
    evidenceReferences: 3,
    rejectionCounts: { "[REDACTED]": 1 },
    termination: "[REDACTED]",
  });
  assert.equal(output.findings instanceof Array, true);
  assert.equal(output.repository, "[REDACTED]");
  assert.equal(output.baseSha, "[REDACTED]");
  assert.equal(output.mergeBaseSha, "[REDACTED]");
  assert.equal(output.headSha, "[REDACTED]");
  assert.equal(JSON.stringify(output).includes("replay-secret"), false);
  assert.equal(JSON.stringify(output).includes("mcp-replay-credential"), false);
  assert.equal(JSON.stringify(output).includes(changedPath), false);
  for (const secret of [context.repository, baseSha, mergeBaseSha, headSha])
    assert.equal(JSON.stringify(output).includes(secret), false);
  assert.equal("prompt" in (output.goals[0] ?? {}), false);
  assert.equal(serializeReplayOutput(output), serializeReplayOutput(output));

  const nonIdentityInput: ReplayCase = parseReplayCase({
    ...input,
    config: {
      ...input.config,
      mcpServers: {
        security: {
          type: "http",
          url: "https://mcp.example.test",
          headers: {
            "X-MCP-Key": "mcp-replay-credential",
            "X-Path-Secret": changedPath,
          },
        },
      },
    },
  });
  const ordinaryOutput = await replayCase(nonIdentityInput, checkout, runner);
  assert.equal(ordinaryOutput.repository, context.repository);
  assert.equal(ordinaryOutput.baseSha, baseSha);
  assert.equal(ordinaryOutput.mergeBaseSha, mergeBaseSha);
  assert.equal(ordinaryOutput.headSha, headSha);
  assert.equal(observedCalls, 2);

  await assert.rejects(
    validateReplayOutputPath(join(checkout, "result.json"), checkout),
    /outside the checkout/u,
  );

  const outputPath = join(results, "case-001.json");
  await writeReplayOutput(output, outputPath, checkout);
  const outputText = await readFile(outputPath, "utf8");
  assert.equal(outputText, serializeReplayOutput(output));
  assert.equal(outputText.includes("replay-secret"), false);
  await assert.rejects(writeReplayOutput(output, outputPath, checkout), /already exists/u);
  assert.equal(await git(checkout, ["rev-parse", "HEAD"]), beforeHead);
  assert.equal(await git(checkout, ["branch", "--show-current"]), beforeBranch);
  assert.equal(
    await git(checkout, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--ignored=matching",
    ]),
    "",
  );

  await writeFile(join(checkout, "ignored.tmp"), "ignored workspace content\n");
  await assert.rejects(replayCase(input, checkout, runner), /must be pristine/u);
  await rm(join(checkout, "ignored.tmp"));
  await assert.rejects(
    replayCase({ ...input, context: { ...input.context, headSha: baseSha } }, checkout, runner),
    /does not match case head/u,
  );
});

test("accepts Action-supported replay limits and reserves the internal MCP server", () => {
  const context = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 1,
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    baseRef: "main",
    title: "Review case",
    htmlUrl: "https://github.com/owner/repository/pull/1",
  };
  const supported = parseReplayCase({
    version: 1,
    caseId: "supported-boundaries",
    context,
    config: {
      model: "consumer-model-id",
      reviewPrompts: Array.from({ length: 50 }, (_, index) => ({
        prompt: index === 0 ? "x".repeat(12_000) : "Review the change.",
        files: Array.from({ length: 25 }, (_, fileIndex) => `/tmp/context-${fileIndex}.txt`),
      })),
      parallelCount: 10,
      maxTurns: 500,
      mcpServers: {},
    },
  });
  assert.equal(supported.config.reviewPrompts.length, 50);
  assert.equal(supported.config.reviewPrompts[0]?.prompt.length, 12_000);
  assert.equal(supported.config.reviewPrompts[0]?.files.length, 25);
  const maxRunFiles = parseReplayCase({
    ...supported,
    config: {
      ...supported.config,
      reviewPrompts: Array.from({ length: 4 }, (_, goalIndex) => ({
        prompt: "Review the change.",
        files: Array.from(
          { length: 25 },
          (_, fileIndex) => `/tmp/run-${goalIndex * 25 + fileIndex}.txt`,
        ),
      })),
    },
  });
  assert.equal(maxRunFiles.config.reviewPrompts.flatMap((goal) => goal.files).length, 100);
  assert.throws(() =>
    parseReplayCase({
      ...maxRunFiles,
      config: {
        ...maxRunFiles.config,
        reviewPrompts: Array.from({ length: 5 }, (_, goalIndex) => ({
          prompt: "Review the change.",
          files: Array.from(
            { length: 25 },
            (_, fileIndex) => `/tmp/over-limit-${goalIndex * 25 + fileIndex}.txt`,
          ),
        })),
      },
    }),
  );
  assert.throws(() =>
    parseReplayCase({
      ...supported,
      config: { ...supported.config, reviewPrompts: [{ prompt: "x".repeat(12_001) }] },
    }),
  );
  assert.throws(() =>
    parseReplayCase({
      ...supported,
      config: {
        ...supported.config,
        mcpServers: {
          review_output: { type: "http", url: "https://mcp.example.test" },
        },
      },
    }),
  );
});

test("keeps replay independent of shallow, deletion-only, and symlinked callers", async (t) => {
  const { root, temporaryRoot, headSha } = await makeReplayRepository(t);
  const shallow = join(temporaryRoot, "shallow");
  await git(root, ["clone", "--quiet", "--depth=1", pathToFileURL(root).href, shallow]);
  assert.equal(await git(shallow, ["rev-parse", "--is-shallow-repository"]), "true");
  await assert.rejects(git(shallow, ["rev-parse", "--verify", "HEAD^"]));
  await rm(join(root, "review.txt"));
  const deletedHead = await commitFixtureSnapshot(root, temporaryRoot, headSha);
  assert.equal(await git(root, ["diff", "--numstat", headSha, deletedHead]), "0\t2\treview.txt");
  const linkedTemporary = join(temporaryRoot, "linked-temp");
  const actualTemporary = join(temporaryRoot, "actual-temp");
  await mkdir(actualTemporary);
  await symlink(
    actualTemporary,
    linkedTemporary,
    process.platform === "win32" ? "junction" : "dir",
  );
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  for (const [name, cwd, temporary] of [
    ["shallow", shallow, actualTemporary],
    ["deletion-only", root, actualTemporary],
    ["symlinked temp", root, linkedTemporary],
  ] as const) {
    await t.test(name, async () => {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "--test",
          "--test-reporter=spec",
          "--test-name-pattern=^replays a frozen case ",
          fileURLToPath(import.meta.url),
        ],
        {
          cwd,
          encoding: "utf8",
          env: { ...childEnvironment, TMPDIR: temporary, TEMP: temporary, TMP: temporary },
        },
      );
      assert.match(stdout, /replays a frozen case/u);
      assert.match(stdout, /pass 1/u);
    });
  }
});

test("builds replay outside its pristine package checkout and cleans success and failure", async (t) => {
  const source = fileURLToPath(new URL("../../", import.meta.url));
  const { root, temporaryRoot, context } = await makeReplayRepository(t, async (checkout) => {
    for (const path of ["src", "scripts", "package.json", "tsconfig.json", "tsconfig.replay.json"])
      await cp(join(source, path), join(checkout, path), { recursive: true });
  });
  await symlink(
    join(source, "node_modules"),
    join(root, "../node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const initialTemporary = await readdir(temporaryRoot);
  const canonicalRoot = await realpath(root);
  const status = () =>
    git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]);
  assert.equal(await status(), "");
  const input = parseReplayCase({
    version: 1,
    caseId: "self-replay",
    context,
    config: {
      model: "consumer-model-id",
      reviewPrompts: [{ prompt: "Review" }],
    },
  });
  const previousSecret = process.env.AI_PR_REVIEWER_SECRET;
  process.env.AI_PR_REVIEWER_SECRET = "replay-secret";
  t.after(() => {
    if (previousSecret === undefined) delete process.env.AI_PR_REVIEWER_SECRET;
    else process.env.AI_PR_REVIEWER_SECRET = previousSecret;
  });
  const runtime = await prepareReplayRuntime(root, root, temporaryRoot);
  t.after(runtime.cleanup);
  assert.ok(runtime.entry.startsWith(await realpath(temporaryRoot)));
  const replay = (await import(pathToFileURL(runtime.entry).href)) as {
    replayCase: typeof replayCase;
  };
  let calls = 0;
  const runner: ReplayRunner = (_context, files, _conversation, _config, _files, checkout) => {
    calls += 1;
    assert.equal("sharedDiscovery" in _config, false);
    assert.equal(checkout, canonicalRoot);
    assert.deepEqual(
      files.map((file) => file.path),
      ["review.txt"],
    );
    return Promise.resolve({
      goals: [
        {
          prompt: "Review",
          status: "completed",
          inspection: { observedPaths: ["review.txt"], missingPaths: [] },
          submission: { summary: "Complete", findings: [], limitations: [] },
        },
      ],
    });
  };
  const output = await replay.replayCase(input, root, runner);
  assert.equal(calls, 1);
  assert.equal(output.partial, false);
  assert.equal(await status(), "");
  await writeFile(join(root, "ignored.tmp"), "unrelated ignored artifact\n");
  assert.match(await status(), /!! ignored\.tmp/u);
  await assert.rejects(replay.replayCase(input, root, runner), /must be pristine/u);
  assert.equal(calls, 1);
  await rm(join(root, "ignored.tmp"));
  await runtime.cleanup();
  assert.deepEqual(await readdir(temporaryRoot), initialTemporary);

  const casePath = join(temporaryRoot, "case.json");
  await writeFile(casePath, JSON.stringify(input));
  const beforeCli = await readdir(temporaryRoot);
  await assert.rejects(
    execFileAsync(
      "npm",
      [
        "run",
        "replay:review",
        "--",
        "--case",
        casePath,
        "--checkout",
        root,
        "--output",
        join(temporaryRoot, "result.json"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          TMPDIR: temporaryRoot,
          TEMP: temporaryRoot,
          TMP: temporaryRoot,
          AI_PR_REVIEWER_SECRET: "",
          ANTHROPIC_API_KEY: "",
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error && "stderr" in error && typeof error.stderr === "string");
      assert.match(error.stderr, /Set AI_PR_REVIEWER_SECRET or ANTHROPIC_API_KEY/u);
      assert.doesNotMatch(error.stderr, /must be pristine|ERR_MODULE_NOT_FOUND/u);
      return true;
    },
  );
  assert.equal(await status(), "");
  assert.deepEqual(await readdir(temporaryRoot), beforeCli);
  await assert.rejects(prepareReplayRuntime(root, root, root), /must be outside/u);
  const link = join(temporaryRoot, "checkout-link");
  await symlink(root, link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(prepareReplayRuntime(root, root, link), /must be outside/u);
  await writeFile(join(root, "tsconfig.replay.json"), "invalid json");
  const beforeFailure = await readdir(temporaryRoot);
  await assert.rejects(prepareReplayRuntime(root, root, temporaryRoot), /Command failed/u);
  assert.deepEqual(await readdir(temporaryRoot), beforeFailure);
});

test("rejects missing replay checkout arguments before building", async () => {
  for (const args of [[], ["--checkout"], ["--checkout", "--output", "result.json"]])
    await assert.rejects(runReplay(args), /Usage: npm run replay:review/u);
});

test("direct canonical and symlinked replay launchers execute while imports stay inert", async (t) => {
  const directory = await temporaryDirectory("ai-pr-reviewer-entry-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = join(process.cwd(), "scripts/run-replay.ts");
  const alias = join(directory, "replay-link.ts");
  await symlink(entry, alias, "file");
  for (const path of [entry, alias]) {
    await assert.rejects(
      execFileAsync(process.execPath, [path], { encoding: "utf8", timeout: 10_000 }),
      (error: unknown) => {
        assert.ok(
          error instanceof Error && "code" in error && error.code === 1 && "stderr" in error,
        );
        assert.match(String(error.stderr), /Usage: npm run replay:review/u);
        return true;
      },
    );
  }
  for (const args of [[], [join(directory, "nonexistent-entry")], [directory], [entry], [alias]]) {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pathToFileURL(alias).href)}); console.log("imported");`,
        ...args,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(stdout.trim(), "imported");
    assert.doesNotMatch(stderr, /Usage: npm run replay:review/u);
  }
});
