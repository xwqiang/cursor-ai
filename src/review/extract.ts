import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ATTACH_FILE_MARKER, CODE_REVIEW_REL, REVIEW_HTML_MARKER } from "./paths.js";

const MARKER_RE = new RegExp(`${REVIEW_HTML_MARKER}([^\\s\\n]+)`, "g");
const MARKER_ONCE = new RegExp(`${REVIEW_HTML_MARKER}([^\\s\\n]+)`);
const ATTACH_RE = new RegExp(`${ATTACH_FILE_MARKER}([^\\s\\n]+)`, "g");

export interface ExtractedReview {
  text: string;
  reviewPath?: string;
  attachPaths?: string[];
}

/**
 * Pull review HTML path from agent text and/or a freshly written default file.
 * `startedAt` is ms since epoch captured before the agent run.
 */
export function extractReviewResult(
  raw: string,
  projectRoot: string,
  startedAt: number,
): ExtractedReview {
  let reviewPath: string | undefined;
  const markerMatch = raw.match(MARKER_ONCE);
  if (markerMatch?.[1]) {
    const p = markerMatch[1].trim();
    reviewPath = p.startsWith("/") ? p : resolve(projectRoot, p);
  }

  const attachSet = new Set<string>();
  for (const m of raw.matchAll(ATTACH_RE)) {
    const p = (m?.[1] ?? "").trim();
    if (!p) continue;
    const resolved = p.startsWith("/") ? p : resolve(projectRoot, p);
    attachSet.add(resolved);
  }

  const defaultPath = resolve(projectRoot, CODE_REVIEW_REL);
  if (!reviewPath && existsSync(defaultPath)) {
    const mtime = statSync(defaultPath).mtimeMs;
    if (mtime >= startedAt - 2_000) reviewPath = defaultPath;
  }

  // Filter to existing files only (avoid noisy errors on send).
  const attachPaths = [...attachSet].filter((p) => existsSync(p));

  const text = raw
    .replace(MARKER_RE, "")
    .replace(ATTACH_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (reviewPath && !existsSync(reviewPath)) reviewPath = undefined;

  return { text, reviewPath, attachPaths: attachPaths.length > 0 ? attachPaths : undefined };
}
