import {
  access,
  agentInternals,
  assert,
  chmod,
  delimiter,
  emptyConversation,
  git,
  join,
  makeRepository,
  mkdir,
  mkdtemp,
  readCompleteDiff,
  readFile,
  rm,
  stat,
  streamGitToFile,
  test,
  tmpdir,
  type ChangedFile,
  type ConversationMessage,
  type PullRequestContext,
  type ReviewBriefing,
  type ReviewConversationSnapshot,
  writeFile,
} from "./agent-test-helpers.js";

test("streams a complete diff larger than the former character budget", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    const lines = Array.from({ length: 8_000 }, (_, index) => `changed-${String(index)}-🙂`);
    await writeFile(join(root, "review.txt"), `${lines.join("\n")}\n`);
    await writeFile(join(root, "later.txt"), "final-file-content\n");
  });
  const artifact = await agentInternals.createPullRequestDiff(
    repository.context,
    repository.root,
    repository.temporaryRoot,
  );
  try {
    assert.ok(artifact.size > 30_000);
    const first = artifact.createReader();
    const second = artifact.createReader();
    const [firstResult, secondResult] = await Promise.all([
      readCompleteDiff(first),
      readCompleteDiff(second),
    ]);
    assert.ok(firstResult.pages > 1);
    assert.equal(firstResult.content, secondResult.content);
    assert.match(firstResult.content, /changed-7999-🙂/u);
    assert.match(firstResult.content, /final-file-content/u);
    assert.equal(firstResult.content.includes("�"), false);
  } finally {
    const artifactPath = artifact.path;
    await artifact.cleanup();
    await assert.rejects(access(artifactPath));
  }
});

