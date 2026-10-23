import { escapeHtmlText } from "./redaction.js";
import type { ChangedFile, GoalResult, ReviewCoverage, ReviewLineRange } from "./types.js";

const MAX_COVERAGE_DETAILS_BYTES = 20_000;
const TOKEN_FORMATTER = new Intl.NumberFormat("en-US");

function countCoveredLines(ranges: readonly ReviewLineRange[]): number {
  let count = 0;
  let end = 0;
  for (const [left, right] of [...ranges].sort(([left], [right]) => left - right)) {
    count += Math.max(0, right - Math.max(left, end));
    end = Math.max(end, right);
  }
  return count;
}

export function aggregateCoverage(
  files: readonly ChangedFile[],
  goals: readonly GoalResult[],
  totalReviewerProfiles: number,
  displayPath: (path: string) => string,
): ReviewCoverage {
  const profiles = goals
    .slice(0, totalReviewerProfiles)
    .map((goal) =>
      goal.inspection?.lineCoverage === undefined
        ? undefined
        : new Map(goal.inspection.lineCoverage.map((file) => [file.path, file])),
    );
  const rows = files.map((file) => {
    const reads = profiles.flatMap((profile) => {
      const read = profile?.get(file.path);
      return read === undefined ? [] : [read];
    });
    return {
      path: displayPath(file.path),
      linesRead:
        countCoveredLines(reads.flatMap((read) => read.addedLines)) +
        countCoveredLines(reads.flatMap((read) => read.deletedLines)),
      totalChanges: file.changes,
      reviewersRead: reads.filter((read) => read.addedLines.length + read.deletedLines.length > 0)
        .length,
    };
  });
  return {
    files: rows,
    linesRead: rows.reduce((total, file) => total + file.linesRead, 0),
    totalChanges: rows.reduce((total, file) => total + file.totalChanges, 0),
    totalReviewerProfiles,
    trackedReviewerProfiles: profiles.filter((profile) => profile !== undefined).length,
  };
}

function coveragePercentage(read: number, total: number, coverage: ReviewCoverage): string {
  if (total === 0 || coverage.trackedReviewerProfiles === 0) return "N/A";
  const percentage = Number((BigInt(read) * 1_000n) / BigInt(total)) / 10;
  const lowerBound = coverage.trackedReviewerProfiles < coverage.totalReviewerProfiles;
  return `${lowerBound ? "at least " : ""}${percentage}%`;
}

export function buildCoverageDetails(coverage: ReviewCoverage): string {
  const percentage = coveragePercentage(coverage.linesRead, coverage.totalChanges, coverage);
  const unavailable = coverage.trackedReviewerProfiles === 0;
  const summary =
    percentage === "N/A"
      ? `N/A (${coverage.totalChanges === 0 ? "no countable changed lines" : "tracking unavailable"})`
      : `${percentage} of total changes`;
  const prefix = [
    "<details>",
    `<summary>🔍 Review coverage · ${summary}</summary>`,
    "",
    "| File | Lines read | Total changes | Coverage | Reviewers read | Total reviewer profiles |",
    "|:--|--:|--:|--:|--:|--:|",
  ];
  const count = (value: number) => (unavailable ? "—" : TOKEN_FORMATTER.format(value));
  const suffix = [
    `| **Total** | **${count(coverage.linesRead)}** | **${TOKEN_FORMATTER.format(coverage.totalChanges)}** | **${percentage}** | — | **${TOKEN_FORMATTER.format(coverage.totalReviewerProfiles)}** |`,
    "",
    "> Lines read counts distinct added or deleted lines delivered to at least one reviewer, including inherited source evidence. Repeated reads count once. Total changes excludes unchanged context; the headline divides summed lines read by summed total changes.",
    "> Reviewers read counts profiles receiving at least one changed line in that file. Total reviewer profiles includes failed and unfinished profiles; discovery is not an additional profile. Coverage does not measure review quality or completion.",
    ...(coverage.trackedReviewerProfiles < coverage.totalReviewerProfiles
      ? [
          `> Tracking is unavailable for ${coverage.totalReviewerProfiles - coverage.trackedReviewerProfiles} reviewer profile(s). Known line and reader counts are lower bounds.`,
        ]
      : []),
    "",
    "</details>",
  ];
  const omission = (omitted: number) =>
    `> ${omitted} additional file row(s) omitted to keep this section compact; totals include every file.`;
  let bytes = Buffer.byteLength(
    [...prefix, ...suffix, "", omission(coverage.files.length)].join("\n"),
    "utf8",
  );
  const rows: string[] = [];
  for (const file of coverage.files) {
    const path = escapeHtmlText(file.path).replace(/\|/gu, "&#124;");
    const row = `| <code>${path}</code> | ${count(file.linesRead)} | ${TOKEN_FORMATTER.format(file.totalChanges)} | ${coveragePercentage(file.linesRead, file.totalChanges, coverage)} | ${count(file.reviewersRead)} | ${TOKEN_FORMATTER.format(coverage.totalReviewerProfiles)} |`;
    const rowBytes = Buffer.byteLength(row + "\n", "utf8");
    if (bytes + rowBytes > MAX_COVERAGE_DETAILS_BYTES) break;
    rows.push(row);
    bytes += rowBytes;
  }
  const omitted = coverage.files.length - rows.length;
  return [
    ...prefix,
    ...rows,
    ...suffix.slice(0, -2),
    ...(omitted > 0 ? ["", omission(omitted)] : []),
    "",
    "</details>",
  ].join("\n");
}
