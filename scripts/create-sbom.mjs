import { mkdir, readFile, writeFile } from "node:fs/promises";

function npmPurlName(name) {
  if (!name.startsWith("@")) return encodeURIComponent(name);
  const separator = name.indexOf("/");
  if (separator < 2) return encodeURIComponent(name);
  return `${encodeURIComponent(name.slice(0, separator))}/${encodeURIComponent(name.slice(separator + 1))}`;
}

function integrityHash(integrity) {
  const match = /^sha512-(.+)$/.exec(integrity);
  if (!match?.[1]) return undefined;
  return Buffer.from(match[1], "base64").toString("hex");
}

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const components = [];
for (const [key, value] of Object.entries(lock.packages)) {
  if (key === "" || !value?.version || !value?.resolved) continue;
  const keyName = (key.split("/node_modules/").at(-1) ?? "").replace(/^node_modules\//, "");
  const name =
    typeof value.name === "string" && !value.name.startsWith("node_modules/")
      ? value.name
      : keyName;
  const integrity =
    typeof value.integrity === "string" ? integrityHash(value.integrity) : undefined;
  components.push({
    type: "library",
    name,
    version: value.version,
    purl: `pkg:npm/${npmPurlName(name)}@${encodeURIComponent(value.version)}`,
    hashes: integrity === undefined ? [] : [{ alg: "SHA-512", content: integrity }],
  });
}
components.sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
);
const sbom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000001",
  version: 1,
  metadata: { component: { type: "application", name: "ai-pr-reviewer", version: "0.1.0" } },
  components,
};
await mkdir("build", { recursive: true });
await writeFile("build/sbom.cdx.json", `${JSON.stringify(sbom, null, 2)}\n`);
console.log(`Wrote CycloneDX SBOM with ${components.length} components.`);
