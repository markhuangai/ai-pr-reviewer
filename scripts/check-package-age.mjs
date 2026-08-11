import { readFile } from "node:fs/promises";

const quarantineHours = 168;
const cutoff = Date.now() - quarantineHours * 60 * 60 * 1000;
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const entries = Object.entries(lock.packages).filter(
  ([key, value]) => key !== "" && value?.version && value?.resolved,
);
const seen = new Set();
const failures = [];

for (const [key, value] of entries) {
  const keyName = (key.split("/node_modules/").at(-1) ?? "").replace(/^node_modules\//, "");
  const name =
    typeof value.name === "string" && !value.name.startsWith("node_modules/")
      ? value.name
      : keyName;
  if (typeof value.integrity !== "string" || value.integrity.length === 0) {
    failures.push(`${name}@${value.version}: lockfile entry has no integrity hash`);
    continue;
  }
  const id = `${name}@${value.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const encoded = name.startsWith("@") ? name.replaceAll("/", "%2F") : name;
  const response = await fetch(`https://registry.npmjs.org/${encoded}`);
  if (!response.ok) throw new Error(`Could not read npm metadata for ${id} (${response.status}).`);
  const metadata = await response.json();
  const published = metadata.time?.[value.version];
  if (typeof published !== "string") {
    failures.push(`${id}: registry did not provide a publish timestamp`);
    continue;
  }
  const publishedAt = Date.parse(published);
  if (!Number.isFinite(publishedAt) || publishedAt > cutoff)
    failures.push(`${id}: published ${published}`);
}

console.log(
  `Checked ${seen.size} locked npm packages against a ${quarantineHours}-hour quarantine.`,
);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("No locked package is inside the quarantine window.");
}
