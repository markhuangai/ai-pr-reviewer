import {
  RepositorySnapshot,
  agentInternals,
  assert,
  emptyConversation,
  fakeAgentQuery,
  git,
  join,
  makeDiffFromSnapshots,
  makeRepository,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  repositorySnapshotInternals,
  reviewConfig,
  rm,
  runReviewGoal,
  runReviewGoals,
  symlink,
  test,
  tmpdir,
  type ChangedFile,
  type PreparedContextFile,
  type ReviewConversationSnapshot,
  writeFile,
} from "./agent-test-helpers.js";
import { repositoryGuidanceForRun } from "../src/runtime/repository-snapshot.js";

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
  const unchanged = await snapshot.file("head", "review.txt");
  assert.equal(unchanged.kind, "text");
  assert.ok(unchanged.source);
  assert.equal(await readFile(unchanged.source.path, "utf8"), "base\n");
  await unchanged.source.cleanup();
  const diffSource = await snapshot.diff(["new.txt"]);
  assert.match(await readFile(diffSource.path, "utf8"), /head-only/u);
  await diffSource.cleanup();
  await assert.rejects(
    snapshot.diff(["review.txt"]),
    /Diff selection is not a changed pull-request path/u,
  );
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

test("discovers base and head guidance for changed, renamed, and deleted paths", async (t) => {
  const repository = await makeRepository(
    t,
    async (root) => {
      await mkdir(join(root, "src/nested"), { recursive: true });
      await writeFile(join(root, "AGENTS.md"), "head root guidance\n");
      await writeFile(join(root, "src/AGENTS.md"), "base src guidance\n");
      await writeFile(join(root, "src/nested/AGENTS.md"), "head nested guidance\n");
      await writeFile(join(root, "src/nested/new.ts"), "renamed content\n");
      await rm(join(root, "src/nested/old.ts"));
      await rm(join(root, "gone/AGENTS.md"));
      await rm(join(root, "gone/file.ts"));
      await writeFile(join(root, "linked/file.ts"), "linked content\n");
    },
    async (root) => {
      await mkdir(join(root, "src/nested"), { recursive: true });
      await writeFile(join(root, "AGENTS.md"), "base root guidance\n");
      await writeFile(join(root, "src/AGENTS.md"), "base src guidance\n");
      await writeFile(join(root, "src/nested/AGENTS.md"), "base nested guidance\n");
      await writeFile(join(root, "src/nested/old.ts"), "renamed content\n");
      await mkdir(join(root, "gone"), { recursive: true });
      await writeFile(join(root, "gone/AGENTS.md"), "deleted-path guidance\n");
      await writeFile(join(root, "gone/file.ts"), "deleted content\n");
      await mkdir(join(root, "linked"), { recursive: true });
      await writeFile(join(root, "guidance-target.txt"), "symlink target\n");
      await symlink("../guidance-target.txt", join(root, "linked/AGENTS.md"));
      await writeFile(join(root, "linked/file.ts"), "linked content\n");
    },
  );
  const changed: readonly ChangedFile[] = [
    {
      path: "src/nested/new.ts",
      previousPath: "src/nested/old.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      changes: 2,
      addedLines: new Set([1]),
    },
    {
      path: "gone/file.ts",
      status: "removed",
      additions: 0,
      deletions: 1,
      changes: 1,
      addedLines: new Set(),
    },
    {
      path: "linked/file.ts",
      status: "modified",
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
    changed,
    undefined,
    repository.temporaryRoot,
  );
  t.after(() => snapshot.cleanup());
  const firstGuidance = repositoryGuidanceForRun(snapshot, snapshot, changed);
  assert.equal(repositoryGuidanceForRun(snapshot, snapshot, changed), firstGuidance);
  const guidance = await firstGuidance;
  for (const [path, count] of [
    ["AGENTS.md", 2],
    ["src/AGENTS.md", 2],
    ["src/nested/AGENTS.md", 2],
    ["gone/AGENTS.md", 1],
  ] as const) {
    assert.equal(guidance.filter((entry) => entry.path === path).length, count);
  }
  assert.deepEqual(await snapshot.file("head", "linked/AGENTS.md"), {
    revision: "head",
    path: "linked/AGENTS.md",
    kind: "non_regular",
    sizeBytes: 0,
  });
  assert.ok(
    guidance.some(
      (entry) =>
        entry.path === "AGENTS.md" &&
        entry.revision === "base" &&
        entry.content === "base root guidance\n",
    ),
  );
  assert.ok(
    guidance.some(
      (entry) =>
        entry.path === "AGENTS.md" &&
        entry.revision === "head" &&
        entry.content === "head root guidance\n",
    ),
  );
  assert.ok(
    guidance.some(
      (entry) =>
        entry.path === "src/nested/AGENTS.md" &&
        entry.revision === "base" &&
        entry.content === "base nested guidance\n",
    ),
  );
  assert.ok(
    guidance.some(
      (entry) =>
        entry.path === "src/nested/AGENTS.md" &&
        entry.revision === "head" &&
        entry.content === "head nested guidance\n",
    ),
  );
  assert.ok(guidance.some((entry) => entry.path === "gone/AGENTS.md" && entry.revision === "base"));
  assert.ok(
    !guidance.some((entry) => entry.path === "gone/AGENTS.md" && entry.revision === "head"),
  );
  assert.ok(!guidance.some((entry) => entry.path === "linked/AGENTS.md"));
  const briefingReader = new agentInternals.ReviewBriefingReader(
    repository.context,
    changed,
    emptyConversation,
    { linkedIssues: [], linkedIssueReferencesTruncated: false, repositoryGuidance: guidance },
  );
  const briefingRecords: Readonly<Record<string, unknown>>[] = [];
  while (!briefingReader.complete) {
    briefingRecords.push(...briefingReader.readNext().records);
  }
  assert.ok(
    briefingRecords.some(
      (record) =>
        record.kind === "repository_guidance" &&
        record.path === "AGENTS.md" &&
        record.revision === "head" &&
        record.body === "head root guidance\n",
    ),
  );
});

test("bounds guidance candidates and still finds applicable ancestor files", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await mkdir(join(root, "group-0"), { recursive: true });
    await mkdir(join(root, "group-1"), { recursive: true });
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await mkdir(join(root, "group-0-other"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "root guidance\n");
    await writeFile(join(root, "group-0/AGENTS.md"), "group guidance\n");
    await writeFile(join(root, "group-1/AGENTS.md"), "");
    await writeFile(join(root, "elsewhere/AGENTS.md"), "unrelated guidance\n");
    await writeFile(join(root, "group-0-other/AGENTS.md"), "prefix lookalike guidance\n");
    await writeFile(join(root, "fooAGENTS.md"), "lookalike guidance\n");
  });
  const changed: readonly ChangedFile[] = [
    ...Array.from({ length: 8 }, (_, index) => ({
      path: `group-${index}/${Array.from({ length: 600 }, (_unused, depth) => `d${depth}`).join("/")}/file.ts`,
      status: "added" as const,
      additions: 1,
      deletions: 0,
      changes: 1,
      addedLines: new Set([1]),
    })),
    {
      path: "foobar/nested/file.ts",
      status: "added",
      additions: 1,
      deletions: 0,
      changes: 1,
      addedLines: new Set([1]),
    },
  ];
  assert.equal(repositorySnapshotInternals.guidanceCandidates(changed), undefined);

  const snapshot = new RepositorySnapshot(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.baseSha,
    changed,
    undefined,
    repository.temporaryRoot,
  );
  t.after(() => snapshot.cleanup());
  const guidance = await snapshot.guidance(changed);
  assert.deepEqual(
    guidance.map((entry) => `${entry.path}:${entry.revision}:${entry.content}`),
    [
      "AGENTS.md:head:root guidance\n",
      "group-0/AGENTS.md:head:group guidance\n",
      "group-1/AGENTS.md:head:",
    ],
  );
});

