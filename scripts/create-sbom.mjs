import { mkdir, readFile, writeFile } from "node:fs/promises";

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const components = [];
for (const [key, value] of Object.entries(lock.packages)) {
  if (key === "" || !value?.version || !value?.resolved) continue;
  const keyName = (key.split("/node_modules/").at(-1) ?? "").replace(/^node_modules\//, "");
  const name =
    typeof value.name === "string" && !value.name.startsWith("node_modules/")
      ? value.name
      : keyName;
  components.push({
    type: "library",
    name,
    version: value.version,
    purl: `pkg:npm/${name.startsWith("@") ? name.replace("/", "%2f") : name}@${value.version}`,
    hashes: value.integrity
      ? [{ alg: "SHA-512", content: value.integrity.replace(/^sha512-/, "") }]
      : [],
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
