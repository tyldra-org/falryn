/**
 * Render-safe projection of a typed document artifact view.
 */

import type {
  ArtifactView,
  ArtifactViewDocumentFamily,
  ArtifactViewState,
} from "../../domain/index.ts";

export type DocumentViewModel = {
  readonly artifactId: string;
  readonly family: ArtifactViewDocumentFamily;
  readonly status: ArtifactViewState;
  readonly statusNote: string | null;
  readonly text: string;
  readonly withheld: boolean;
};

export function documentViewFrom(view: ArtifactView): DocumentViewModel | null {
  if (view.kind !== "document" || view.body === null || view.body.kind !== "document") {
    return null;
  }
  return {
    artifactId: view.artifactId,
    family: view.body.family,
    status: view.status,
    statusNote: statusNoteFor(view.status, view.transformed),
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