test("treats an empty guidance search as no applicable guidance after candidate overflow", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "review.txt"), "updated review content\n");
  });
  const changed: readonly ChangedFile[] = Array.from({ length: 8 }, (_, index) => ({
    path: `group-${index}/${Array.from({ length: 600 }, (_unused, depth) => `d${depth}`).join("/")}/file.ts`,
    status: "added" as const,
    additions: 1,
    deletions: 0,
    changes: 1,
    addedLines: new Set([1]),
  }));
  assert.equal(repositorySnapshotInternals.guidanceCandidates(changed), undefined);

  const snapshot = new RepositorySnapshot(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.baseSha,
    changed,
    undefined,
    repository.temporaryRoot,
  );
  t.after(() => snapshot.cleanup());

  assert.deepEqual(await snapshot.guidance(changed), []);
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
  const treeEntry = await git(repository.root, [
    "ls-tree",
    "-z",
    repository.headSha,
    "--",
    ":(literal)bounded.txt",
  ]);
  const listingBytes = Buffer.byteLength(treeEntry);
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
    listingBytes + Buffer.byteLength(content) - 1,
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
    byteOffset: 0,
    byteLength: 0,
    sizeBytes: 0,
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
  while (!utf8Reader.complete) {
    const page = await utf8Reader.readNext();
    assert.equal(page.byteLength, Buffer.byteLength(page.content));
    utf8Read += page.content;
  }
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
        isResolved: false,
        isOutdated: false,
        messages: [
          {
            id: 55,
            authorLogin: "reviewer",
            authorRole: "human",
            body: "Previous review context. ".repeat(500),
            createdAt: "2026-08-17T00:00:00Z",
            updatedAt: "2026-08-17T00:00:00Z",
            path: "review.txt",
            line: 1,
          },
        ],
      },
    ],
  };
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
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
        submission: () => ({
          limitations: [],
          summary: "No issues",
          findings: [],
        }),
        readDiffPath: "review.txt",
        readRepositoryFilePath: "review.txt",
        probeThreadErrors: true,
        probeUnknownCursor: true,
        probeDiffCursorBinding: true,
        probeFileCursorBinding: true,
        probeThreadCursorBinding: true,
        readThreadId: 55,
        readThreadPath: "review.txt",
      }),
    );
    assert.equal(result.status, "completed");

    let submissionRejection = "";
    const forged = await runReviewGoal(
      "Reject invented evidence.",
      1,
      repository.context,
      files,
      emptyConversation,
      reviewConfig(),
      diff,
      repository.root,
      fakeAgentQuery({
        submission: {
          summary: "Check invented evidence.",
          findings: [
            {
              title: "Unchecked result",
              severity: "HIGH",
              why: "The caller drops an error.",
              fix: "Handle the error.",
              path: "review.txt",
              line: 1,
              evidenceRefs: ["ev-999"],
              countercheck: "Checked the caller for a guard.",
              counterevidenceRefs: [],
            },
          ],
          limitations: [],
        },
        expectSubmissionRejection: true,
        inspectSubmissionResult: (response) => {
          submissionRejection = response.content[0]?.text ?? "";
        },
      }),
    );
    assert.equal(forged.status, "failed");
    assert.equal(forged.submission, undefined);
    assert.match(submissionRejection, /unknown, incomplete, or non-repository evidence/u);
  } finally {
    await diff.cleanup();
  }
});

