/**
 * Render-safe projection of a typed diagnostic artifact view.
 *
 * Inspects parsed health facts and the bounded text body. Recovery actions stay
 * as other commands; this projection never names a spawn.
 */

import type { ArtifactView, ArtifactViewState } from "../../domain/index.ts";

export type DiagnosticViewModel = {
  readonly artifactId: string;
  readonly parsed: boolean;
  readonly level: string | null;
  readonly code: string | null;
  readonly subsystem: string | null;
  readonly status: ArtifactViewState;
  readonly statusNote: string | null;
  readonly text: string;
  readonly withheld: boolean;
};

export function diagnosticViewFrom(view: ArtifactView): DiagnosticViewModel | null {
  if (view.kind !== "diagnostic" || view.body === null || view.body.kind !== "diagnostic") {
    return null;
  }
  return {
    artifactId: view.artifactId,
    parsed: view.body.parsed,
    level: view.body.level,
    code: view.body.code,
    subsystem: view.body.subsystem,
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
