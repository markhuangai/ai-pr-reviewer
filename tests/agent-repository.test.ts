import {
  RepositorySnapshot,
  agentInternals,
  assert,
  emptyConversation,
  fakeAgentQuery,
  join,
  makeRepository,
  mkdtemp,
  readFile,
  readdir,
  repositorySnapshotInternals,
  reviewConfig,
  rm,
  runReviewGoal,
  runReviewGoals,
  test,
  tmpdir,
  type ChangedFile,
  type PreparedContextFile,
  type ReviewConfig,
  type ReviewConversationSnapshot,
  writeFile,
} from "./agent-test-helpers.js";

test("serializes repeated diff reads and rejects reads after close or premature EOF", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-reader-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "diff");
  await writeFile(path, "abc");
  const reader = new agentInternals.PullRequestDiffReader(path, 3);
  const [first, second] = await Promise.all([reader.readNext(), reader.readNext()]);
  assert.equal(first.content, "abc");
  assert.deepEqual(second, { page: 1, content: "", done: true });
  await reader.close();
  await reader.close();
  await assert.rejects(reader.readNext(), /closed pull request diff/u);

  const oversized = new agentInternals.PullRequestDiffReader(path, 4);
  assert.equal((await oversized.readNext()).done, false);
  await assert.rejects(oversized.readNext(), /ended before its recorded size/u);
  await oversized.close();
});

test("bounds serialized full-diff pages before advancing the reader", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-diff-page-limit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "diff");
  const content = `${String.fromCharCode(1).repeat(9_000)}🙂${"界".repeat(200)}`;
  await writeFile(path, content);
  const reader = new agentInternals.PullRequestDiffReader(path, Buffer.byteLength(content));
  let actual = "";
  const extra = { mergeBaseSha: "a".repeat(40), headSha: "b".repeat(40) };
  try {
    while (!reader.complete) {
      const page = await reader.readNext(extra);
      actual += page.content;
      const result = agentInternals.jsonToolResult({ ...page, ...extra });
      assert.equal(result.isError, undefined);
    }
  } finally {
    await reader.close();
  }
  assert.equal(actual, content);
});

test("rejects an oversized empty full-diff page without advancing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-empty-diff-page-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "diff");
  await writeFile(path, "");
  const reader = new agentInternals.PullRequestDiffReader(path, 0);
  await assert.rejects(reader.readNext({ metadata: "x".repeat(30_000) }), /bounded result size/u);
  await reader.close();
});

test("reads fixed changed paths at the merge base and head, including binary metadata", async (t) => {
  const repository = await makeRepository(
    t,
    async (root) => {
      await writeFile(join(root, "new.txt"), "head-only\n");
      await writeFile(join(root, "binary.bin"), Buffer.from([0xff, 0x00, 0x01, 0xfe]));
      await writeFile(join(root, "nul.bin"), Buffer.from("a\u0000b", "utf8"));
    },
    async (root) => {
      await writeFile(join(root, "binary.bin"), Buffer.from([0xff, 0x00, 0x01, 0xfd]));
    },
  );
  const files: readonly ChangedFile[] = [
    {
      path: "new.txt",
      status: "added",
      additions: 1,
      deletions: 0,
      changes: 1,
      addedLines: new Set([1]),
    },
    {
      path: "binary.bin",
      status: "modified",
      additions: 0,
      deletions: 0,
      changes: 0,
      addedLines: new Set(),
    },
    {
      path: "nul.bin",
      status: "added",
      additions: 0,
      deletions: 0,
      changes: 0,
      addedLines: new Set(),
    },
  ];
  const snapshot = new RepositorySnapshot(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.baseSha,
    files,
  );
  const headNew = await snapshot.file("head", "new.txt");
  assert.deepEqual(
    { ...headNew, source: undefined },
    {
      revision: "head",
      path: "new.txt",
      kind: "text",
      sizeBytes: 10,
      source: undefined,
    },
  );
  assert.ok(headNew.source);
  assert.equal(await readFile(headNew.source.path, "utf8"), "head-only\n");
  await headNew.source.cleanup();
  assert.deepEqual(await snapshot.file("base", "new.txt"), {
    revision: "base",
    path: "new.txt",
    kind: "missing",
    sizeBytes: 0,
  });
  assert.deepEqual(await snapshot.file("head", "binary.bin"), {
    revision: "head",
    path: "binary.bin",
    kind: "binary",
    sizeBytes: 4,
  });
  assert.deepEqual(await snapshot.file("head", "nul.bin"), {
    revision: "head",
    path: "nul.bin",
    kind: "binary",
    sizeBytes: 3,
  });
  const diffSource = await snapshot.diff(["new.txt"]);
  assert.match(await readFile(diffSource.path, "utf8"), /head-only/u);
  await diffSource.cleanup();
  await assert.rejects(snapshot.file("head", "review.txt"), /not a changed pull-request path/u);
  await assert.rejects(snapshot.file("head", "../new.txt"), /outside the fixed checkout/u);
  await assert.rejects(snapshot.file("head", ".git/config"), /outside the fixed checkout/u);
  const unavailable = new RepositorySnapshot(
    join(repository.root, "missing-checkout"),
    repository.baseSha,
    repository.headSha,
    repository.baseSha,
    files,
  );
  await assert.rejects(unavailable.file("head", "new.txt"), /Git snapshot query failed/u);
});