test("interleaves full, selected, and fixed-file cursors without mixing their evidence", async (t) => {
  const baseContent = `${Array.from(
    { length: 80 },
    (_, index) => `base-${index}-${"b".repeat(480)}`,
  ).join("\n")}\n`;
  const headContent = `${Array.from(
    { length: 80 },
    (_, index) => `head-${index}-${"h".repeat(480)}`,
  ).join("\n")}\n`;
  const repository = await makeRepository(
    t,
    async (root) => {
      await writeFile(join(root, "large.txt"), headContent);
      await writeFile(join(root, "small.txt"), "small head\n");
    },
    async (root) => {
      await writeFile(join(root, "large.txt"), baseContent);
      await writeFile(join(root, "small.txt"), "small base\n");
    },
  );
  const files: readonly ChangedFile[] = [
    {
      path: "large.txt",
      status: "modified",
      additions: 80,
      deletions: 80,
      changes: 160,
      addedLines: new Set(Array.from({ length: 80 }, (_, index) => index + 1)),
    },
    {
      path: "small.txt",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      addedLines: new Set([1]),
    },
  ];
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.temporaryRoot,
  );
  try {
    const result = await runReviewGoal(
      "Check the changed behavior.",
      0,
      repository.context,
      files,
      emptyConversation,
      reviewConfig(),
      diff,
      repository.root,
      fakeAgentQuery({
        submission: () => ({
          limitations: [],
          summary: "No actionable issues found.",
          findings: [],
        }),
        probeInterleavedQueryCursors: true,
        expectedInterleavedFileContent: headContent,
      }),
    );
    assert.equal(result.status, "completed");
  } finally {
    await diff.cleanup();
  }
});

test("discovers base and head repository guidance for a direct goal without a supplied briefing", async (t) => {
  const repository = await makeRepository(
    t,
    async (root) => {
      await writeFile(join(root, "src/change.ts"), "export const value = 'head';\n");
    },
    async (root) => {
      await mkdir(join(root, "src"), { recursive: true });
      await writeFile(join(root, "AGENTS.md"), "Root repository guidance.\n");
      await writeFile(join(root, "src/AGENTS.md"), "Source directory guidance.\n");
      await writeFile(join(root, "src/change.ts"), "export const value = 'base';\n");
    },
  );
  const files: readonly ChangedFile[] = [
    {
      path: "src/change.ts",
      status: "modified",
      additions: 1,
      deletions: 1,
      changes: 2,
      addedLines: new Set([1]),
    },
  ];
  const diff = await makeDiffFromSnapshots(
    repository.root,
    repository.baseSha,
    repository.headSha,
    repository.temporaryRoot,
  );
  const guidanceRecords: string[] = [];
  try {
    const result = await runReviewGoal(
      "Check the changed behavior.",
      0,
      repository.context,
      files,
      emptyConversation,
      reviewConfig(),
      diff,
      repository.root,
      fakeAgentQuery({
        submission: () => ({
          limitations: [],
          summary: "No actionable issues found.",
          findings: [],
        }),
        inspectBriefingRecords: (records) => {
          for (const record of records) {
            if (record.kind !== "repository_guidance") continue;
            guidanceRecords.push(
              `${String(record.path)}:${String(record.revision)}:${String(record.body)}`,
            );
          }
        },
      }),
    );
    assert.equal(result.status, "completed");
  } finally {
    await diff.cleanup();
  }
  assert.deepEqual(
    new Set(guidanceRecords),
    new Set([
      "AGENTS.md:base:Root repository guidance.\n",
      "AGENTS.md:head:Root repository guidance.\n",
      "src/AGENTS.md:base:Source directory guidance.\n",
      "src/AGENTS.md:head:Source directory guidance.\n",
    ]),
  );
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
