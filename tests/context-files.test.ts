import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { promisify } from "node:util";

import { prepareContextFiles } from "../src/lib/context-files.js";
import type { ReviewGoal } from "../src/lib/types.js";

const execFileAsync = promisify(execFile);

async function fixture(t: TestContext): Promise<{
  readonly root: string;
  readonly workspace: string;
  readonly snapshots: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "ai-pr-reviewer-context-test-"));
  const workspace = join(root, "workspace");
  const snapshots = join(root, "snapshots");
  await Promise.all([mkdir(workspace), mkdir(snapshots)]);
  t.after(() => rm(root, { force: true, recursive: true }));
  return { root, workspace, snapshots };
}

function goal(prompt: string, files: readonly string[]): ReviewGoal {
  return { prompt, files };
}

test("captures one private immutable snapshot for shared context files", async (t) => {
  const { root, snapshots, workspace } = await fixture(t);
  const path = join(root, "ticket.json");
  const content = '{"ticket":"PROJ-123","summary":"Unicode 🙂"}\n';
  await writeFile(path, content);

  const artifact = await prepareContextFiles(
    [goal("requirements", [path]), goal("security", [path]), goal("standalone", [])],
    workspace,
    snapshots,
  );
  const first = artifact.filesByGoal[0]?.[0];
  const second = artifact.filesByGoal[1]?.[0];
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(first, second);
  assert.equal(first.path, path);
  assert.equal(first.sizeBytes, Buffer.byteLength(content));
  assert.equal(first.sha256, createHash("sha256").update(content).digest("hex"));
  assert.deepEqual(artifact.identity, [
    [{ path, sizeBytes: Buffer.byteLength(content), sha256: first.sha256 }],
    [{ path, sizeBytes: Buffer.byteLength(content), sha256: first.sha256 }],
    [],
  ]);
  assert.equal(await readFile(first.snapshotPath, "utf8"), content);

  await writeFile(path, "changed after capture\n");
  assert.equal(await readFile(first.snapshotPath, "utf8"), content);
  if (process.platform !== "win32") {
    assert.equal((await stat(first.snapshotPath)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(first.snapshotPath))).mode & 0o777, 0o700);
  }

  await artifact.cleanup();
  await artifact.cleanup();
  await assert.rejects(access(first.snapshotPath));
});

test("accepts an empty UTF-8 context file", async (t) => {
  const { root, snapshots, workspace } = await fixture(t);
  const path = join(root, "empty.txt");
  await writeFile(path, "");
  const artifact = await prepareContextFiles([goal("empty", [path])], workspace, snapshots);
  t.after(() => artifact.cleanup());
  assert.equal(artifact.filesByGoal[0]?.[0]?.sizeBytes, 0);
  assert.equal(await readFile(artifact.filesByGoal[0]?.[0]?.snapshotPath ?? "", "utf8"), "");
});

test("rejects links and non-regular context paths", async (t) => {
  const { root, snapshots, workspace } = await fixture(t);
  const original = join(root, "original.txt");
  const symbolic = join(root, "symbolic.txt");
  const hard = join(root, "hard.txt");
  const directory = join(root, "directory");
  await writeFile(original, "content\n");
  await symlink(original, symbolic);
  await mkdir(directory);

  await assert.rejects(
    prepareContextFiles([goal("symlink", [symbolic])], workspace, snapshots),
    /regular file/u,
  );
  await assert.rejects(
    prepareContextFiles([goal("directory", [directory])], workspace, snapshots),
    /regular file/u,
  );
  await link(original, hard);
  await assert.rejects(
    prepareContextFiles([goal("hard link", [hard])], workspace, snapshots),
    /must not be hard linked/u,
  );
});

test("rejects FIFO context paths", { skip: process.platform === "win32" }, async (t) => {
  const { root, snapshots, workspace } = await fixture(t);
  const fifo = join(root, "context.fifo");
  await execFileAsync("mkfifo", [fifo]);
  await assert.rejects(
    prepareContextFiles([goal("fifo", [fifo])], workspace, snapshots),
    /regular file/u,
  );
});

test("rejects binary content and removes partial snapshots", async (t) => {
  const { root, snapshots, workspace } = await fixture(t);
  const invalidUtf8 = join(root, "invalid.txt");
  await writeFile(invalidUtf8, Buffer.from([0xc3, 0x28]));
  await assert.rejects(
    prepareContextFiles([goal("invalid", [invalidUtf8])], workspace, snapshots),
    /valid UTF-8 text/u,
  );
  assert.deepEqual(await readdir(snapshots), []);

  const nul = join(root, "nul.txt");
  await writeFile(nul, Buffer.from("text\0tail"));
  await assert.rejects(
    prepareContextFiles([goal("nul", [nul])], workspace, snapshots),
    /must not contain NUL bytes/u,
  );
  assert.deepEqual(await readdir(snapshots), []);
});

test("rejects a context file that changes during snapshot capture", async (t) => {
  const { root, snapshots, workspace } = await fixture(t);
  const path = join(root, "changing.txt");
  await writeFile(path, Buffer.alloc(16 * 1024 * 1024, 0x61));
  const source = await open(path, "r+");
  let stop = false;
  let mutations = 0;
  const mutate = async (): Promise<void> => {
    while (!stop) {
      const content = Buffer.from(mutations % 2 === 0 ? "b" : "c");
      await source.write(content, 0, content.length, 0);
      mutations += 1;
      await waitForImmediate();
    }
  };
  const mutation = mutate();

  try {
    await assert.rejects(
      prepareContextFiles([goal("changing", [path])], workspace, snapshots),
      /changed during snapshot capture/u,
    );
  } finally {
    stop = true;
    await mutation;
    await source.close();
  }

  assert.ok(mutations > 1);
  assert.deepEqual(await readdir(snapshots), []);
});

test("enforces per-file and aggregate byte limits before copying", async (t) => {
  const { root, snapshots, workspace } = await fixture(t);
  const oversized = join(root, "oversized.txt");
  await writeFile(oversized, "");
  await truncate(oversized, 100 * 1024 * 1024 + 1);
  await assert.rejects(
    prepareContextFiles([goal("oversized", [oversized])], workspace, snapshots),
    /104857600-byte limit/u,
  );

  const aggregate: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const path = join(root, `large-${index}.txt`);
    await writeFile(path, "");
    await truncate(path, 90 * 1024 * 1024);
    aggregate.push(path);
  }
  await assert.rejects(
    prepareContextFiles([goal("aggregate", aggregate)], workspace, snapshots),
    /524288000-byte total limit/u,
  );
  assert.deepEqual(await readdir(snapshots), []);
});

test("requires snapshot storage outside the checkout", async (t) => {
  const { root, workspace } = await fixture(t);
  const path = join(root, "ticket.txt");
  const snapshots = join(workspace, "snapshots");
  await Promise.all([writeFile(path, "ticket\n"), mkdir(snapshots)]);
  await assert.rejects(
    prepareContextFiles([goal("ticket", [path])], workspace, snapshots),
    /temporary directory must be outside the checkout/u,
  );
});
