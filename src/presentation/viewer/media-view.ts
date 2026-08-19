/**
 * Render-safe projection of a typed media artifact view.
 *
 * Media is summary-only: format, byte length, and a hex prefix. No decode.
 */

import type { ArtifactView, ArtifactViewState } from "../../domain/index.ts";

export type MediaViewModel = {
  readonly artifactId: string;
  readonly format: string;
  readonly status: ArtifactViewState;
  readonly statusNote: string | null;
  readonly storedByteLength: number;
  readonly hexPreview: string;
  readonly withheld: boolean;
};

export function mediaViewFrom(view: ArtifactView): MediaViewModel | null {
  if (view.kind !== "media" || view.body === null || view.body.kind !== "media") {
    return null;
  }
  return {
    artifactId: view.artifactId,
    format: view.body.format,
    status: view.status,
    statusNote: statusNoteFor(view.status, view.transformed),
    storedByteLength: view.body.storedByteLength,
    hexPreview: view.body.hexPreview,
    withheld: view.body.hexPreview.length === 0,
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
