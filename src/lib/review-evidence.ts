import { createHash } from "node:crypto";

import type { LinkedIssueSnapshot, PullRequestContext, ReviewBriefing } from "./types.js";

const MAX_LINKED_ISSUES = 20;
const ISSUE_NUMBER_PATTERN = /^[1-9][0-9]{0,8}$/u;

function issueNumber(value: string): number | undefined {
  if (!ISSUE_NUMBER_PATTERN.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function withoutMarkdownCode(value: string): string {
  return value
    .replace(/<!--[\s\S]*?(?:-->|$)/gu, " ")
    .replace(/(`{3,})[\s\S]*?(?:\1|$)/gu, " ")
    .replace(/(~{3,})[\s\S]*?(?:\1|$)/gu, " ")
    .replace(/`[^`\n]*`/gu, " ");
}

interface IssueReference {
  readonly number: number;
  readonly position: number;
}

function addReference(
  references: IssueReference[],
  seen: Set<number>,
  value: string,
  position: number,
): void {
  const number = issueNumber(value);
  if (number === undefined || seen.has(number)) return;
  seen.add(number);
  references.push({ number, position });
}

export function discoverLinkedIssueNumbers(context: PullRequestContext): {
  readonly numbers: readonly number[];
  readonly truncated: boolean;
} {
  const body = withoutMarkdownCode(context.body ?? "");
  const references: IssueReference[] = [];
  const seen = new Set<number>();
  const owner = context.owner.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const name = context.name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const qualifiedPattern = new RegExp(
    `(?:^|[^A-Za-z0-9_.-])${owner}/${name}#([1-9][0-9]{0,8})`,
    "giu",
  );
  for (const match of body.matchAll(qualifiedPattern))
    addReference(references, seen, match[1] as string, match.index);
  for (const match of body.matchAll(/(?:^|[^A-Za-z0-9_])#([1-9][0-9]{0,8})/gu))
    addReference(references, seen, match[1] as string, match.index);
  for (const match of body.matchAll(/https?:\/\/[^\s)<>\]]+/giu)) {
    const rawUrl = match[0].replace(/[.,;:!?]+$/gu, "");
    try {
      const url = new URL(rawUrl);
      const expectedOrigin = new URL(context.htmlUrl).origin;
      const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
      if (
        url.origin !== expectedOrigin ||
        segments.length !== 4 ||
        segments[0]?.toLowerCase() !== context.owner.toLowerCase() ||
        segments[1]?.toLowerCase() !== context.name.toLowerCase() ||
        segments[2]?.toLowerCase() !== "issues"
      )
        continue;
      addReference(references, seen, segments[3] as string, match.index);
    } catch {
      continue;
    }
  }
  references.sort((left, right) => left.position - right.position || left.number - right.number);
  return {
    numbers: references.slice(0, MAX_LINKED_ISSUES).map((reference) => reference.number),
    truncated: references.length > MAX_LINKED_ISSUES,
  };
}

export function reviewBriefingDigest(
  context: PullRequestContext,
  briefing: ReviewBriefing,
): string {
  if (
    (context.body ?? "").length === 0 &&
    briefing.linkedIssues.length === 0 &&
    !briefing.linkedIssueReferencesTruncated
  )
    return "";
  return createHash("sha256")
    .update(
      JSON.stringify({
        body: context.body ?? "",
        linkedIssues: briefing.linkedIssues,
        linkedIssueReferencesTruncated: briefing.linkedIssueReferencesTruncated,
      }),
    )
    .digest("hex");
}

export function emptyReviewBriefing(): ReviewBriefing {
  return { linkedIssues: [], linkedIssueReferencesTruncated: false };
}

export function issueSnapshot(
  number: number,
  payload: Record<string, unknown>,
): LinkedIssueSnapshot {
  const title = payload.title;
  const body = payload.body;
  const state = payload.state;
  const htmlUrl = payload.html_url;
  if (
    typeof title !== "string" ||
    typeof state !== "string" ||
    (body !== null && typeof body !== "string") ||
    typeof htmlUrl !== "string" ||
    htmlUrl.length === 0
  )
    throw new Error(`GitHub returned an invalid linked issue #${number}.`);
  return {
    number,
    title,
    state,
    body: body ?? "",
    htmlUrl,
  };
}

export const reviewEvidenceInternals = {
  MAX_LINKED_ISSUES,
  withoutMarkdownCode,
};
