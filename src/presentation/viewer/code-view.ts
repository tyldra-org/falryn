/**
 * Render-safe projection of a typed code artifact view.
 *
 * Maps the domain `ArtifactView` into plain data the terminal interface can
 * draw without importing OpenTUI or reaching back into the store.
 */

import type {
  ArtifactView,
  ArtifactViewCodeLanguage,
  ArtifactViewState,
} from "../../domain/index.ts";

export type CodeViewModel = {
  readonly artifactId: string;
  readonly language: ArtifactViewCodeLanguage;
  readonly status: ArtifactViewState;
  /** One sentence naming truncation, staleness, or withholding. Null when complete. */
  readonly statusNote: string | null;
  readonly lineCount: number;
  readonly text: string;
  readonly withheld: boolean;
};

export function codeViewFrom(view: ArtifactView): CodeViewModel | null {
  if (view.kind !== "code" || view.body === null || view.body.kind !== "code") {
    return null;
  }
  return {
    artifactId: view.artifactId,
    language: view.body.language,
    status: view.status,
    statusNote: statusNoteFor(view.status, view.transformed),
    lineCount: view.body.lineCount,
    text: view.body.text,
    withheld: view.body.text.length === 0,
  };
}

function statusNoteFor(status: ArtifactViewState, transformed: boolean): string | null {
  switch (status) {
    case "complete":
      return transformed ? "Content was expanded from gzip." : null;
    case "truncated":
      return "Showing a bounded prefix; the artifact continues.";
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
