const CVSS_V3_METRICS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  PR: {
    U: { N: 0.85, L: 0.62, H: 0.27 },
    C: { N: 0.85, L: 0.68, H: 0.5 },
  },
  UI: { N: 0.85, R: 0.62 },
  C: { N: 0, L: 0.22, H: 0.56 },
  I: { N: 0, L: 0.22, H: 0.56 },
  A: { N: 0, L: 0.22, H: 0.56 },
};

function roundup(value) {
  return Math.ceil((value - 1e-10) * 10) / 10;
}

export function parseCvssBaseScore(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 && value <= 10 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const numeric = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(numeric) && numeric >= 0 && numeric <= 10) {
    return numeric;
  }

  const parts = trimmed.split("/");
  if (!/^CVSS:3\.[01]$/.test(parts[0] ?? "")) return undefined;
  const metrics = {};
  for (const part of parts.slice(1)) {
    const separator = part.indexOf(":");
    if (separator <= 0) return undefined;
    const name = part.slice(0, separator);
    if (metrics[name] !== undefined) return undefined;
    metrics[name] = part.slice(separator + 1);
  }
  const required = ["AV", "AC", "PR", "UI", "S", "C", "I", "A"];
  if (required.some((name) => metrics[name] === undefined)) return undefined;
  const scope = metrics.S;
  if (scope !== "U" && scope !== "C") return undefined;
  const attackVector = CVSS_V3_METRICS.AV[metrics.AV];
  const attackComplexity = CVSS_V3_METRICS.AC[metrics.AC];
  const privilegesRequired = CVSS_V3_METRICS.PR[scope][metrics.PR];
  const userInteraction = CVSS_V3_METRICS.UI[metrics.UI];
  const confidentiality = CVSS_V3_METRICS.C[metrics.C];
  const integrity = CVSS_V3_METRICS.I[metrics.I];
  const availability = CVSS_V3_METRICS.A[metrics.A];
  if (
    [
      attackVector,
      attackComplexity,
      privilegesRequired,
      userInteraction,
      confidentiality,
      integrity,
      availability,
    ].some((metric) => metric === undefined)
  ) {
    return undefined;
  }

  const impact = 1 - (1 - confidentiality) * (1 - integrity) * (1 - availability);
  if (impact <= 0) return 0;
  const impactSubScore =
    scope === "U" ? 6.42 * impact : 7.52 * (impact - 0.029) - 3.25 * (impact - 0.02) ** 15;
  const exploitability =
    8.22 * attackVector * attackComplexity * privilegesRequired * userInteraction;
  const baseScore =
    scope === "U"
      ? Math.min(impactSubScore + exploitability, 10)
      : Math.min(1.08 * (impactSubScore + exploitability), 10);
  return roundup(baseScore);
}

export function severityLabel(vulnerability) {
  const databaseSeverity = vulnerability.database_specific?.severity;
  if (typeof databaseSeverity === "string") {
    const normalized = databaseSeverity.toUpperCase();
    if (normalized === "CRITICAL") return "CRITICAL";
    if (normalized === "HIGH") return "HIGH";
    if (normalized === "MODERATE" || normalized === "MEDIUM") return "MEDIUM";
    if (normalized === "LOW") return "LOW";
  }
  const scores = Array.isArray(vulnerability.severity)
    ? vulnerability.severity
        .map((item) => parseCvssBaseScore(item?.score))
        .filter((score) => score !== undefined)
    : [];
  const score = scores.length > 0 ? Math.max(...scores) : Number.NaN;
  if (Number.isFinite(score)) {
    if (score >= 9) return "CRITICAL";
    if (score >= 7) return "HIGH";
    if (score >= 4) return "MEDIUM";
    return "LOW";
  }
  return "UNKNOWN";
}
