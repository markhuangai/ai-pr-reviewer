import { readFile } from "node:fs/promises";

const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
const queries = [];
const seen = new Set();
for (const [key, value] of Object.entries(lock.packages)) {
  if (key === "" || !value?.version || !value?.resolved) continue;
  const keyName = (key.split("/node_modules/").at(-1) ?? "").replace(/^node_modules\//, "");
  const name =
    typeof value.name === "string" && !value.name.startsWith("node_modules/")
      ? value.name
      : keyName;
  const id = `${name}@${value.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  queries.push({ package: { ecosystem: "npm", name }, version: value.version });
}

const response = await fetch("https://api.osv.dev/v1/querybatch", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ queries }),
});
if (!response.ok) throw new Error(`OSV query failed (${response.status}).`);
const payload = await response.json();
const results = Array.isArray(payload.results) ? payload.results : [];
const findings = [];
for (let index = 0; index < results.length; index += 1) {
  const vulnerabilities = Array.isArray(results[index]?.vulns) ? results[index].vulns : [];
  for (const vulnerability of vulnerabilities) {
    const severity = Array.isArray(vulnerability.severity)
      ? vulnerability.severity
          .map((item) => (typeof item?.score === "string" ? item.score : ""))
          .join(" ")
      : "";
    const databaseSeverity =
      typeof vulnerability.database_specific?.severity === "string"
        ? vulnerability.database_specific.severity
        : "unknown";
    findings.push({
      id: vulnerability.id ?? "unknown",
      severity: `${databaseSeverity} ${severity}`.trim(),
      index,
    });
  }
}
if (findings.length === 0) {
  console.log(`OSV found no vulnerabilities in ${queries.length} locked packages.`);
  process.exit(0);
}
for (const finding of findings) console.log(`${finding.id}: ${finding.severity}`);
const blocking = findings.filter((finding) => /critical|high/i.test(finding.severity));
if (blocking.length > 0) {
  console.error(`${blocking.length} High/Critical OSV finding(s) block promotion.`);
  process.exitCode = 1;
} else {
  console.warn(
    "OSV reported only findings without High/Critical severity; review them before promotion.",
  );
}