test("spools repository files beyond the former Git output cap", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "large.txt"), Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
  });
  const files: readonly ChangedFile[] = [
    {
      path: "large.txt",
      status: "added",
      additions: 1,
      deletions: 0,
      changes: 1,
      addedLines: new Set([1]),
    },
  ];
  const snapshot = new RepositorySnapshot(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.baseSha,
    files,
  );
  t.after(() => snapshot.cleanup());
  const result = await snapshot.file("head", "large.txt");
  assert.equal(result.kind, "text");
  assert.equal(result.sizeBytes, 16 * 1024 * 1024 + 1);
  assert.ok(result.source);
  await result.source.cleanup();
  const diffSource = await snapshot.diff(["large.txt"]);
  assert.ok(diffSource.sizeBytes > 16 * 1024 * 1024);
  await diffSource.cleanup();
});

test("bounds aggregate repository query storage until sources are cleaned", async (t) => {
  const content = "bounded repository query\n";
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "bounded.txt"), content);
  });
  const files: readonly ChangedFile[] = [
    {
      path: "bounded.txt",
      status: "added",
      additions: 1,
      deletions: 0,
      changes: 1,
      addedLines: new Set([1]),
    },
  ];
  const snapshot = new RepositorySnapshot(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.baseSha,
    files,
    undefined,
    repository.temporaryRoot,
    Buffer.byteLength(content),
  );
  t.after(() => snapshot.cleanup());

  const first = await snapshot.file("head", "bounded.txt");
  assert.ok(first.source);
  await assert.rejects(snapshot.file("head", "bounded.txt"), /configured output byte limit/iu);
  await first.source.cleanup();

  const retry = await snapshot.file("head", "bounded.txt");
  assert.ok(retry.source);
  await retry.source.cleanup();
  assert.deepEqual(await readdir(repository.temporaryRoot), []);
});

test("treats targeted repository diff paths as literal pathspecs", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "foo*.ts"), "literal wildcard file\n");
    await writeFile(join(root, "foo1.ts"), "glob match file\n");
  });
  const snapshot = new RepositorySnapshot(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.baseSha,
    [
      {
        path: "foo*.ts",
        status: "added",
        additions: 1,
        deletions: 0,
        changes: 1,
        addedLines: new Set([1]),
      },
    ],
  );
  t.after(() => snapshot.cleanup());
  const source = await snapshot.diff(["foo*.ts"]);
  const diff = await readFile(source.path, "utf8");
  await source.cleanup();
  assert.match(diff, /foo\*\.ts/u);
  assert.doesNotMatch(diff, /foo1\.ts/u);
});

