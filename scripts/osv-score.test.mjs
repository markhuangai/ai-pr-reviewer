import { strict as assert } from "node:assert";
import test from "node:test";

import { parseCvssBaseScore, severityLabel } from "./osv-score.mjs";

test("parses CVSS v3 vectors before applying severity thresholds", () => {
  const vector = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H";
  assert.equal(parseCvssBaseScore(vector), 9.8);
  assert.equal(severityLabel({ severity: [{ score: vector }] }), "CRITICAL");
});

test("keeps malformed or unsupported CVSS values fail-closed", () => {
  assert.equal(parseCvssBaseScore("CVSS:4.0/AV:N"), undefined);
  assert.equal(parseCvssBaseScore("-1"), undefined);
  assert.equal(parseCvssBaseScore("11"), undefined);
  assert.equal(parseCvssBaseScore("   "), undefined);
  assert.equal(severityLabel({ severity: [{ score: "not-a-score" }] }), "UNKNOWN");
  assert.equal(severityLabel({ severity: [{ score: "-1" }] }), "UNKNOWN");
});

test("retains the strongest severity across OSV sources", () => {
  const criticalVector = "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H";
  assert.equal(
    severityLabel({
      database_specific: { severity: "MEDIUM" },
      severity: [{ score: criticalVector }],
    }),
    "CRITICAL",
  );
  assert.equal(
    severityLabel({ database_specific: { severity: "LOW" }, severity: [{ score: 8.1 }] }),
    "HIGH",
  );
});
