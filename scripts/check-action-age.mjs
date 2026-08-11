import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const quarantineHours = 168;
const cutoff = Date.now() - quarantineHours * 60 * 60 * 1000;
const workflowDirectory = ".github/workflows";
const files = await readdir(workflowDirectory);
const references = new Map();
for (const file of files.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))) {
  const text = await readFile(join(workflowDirectory, file), "utf8");
  for (const match of text.matchAll(/uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)/g)) {
    const repository = match[1];
    const reference = match[2];
    if (!/^[a-f0-9]{40}$/i.test(reference) && !/^v\d+\.\d+\.\d+$/.test(reference))
      throw new Error(
        `${file}: ${repository}@${reference} must use an exact version tag or full commit SHA.`,
      );
    references.set(`${repository}@${reference}`, { repository, reference, file });
  }
}
const failures = [];
for (const { repository, reference, file } of references.values()) {
  const headers = { Accept: "application/vnd.github+json" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/${reference}`, {
    headers,
  });
  if (!response.ok)
    throw new Error(`Could not read ${repository}@${reference} (${response.status}).`);
  const payload = await response.json();
  const date = payload.commit?.committer?.date ?? payload.commit?.author?.date;
  if (typeof date !== "string" || Date.parse(date) > cutoff)
    failures.push(
      `${file}: ${repository}@${reference} is newer than ${quarantineHours} hours (${date ?? "unknown"}).`,
    );
}
console.log(
  `Checked ${references.size} pinned GitHub Actions against a ${quarantineHours}-hour quarantine.`,
);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
}