test("pages spooled repository sources and rejects in-checkout query roots", async (t) => {
  assert.equal(repositorySnapshotInternals.isWithin("/tmp/root", "/tmp/root"), true);
  assert.equal(repositorySnapshotInternals.isWithin("/tmp/root", "/tmp/root/child"), true);
  assert.equal(repositorySnapshotInternals.isWithin("/tmp/root", "/tmp/root/.."), false);
  assert.equal(repositorySnapshotInternals.isWithin("/tmp/root", "/tmp/other"), false);
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "empty.txt"), "");
    await writeFile(join(root, "controls.txt"), String.fromCharCode(1).repeat(8_000));
  });
  const files: readonly ChangedFile[] = [
    {
      path: "empty.txt",
      status: "added",
      additions: 0,
      deletions: 0,
      changes: 0,
      addedLines: new Set(),
    },
    {
      path: "controls.txt",
      status: "added",
      additions: 1,
      deletions: 0,
      changes: 1,
      addedLines: new Set([1]),
    },
  ];
  const snapshot = new RepositorySnapshot(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.baseSha,
    files,
  );
  t.after(() => snapshot.cleanup());
  const empty = await snapshot.file("head", "empty.txt");
  assert.equal(empty.kind, "text");
  assert.ok(empty.source);
  const emptyReader = new agentInternals.RepositoryFilePageReader(
    empty.source.path,
    empty.source.sizeBytes,
  );
  assert.deepEqual(await emptyReader.readNext({ metadata: "empty" }), {
    page: 1,
    content: "",
    done: true,
  });
  await emptyReader.close();
  await emptyReader.close();
  const oversizedEmptyReader = new agentInternals.RepositoryFilePageReader(
    empty.source.path,
    empty.source.sizeBytes,
  );
  await assert.rejects(
    oversizedEmptyReader.readNext({ metadata: "x".repeat(30_000) }),
    /bounded result size/u,
  );
  await oversizedEmptyReader.close();
  await empty.source.cleanup();

  const controls = await snapshot.file("head", "controls.txt");
  assert.ok(controls.source);
  const controlReader = new agentInternals.RepositoryFilePageReader(
    controls.source.path,
    controls.source.sizeBytes,
  );
  let content = "";
  while (!controlReader.complete) {
    const page = await controlReader.readNext({ metadata: "controls", nextCursor: "cursor" });
    content += page.content;
    assert.equal(
      agentInternals.jsonToolResult({
        ...page,
        metadata: "controls",
        ...(page.done ? {} : { nextCursor: "cursor" }),
      }).isError,
      undefined,
    );
  }
  assert.equal(content, String.fromCharCode(1).repeat(8_000));
  await controlReader.close();
  const truncatedReader = new agentInternals.RepositoryFilePageReader(
    controls.source.path,
    controls.source.sizeBytes + 1,
  );
  await assert.rejects(
    (async () => {
      for (let attempt = 0; attempt < 20; attempt += 1) await truncatedReader.readNext();
    })(),
    /ended before its recorded size/u,
  );
  await truncatedReader.close();
  await controls.source.cleanup();
  await controls.source.cleanup();

  const utf8Path = join(repository.root, "utf8-query");
  const utf8Content = `${"a".repeat(12_287)}🙂tail`;
  await writeFile(utf8Path, utf8Content);
  const utf8Reader = new agentInternals.RepositoryFilePageReader(
    utf8Path,
    Buffer.byteLength(utf8Content, "utf8"),
  );
  let utf8Read = "";
  while (!utf8Reader.complete) utf8Read += (await utf8Reader.readNext()).content;
  assert.equal(utf8Read, utf8Content);
  assert.equal((await utf8Reader.readNext()).done, true);
  await utf8Reader.close();
  await assert.rejects(utf8Reader.readNext(), /closed repository query/u);

  const impossiblePath = join(repository.root, "impossible-query");
  await writeFile(impossiblePath, "a");
  const impossibleReader = new agentInternals.RepositoryFilePageReader(impossiblePath, 1);
  await assert.rejects(
    impossibleReader.readNext({ metadata: "x".repeat(30_000) }),
    /bounded result size/u,
  );
  await impossibleReader.close();

  const signaledController = new AbortController();
  const signaled = new RepositorySnapshot(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.baseSha,
    files,
    signaledController.signal,
  );
  const signaledFile = await signaled.file("head", "empty.txt");
  assert.ok(signaledFile.source);
  await signaledFile.source.cleanup();
  signaledController.abort();
  await assert.rejects(signaled.file("head", "empty.txt"));
  await signaled.cleanup();

  const inside = new RepositorySnapshot(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.baseSha,
    files,
    undefined,
    repository.root,
  );
  await assert.rejects(inside.diff(["empty.txt"]), /temporary directory must be outside/u);

  const invalid = new RepositorySnapshot(
    repository.root,
    repository.baseSha,
    "f".repeat(40),
    repository.baseSha,
    files,
  );
  await assert.rejects(invalid.diff(["empty.txt"]), /Git snapshot query failed with exit code/u);
});

