/**
 * Test and fixture artifact views keyed by id.
 *
 * Not product surface. Lets rendered tests open a code viewer without SQLite.
 */

import type { ArtifactViewer } from "../../application/index.ts";
import {
  ARTIFACT_VIEW_VERSION,
  type ArtifactView,
  artifactId,
  CONTENT_DIGEST_ALGORITHM,
  err,
  ok,
  parseArtifactViewRequest,
  timestampFromEpochMilliseconds,
} from "../../domain/index.ts";

const FIXTURE_DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"b".repeat(64)}`;

export function createMapArtifactViewer(
  views: Readonly<Record<string, ArtifactView>>,
): ArtifactViewer {
  return {
    async view(request) {
      const parsed = parseArtifactViewRequest(request);
      if (!parsed.ok) {
        return parsed;
      }
      const view = views[parsed.value.artifactId];
      if (view === undefined) {
        return err({
          kind: "artifact",
          code: "not-found",
          artifactId: parsed.value.artifactId,
        });
      }
      return ok(view);
    },
  };
}

/** A complete diff artifact view for fixture-driven shell tests. */
export function fixtureDiffArtifactView(input: {
  readonly id: string;
  readonly text: string;
  readonly status?: ArtifactView["status"];
  readonly hunkCount?: number;
}): ArtifactView {
  const id = artifactId.from(input.id);
  return {
    schemaVersion: ARTIFACT_VIEW_VERSION,
    artifactId: id,
    record: {
      artifactId: id,
      digest: FIXTURE_DIGEST as ArtifactView["record"]["digest"],
      mediaType: "text/x-diff",
      origin: "tool-output",
      encoding: "identity",
      byteLength: new TextEncoder().encode(input.text).byteLength,
      sensitivity: "user-content",
      invocationId: null,
      createdAt: timestampFromEpochMilliseconds(0),
      finalizedAt: timestampFromEpochMilliseconds(1),
      availability: "available",
    },
    kind: "diff",
    status: input.status ?? "complete",
    transformed: false,
    sourceByteLength: new TextEncoder().encode(input.text).byteLength,
    decodedByteLength: new TextEncoder().encode(input.text).byteLength,
    viewByteLength: new TextEncoder().encode(input.text).byteLength,
    body: {
      kind: "diff",
      mode: "unified",
      hunkCount: input.hunkCount ?? input.text.split("@@").length - 1,
      text: input.text,
    },
  };
}

/** A complete code artifact view for fixture-driven shell tests. */
export function fixtureCodeArtifactView(input: {
  readonly id: string;
  readonly language?: "typescript" | "text";
  readonly text: string;
  readonly status?: ArtifactView["status"];
}): ArtifactView {
  const id = artifactId.from(input.id);
  return {
    schemaVersion: ARTIFACT_VIEW_VERSION,
    artifactId: id,
    record: {
      artifactId: id,
      digest: FIXTURE_DIGEST as ArtifactView["record"]["digest"],
      mediaType: input.language === "typescript" ? "text/typescript" : "text/plain",
      origin: "tool-output",
      encoding: "identity",
      byteLength: new TextEncoder().encode(input.text).byteLength,
      sensitivity: "user-content",
      invocationId: null,
      createdAt: timestampFromEpochMilliseconds(0),
      finalizedAt: timestampFromEpochMilliseconds(1),
      availability: "available",
    },
    kind: "code",
    status: input.status ?? "complete",
    transformed: false,
    sourceByteLength: new TextEncoder().encode(input.text).byteLength,
    decodedByteLength: new TextEncoder().encode(input.text).byteLength,
    viewByteLength: new TextEncoder().encode(input.text).byteLength,
    body: {
      kind: "code",
      language: input.language ?? "typescript",
      lineCount: input.text.split("\n").length,
      text: input.text,
    },
  };
}
