import { readFile } from "node:fs/promises";

import { severityLabel } from "./osv-score.mjs";

const OSV_BATCH_SIZE = 1_000;
const OSV_TIMEOUT_MS = 30_000;

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const queries = [];
const seenPackages = new Set();
for (const [key, value] of Object.entries(lock.packages)) {
  if (key === "" || !value?.version || !value?.resolved) continue;
  const keyName = (key.split("/node_modules/").at(-1) ?? "").replace(/^node_modules\//, "");
  const name =
    typeof value.name === "string" && !value.name.startsWith("node_modules/")
      ? value.name
      : keyName;
  const id = `${name}@${value.version}`;
  if (seenPackages.has(id)) continue;
  seenPackages.add(id);
  queries.push({ name, version: value.version });
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(OSV_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OSV request failed (${response.status}) for ${url}.`);
  return response.json();
}

const vulnerabilityFindings = [];
for (let start = 0; start < queries.length; start += OSV_BATCH_SIZE) {
  const batch = queries.slice(start, start + OSV_BATCH_SIZE);
  const payload = await fetchJson("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      queries: batch.map((query) => ({
        package: { ecosystem: "npm", name: query.name },
        version: query.version,
      })),
    }),
  });
  if (!Array.isArray(payload.results))
    throw new Error("OSV query returned an invalid results list.");
  if (payload.results.length !== batch.length)
    throw new Error("OSV query returned an incomplete results list.");
  for (let index = 0; index < payload.results.length; index += 1) {
    const vulnerabilities = Array.isArray(payload.results[index]?.vulns)
      ? payload.results[index].vulns
      : [];
    const query = batch[index];
    if (!query) throw new Error("OSV query returned an unexpected result index.");
    for (const minimal of vulnerabilities) {
      if (typeof minimal?.id !== "string" || minimal.id.length === 0) {
        throw new Error(
          `OSV returned a vulnerability without an identifier for ${query.name}@${query.version}.`,
        );
      }
      const vulnerability = await fetchJson(
        `https://api.osv.dev/v1/vulns/${encodeURIComponent(minimal.id)}`,
      );
      if (typeof vulnerability !== "object" || vulnerability === null) {
        throw new Error(`OSV returned an invalid record for ${minimal.id}.`);
      }
      if (vulnerability.withdrawn !== undefined) continue;
      vulnerabilityFindings.push({
        id: minimal.id,
        package: query.name,
        version: query.version,
        severity: severityLabel(vulnerability),
      });
    }
  }
}

if (vulnerabilityFindings.length === 0) {
  console.log(`OSV found no vulnerabilities in ${queries.length} locked packages.`);
  process.exit(0);
}

for (const finding of vulnerabilityFindings) {
  console.log(`${finding.package}@${finding.version}: ${finding.id}: ${finding.severity}`);
}

const blocking = vulnerabilityFindings.filter(
  (finding) => finding.severity === "UNKNOWN" || /CRITICAL|HIGH/.test(finding.severity),
);
if (blocking.length > 0) {
  console.error(
    `${blocking.length} High/Critical/unknown-severity OSV finding(s) block promotion.`,
  );
  process.exitCode = 1;
} else {
  console.warn("OSV reported only Medium/Low findings; review them before promotion.");
}