test("exercises on-demand fixed diff/file readers and cursor validation", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(
      join(root, "review.txt"),
      `${Array.from({ length: 4_000 }, (_, index) => `head-${index}-🙂`).join("\n")}\n`,
    );
  });
  const files: readonly ChangedFile[] = [
    {
      path: "review.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      addedLines: new Set([1]),
    },
  ];
  const conversationWithThread: ReviewConversationSnapshot = {
    digest: "selected-thread",
    entries: [
      {
        kind: "inline_thread",
        id: 55,
        rootAvailable: true,
        createdAt: "2026-08-17T00:00:00Z",
        path: "review.txt",
        line: 1,
        messages: [
          {
            id: 55,
            authorLogin: "reviewer",
            authorRole: "human",
            body: "Previous review context.",
            createdAt: "2026-08-17T00:00:00Z",
            updatedAt: "2026-08-17T00:00:00Z",
            path: "review.txt",
            line: 1,
          },
        ],
      },
    ],
  };
  const diff = await agentInternals.createPullRequestDiff(
    repository.context,
    repository.root,
    repository.temporaryRoot,
  );
  try {
    const result = await runReviewGoal(
      "Read selected fixed evidence.",
      0,
      repository.context,
      files,
      conversationWithThread,
      reviewConfig(),
      diff,
      repository.root,
      fakeAgentQuery({
        submission: { summary: "No issues", findings: [] },
        readDiffPath: "review.txt",
        readRepositoryFilePath: "review.txt",
        probeThreadErrors: true,
        probeUnknownCursor: true,
      }),
    );
    assert.equal(result.status, "completed");
  } finally {
    await diff.cleanup();
  }
});

test("handles sparse goal arrays without leaking the shared diff", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "review.txt"), "head change\n");
  });
  const prompts = new Array<ReviewConfig["reviewPrompts"][number]>(1);
  const results = await runReviewGoals(
    repository.context,
    [],
    emptyConversation,
    reviewConfig({ reviewPrompts: prompts }),
    [[]],
    repository.root,
    fakeAgentQuery({ submission: { summary: "unused", findings: [] } }),
  );
  assert.deepEqual(results, [
    { prompt: "", status: "failed", error: "Worker did not return a result." },
  ]);
  assert.deepEqual(await readdir(repository.temporaryRoot), []);
});

test("rejects prepared context arrays that do not match review goals", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "review.txt"), "head change\n");
  });
  await assert.rejects(
    runReviewGoals(
      repository.context,
      [],
      emptyConversation,
      reviewConfig(),
      [],
      repository.root,
      fakeAgentQuery({}),
    ),
    /Prepared context files must match/u,
  );
  await assert.rejects(
    runReviewGoals(
      repository.context,
      [],
      emptyConversation,
      reviewConfig(),
      [[{} as PreparedContextFile]],
      repository.root,
      fakeAgentQuery({}),
    ),
    /Prepared context files do not match review goal/u,
  );
});

test("rejects additional unsafe glob and hook input shapes", async (t) => {
  assert.equal(agentInternals.isSafeGlobPattern("!src/**/*.ts"), true);
  assert.equal(agentInternals.isSafeGlobPattern("src/{a,{b,c}}"), false);
  assert.equal(agentInternals.isSafeGlobPattern("src/}bad{"), false);
  assert.equal(agentInternals.isSafeGlobPattern("src/{C:\\bad,ok}"), false);
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-hook-shapes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hook = agentInternals.repositoryReadHook as unknown as (
    input: Record<string, unknown>,
  ) => Promise<{ readonly hookSpecificOutput?: { readonly permissionDecision?: string } }>;
  const deny = async (tool_name: string, tool_input: unknown) =>
    (await hook({ hook_event_name: "PreToolUse", tool_name, tool_input, cwd: root }))
      .hookSpecificOutput?.permissionDecision;
  assert.equal(await deny("Read", { file_path: 1 }), "deny");
  assert.equal(await deny("Glob", { path: ".", pattern: 1 }), "deny");
  assert.equal(await deny("Grep", { path: ".", glob: ".git/**" }), "deny");
  assert.equal(await deny("Glob", { path: ".", pattern: "missing/*.ts" }), undefined);
});