test("preserves Git stream failures and cleans conflicting outputs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-git-stream-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "output");
  await writeFile(output, "existing");
  await assert.rejects(
    streamGitToFile(root, ["--version"], output, "Git test"),
    /EEXIST|already exists|Git test failed/u,
  );
  await assert.rejects(
    streamGitToFile(join(root, "missing"), ["--version"], join(root, "missing-output"), "Git test"),
    /spawn git ENOENT/u,
  );
  await assert.rejects(
    streamGitToFile(root, ["not-a-command"], join(root, "bad-output"), "Git test"),
    /Git test failed with exit code/u,
  );
  const fakeBin = join(root, "bin");
  await mkdir(fakeBin);
  const fakeGit = join(fakeBin, "git");
  await writeFile(fakeGit, "#!/bin/sh\necho diagnostic >&2\nprintf output\n");
  await chmod(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${delimiter}${previousPath ?? ""}`;
  try {
    const fakeOutput = join(root, "fake-output");
    await streamGitToFile(root, ["whatever"], fakeOutput, "Git test");
    assert.equal(await readFile(fakeOutput, "utf8"), "output");
    const limitedOutput = join(root, "limited-output");
    await assert.rejects(
      streamGitToFile(root, ["whatever"], limitedOutput, "Git test", undefined, 3),
      /configured output byte limit/u,
    );
    assert.ok((await stat(limitedOutput)).size <= 3);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("ignores pull-request diff attributes while omitting binary contents", async (t) => {
  const repository = await makeRepository(
    t,
    async (root) => {
      await writeFile(join(root, ".gitattributes"), "* -diff\n");
      await writeFile(join(root, "review.txt"), "visible source change\n");
      await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 4]));
    },
    async (root) => {
      await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    },
  );
  const artifact = await agentInternals.createPullRequestDiff(
    repository.context,
    repository.root,
    repository.temporaryRoot,
  );
  try {
    const result = await readCompleteDiff(artifact.createReader());
    assert.match(result.content, /^\+\* -diff$/mu);
    assert.match(result.content, /^\+visible source change$/mu);
    assert.match(result.content, /Binary files/u);
    assert.equal(result.content.includes("\u0000"), false);
  } finally {
    await artifact.cleanup();
  }
});

test("returns one completed page for an empty diff", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "review.txt"), "head\n");
  });
  const artifact = await agentInternals.createPullRequestDiff(
    { ...repository.context, baseSha: repository.headSha },
    repository.root,
    repository.temporaryRoot,
  );
  try {
    const result = await readCompleteDiff(artifact.createReader());
    assert.equal(result.pages, 1);
    assert.equal(result.content, "");
  } finally {
    await artifact.cleanup();
  }
});

test("streams empty and multi-page Unicode pull request conversations", () => {
  const emptyReader = new agentInternals.PullRequestConversationReader(emptyConversation);
  assert.deepEqual(emptyReader.readNext(), {
    page: 1,
    content: '{"entries":[]}',
    done: true,
  });
  assert.equal(emptyReader.complete, true);
  assert.deepEqual(emptyReader.readNext(), { page: 1, content: "", done: true });

  const body = `Owner context: ${"🙂".repeat(20_000)}`;
  const reader = new agentInternals.PullRequestConversationReader({
    digest: "conversation-digest",
    entries: [
      {
        kind: "pr_comment",
        id: 1,
        createdAt: "2026-08-17T00:00:00Z",
        message: {
          id: 1,
          authorLogin: "owner",
          authorRole: "human",
          body,
          createdAt: "2026-08-17T00:00:00Z",
          updatedAt: "2026-08-17T00:00:00Z",
        },
      },
    ],
  });
  let content = "";
  let pages = 0;
  while (!reader.complete) {
    const page = reader.readNext();
    pages += 1;
    assert.equal(page.page, pages);
    content += page.content;
  }
  assert.ok(pages > 1);
  assert.equal(content.includes("�"), false);
  const parsed = JSON.parse(content) as { entries: [{ message: { body: string } }] };
  assert.equal(parsed.entries[0].message.body, body);
});

test("pages the review briefing on UTF-8 boundaries and bounds serialized output", () => {
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 42,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    baseRef: "main",
    title: "Unicode briefing",
    body: `PR-${"🙂".repeat(12_000)}-END`,
    htmlUrl: "https://github.com/owner/repository/pull/42",
  };
  const issueBody = `ISSUE-${"界".repeat(8_000)}-END`;
  const briefing: ReviewBriefing = {
    linkedIssueReferencesTruncated: false,
    linkedIssues: [
      {
        number: 7,
        title: "Linked issue",
        state: "open",
        body: issueBody,
        htmlUrl: "https://github.com/owner/repository/issues/7",
      },
    ],
  };
  const briefingConversation: ReviewConversationSnapshot = {
    digest: "briefing-discussion",
    entries: [
      {
        kind: "pr_comment",
        id: 3,
        createdAt: "2026-08-17T00:00:00Z",
        message: {
          id: 3,
          authorLogin: "reviewer",
          authorRole: "human",
          body: `Discussion ${"x".repeat(500)}`,
          createdAt: "2026-08-17T00:00:00Z",
          updatedAt: "2026-08-17T00:00:00Z",
        },
      },
      {
        kind: "inline_thread",
        id: 4,
        reviewId: 10,
        rootAvailable: true,
        createdAt: "2026-08-17T00:01:00Z",
        path: "src/change.ts",
        line: 9,
        isResolved: true,
        isOutdated: true,
        resolvedByLogin: "pr-owner",
        reviewIsMinimized: true,
        reviewMinimizedReason: "RESOLVED",
        messages: Array.from({ length: 33 }, (_, index): ConversationMessage => ({
          id: 4 + index,
          authorLogin: `reviewer-${index}`,
          authorRole: "human",
          body: index === 0 ? `Thread ${"y".repeat(500)}` : `reply-${index}`,
          createdAt: "2026-08-17T00:01:00Z",
          updatedAt: "2026-08-17T00:01:00Z",
          path: "src/change.ts",
          line: 9,
        })),
      },
    ],
  };
  const reader = new agentInternals.ReviewBriefingReader(
    context,
    [
      {
        path: "src/change.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        changes: 3,
        addedLines: new Set([1, 2]),
      },
    ],
    briefingConversation,
    briefing,
  );
  const pages: Array<{ readonly records: readonly Record<string, unknown>[] }> = [];
  while (!reader.complete) {
    const page = reader.readNext();
    pages.push(page);
    const pageBytes = Buffer.byteLength(JSON.stringify(page), "utf8");
    assert.ok(pageBytes <= agentInternals.BRIEFING_PAGE_BYTES, `${pageBytes} bytes`);
    const toolResult = agentInternals.jsonToolResult(page);
    const toolBytes = Buffer.byteLength(JSON.stringify(toolResult), "utf8");
    assert.ok(toolBytes <= agentInternals.MODEL_TOOL_RESULT_BYTES, `${toolBytes} bytes`);
  }
  assert.ok(pages.length > 1);
  const pullRequestParts = pages
    .flatMap((page) => page.records)
    .filter((record) => record.kind === "pull_request")
    .sort((left, right) => Number(left.bodyPart ?? 0) - Number(right.bodyPart ?? 0));
  assert.equal(pullRequestParts.map((record) => record.body).join(""), context.body);
  const issueParts = pages
    .flatMap((page) => page.records)
    .filter((record) => record.kind === "linked_issue")
    .sort((left, right) => Number(left.bodyPart ?? 0) - Number(right.bodyPart ?? 0));
  assert.equal(issueParts.map((record) => record.body).join(""), issueBody);
  const discussion = pages
    .flatMap((page) => page.records)
    .find((record) => record.kind === "discussion_index" && record.id === 4);
  assert.ok(discussion);
  assert.equal(discussion.reviewId, 10);
  assert.equal(discussion.isResolved, true);
  assert.equal(discussion.isOutdated, true);
  assert.equal(discussion.resolvedByLogin, "pr-owner");
  assert.equal(discussion.reviewIsMinimized, true);
  assert.equal(discussion.reviewMinimizedReason, "RESOLVED");
  assert.equal(
    pages.flatMap((page) => page.records).some((record) => JSON.stringify(record).includes("�")),
    false,
  );
  assert.deepEqual(reader.readNext(), { page: pages.length, records: [], done: true });

  const contextWithoutBody = { ...context };
  delete contextWithoutBody.body;
  const missingBodyReader = new agentInternals.ReviewBriefingReader(
    contextWithoutBody,
    [],
    emptyConversation,
    { linkedIssues: [], linkedIssueReferencesTruncated: false },
  );
  assert.equal(missingBodyReader.readNext().records[0]?.body, "");

  const quotedReader = new agentInternals.ReviewBriefingReader(
    { ...context, body: `QUOTE-${'"\\'.repeat(5_000)}-END` },
    [],
    emptyConversation,
    { linkedIssues: [], linkedIssueReferencesTruncated: false },
  );
  while (!quotedReader.complete) {
    const page = quotedReader.readNext();
    assert.ok(
      Buffer.byteLength(JSON.stringify(agentInternals.jsonToolResult(page)), "utf8") <=
        agentInternals.MODEL_TOOL_RESULT_BYTES,
    );
  }

  const controlReader = new agentInternals.ReviewBriefingReader(
    { ...context, body: String.fromCharCode(1).repeat(5_000) },
    [],
    emptyConversation,
    { linkedIssues: [], linkedIssueReferencesTruncated: false },
  );
  while (!controlReader.complete) {
    const page = controlReader.readNext();
    assert.equal(agentInternals.jsonToolResult(page).isError, undefined);
  }
});

test("bounds aggregate briefing records with an explicit truncation marker", () => {
  const context: PullRequestContext = {
    repository: "owner/repository",
    owner: "owner",
    name: "repository",
    number: 43,
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    baseRef: "main",
    title: "Large briefing",
    htmlUrl: "https://github.com/owner/repository/pull/43",
  };
  const files: readonly ChangedFile[] = Array.from({ length: 5_000 }, (_, index) => ({
    path: `src/file-${index}.ts`,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    addedLines: new Set([1]),
  }));
  const reader = new agentInternals.ReviewBriefingReader(context, files, emptyConversation, {
    linkedIssues: [],
    linkedIssueReferencesTruncated: false,
  });
  const records: Record<string, unknown>[] = [];
  while (!reader.complete) records.push(...reader.readNext().records);
  const marker = records.find((record) => record.kind === "briefing_truncated");
  assert.ok(marker);
  assert.ok(Number(marker.omittedRecords) > 0);
  assert.ok(records.filter((record) => record.kind === "changed_file").length < files.length);
});

test("splits UTF-8 strings without replacement characters", () => {
  const value = "a🙂界".repeat(2_000);
  const parts = agentInternals.splitUtf8(value, 17);
  assert.equal(parts.join(""), value);
  assert.equal(
    parts.some((part) => part.includes("�")),
    false,
  );
  assert.ok(parts.every((part) => Buffer.byteLength(part, "utf8") <= 17));
  assert.deepEqual(agentInternals.splitUtf8("", 4), [""]);
  assert.throws(() => agentInternals.splitUtf8("text", 3), /complete code point/u);
  assert.equal(agentInternals.jsonToolResult({ text: "x".repeat(30_000) }).isError, true);
});

test("pages arbitrary repository query text on UTF-8 boundaries", () => {
  const reader = new agentInternals.StringPageReader("query-🙂界".repeat(5_000), 19);
  let content = "";
  let pages = 0;
  while (!reader.complete) {
    const page = reader.readNext();
    pages += 1;
    content += page.content;
    assert.equal(page.page, pages);
  }
  assert.ok(pages > 1);
  assert.equal(content, "query-🙂界".repeat(5_000));
  assert.equal(content.includes("�"), false);
  assert.deepEqual(reader.readNext(), { page: pages, content: "", done: true });
  const tiny = new agentInternals.StringPageReader("🙂", 1);
  assert.deepEqual(tiny.readNext(), { page: 1, content: "🙂", done: true });
  const empty = new agentInternals.StringPageReader("");
  assert.deepEqual(empty.readNext(), { page: 1, content: "", done: true });
});

test("bounds each repository query page by its serialized envelope", () => {
  const value = `${"ordinary\n".repeat(7_000)}${String.fromCharCode(1).repeat(8_000)}${"tail\n".repeat(3_000)}`;
  const reader = new agentInternals.StringPageReader(value, 12 * 1024);
  let content = "";
  while (!reader.complete) {
    const page = reader.readNext({
      metadata: "query metadata",
      nextCursor: "cursor",
    });
    content += page.content;
    const result = agentInternals.jsonToolResult({
      ...page,
      metadata: "query metadata",
      ...(page.done ? {} : { nextCursor: "cursor" }),
    });
    assert.equal(result.isError, undefined);
  }
  assert.equal(content, value);
});

test("includes deletions and renames in the fenced Git diff", async (t) => {
  const repository = await makeRepository(
    t,
    async (root) => {
      await rm(join(root, "removed.txt"));
      await git(root, ["mv", "old-name.txt", "new-name.txt"]);
    },
    async (root) => {
      await writeFile(join(root, "removed.txt"), "removed content\n");
      await writeFile(join(root, "old-name.txt"), "renamed content\n");
    },
  );
  const artifact = await agentInternals.createPullRequestDiff(
    repository.context,
    repository.root,
    repository.temporaryRoot,
  );
  try {
    const result = await readCompleteDiff(artifact.createReader());
    assert.match(result.content, /deleted file mode/u);
    assert.match(result.content, /rename from old-name\.txt/u);
    assert.match(result.content, /rename to new-name\.txt/u);
  } finally {
    await artifact.cleanup();
  }
});

test("rejects non-full and unavailable commit SHAs", async (t) => {
  const repository = await makeRepository(t, async (root) => {
    await writeFile(join(root, "review.txt"), "head\n");
  });
  await assert.rejects(
    agentInternals.createPullRequestDiff(
      { ...repository.context, baseSha: repository.baseSha.slice(0, 12) },
      repository.root,
      repository.temporaryRoot,
    ),
    /not a full Git commit SHA/u,
  );
  await assert.rejects(
    agentInternals.createPullRequestDiff(
      { ...repository.context, headSha: "f".repeat(40) },
      repository.root,
      repository.temporaryRoot,
    ),
    /not available as a commit/u,
  );
});

test("changed-file prompt contains metadata without REST patches", () => {
  const files: readonly ChangedFile[] = [
    {
      path: "src/new.ts",
      previousPath: "src/old.ts",
      status: "renamed",
      additions: 1,
      deletions: 1,
      changes: 2,
      patch: "secret patch text",
      addedLines: new Set([1]),
    },
  ];
  const prompt = agentInternals.changedFilePrompt(files);
  assert.match(prompt, /path="src\/new\.ts"/u);
  assert.match(prompt, /previousPath="src\/old\.ts"/u);
  assert.equal(prompt.includes("secret patch text"), false);
});
