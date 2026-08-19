/**
 * Render-safe projection of a typed diff artifact view.
 */

import type { ArtifactView, ArtifactViewDiffMode, ArtifactViewState } from "../../domain/index.ts";

export type DiffViewModel = {
  readonly artifactId: string;
  readonly mode: ArtifactViewDiffMode;
  readonly status: ArtifactViewState;
  readonly statusNote: string | null;
  readonly hunkCount: number;
  readonly text: string;
  readonly withheld: boolean;
};

export function diffViewFrom(view: ArtifactView): DiffViewModel | null {
  if (view.kind !== "diff" || view.body === null || view.body.kind !== "diff") {
    return null;
  }
  return {
    artifactId: view.artifactId,
    mode: view.body.mode,
    status: view.status,
    statusNote: statusNoteFor(view.status, view.transformed),
    hunkCount: view.body.hunkCount,
    text: view.body.text,
    withheld: view.body.text.length === 0,
  };
}

/** Unified diff text narrowed to one hunk while keeping file headers. */
export function diffTextForHunk(text: string, hunkIndex: number): string {
  const parsed = parseUnifiedDiff(text);
  if (parsed.hunks.length === 0) {
    return text;
  }
  const index = Math.max(0, Math.min(hunkIndex, parsed.hunks.length - 1));
  const hunk = parsed.hunks[index];
  if (hunk === undefined) {
    return text;
  }
  return [...parsed.headers, hunk].join("\n");
}

export function hunkCountOfDiffText(text: string): number {
  return parseUnifiedDiff(text).hunks.length;
}

function parseUnifiedDiff(text: string): { readonly headers: string[]; readonly hunks: string[] } {
  const lines = text.split("\n");
  const headers: string[] = [];
  const hunks: string[] = [];
  let current: string[] = [];

  const flushHunk = (): void => {
    if (current.length > 0) {
      hunks.push(current.join("\n"));
      current = [];
    }
  };

  for (const line of lines) {
    if (line.startsWith("@@")) {
      flushHunk();
      current = [line];
      continue;
    }
    if (current.length > 0) {
      current.push(line);
      continue;
    }
    if (
      hunks.length === 0 &&
      (line.startsWith("diff --git") || line.startsWith("---") || line.startsWith("+++"))
    ) {
      headers.push(line);
    }
  }
  flushHunk();
  return { headers, hunks };
}

function statusNoteFor(status: ArtifactViewState, transformed: boolean): string | null {
  switch (status) {
    case "complete":
      return transformed ? "Content was expanded from gzip." : null;
    case "truncated":
      return "Showing a bounded prefix; the diff continues.";
    case "transformed":
      return "Content was expanded from gzip.";
    case "stale":
      return "Digest no longer matches; body may be outdated.";
    case "missing":
      return "The artifact bytes are not present.";
    case "quarantined":
      return "The artifact failed integrity verification.";
    case "redacted":
      return "This artifact is restricted and was not read.";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
