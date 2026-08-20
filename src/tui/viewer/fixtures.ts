/**
 * Test and fixture artifact views keyed by id.
 *
 * Not product surface. Lets rendered tests open artifact viewers without SQLite.
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

/** A complete document artifact view for fixture-driven shell tests. */
export function fixtureDocumentArtifactView(input: {
  readonly id: string;
  readonly family?: "markdown" | "html" | "log" | "text";
  readonly text: string;
  readonly status?: ArtifactView["status"];
}): ArtifactView {
  const id = artifactId.from(input.id);
  const family = input.family ?? "markdown";
  const mediaType =
    family === "markdown" ? "text/markdown" : family === "html" ? "text/html" : "text/plain";
  return {
    schemaVersion: ARTIFACT_VIEW_VERSION,
    artifactId: id,
    record: {
      artifactId: id,
      digest: FIXTURE_DIGEST as ArtifactView["record"]["digest"],
      mediaType,
      origin: "tool-output",
      encoding: "identity",
      byteLength: new TextEncoder().encode(input.text).byteLength,
      sensitivity: "user-content",
      invocationId: null,
      createdAt: timestampFromEpochMilliseconds(0),
      finalizedAt: timestampFromEpochMilliseconds(1),
      availability: "available",
    },
    kind: "document",
    status: input.status ?? "complete",
    transformed: false,
    sourceByteLength: new TextEncoder().encode(input.text).byteLength,
    decodedByteLength: new TextEncoder().encode(input.text).byteLength,
    viewByteLength: new TextEncoder().encode(input.text).byteLength,
    body: {
      kind: "document",
      family,
      text: input.text,
    },
  };
}

/** A complete media summary artifact view for fixture-driven shell tests. */
export function fixtureMediaArtifactView(input: {
  readonly id: string;
  readonly format?: string;
  readonly storedByteLength?: number;
  readonly hexPreview?: string;
  readonly status?: ArtifactView["status"];
}): ArtifactView {
  const id = artifactId.from(input.id);
  const format = input.format ?? "image/png";
  const storedByteLength = input.storedByteLength ?? 8;
  const hexPreview = input.hexPreview ?? "89 50 4e 47 0d 0a 1a 0a";
  return {
    schemaVersion: ARTIFACT_VIEW_VERSION,
    artifactId: id,
    record: {
      artifactId: id,
      digest: FIXTURE_DIGEST as ArtifactView["record"]["digest"],
      mediaType: format,
      origin: "tool-output",
      encoding: "identity",
      byteLength: storedByteLength,
      sensitivity: "user-content",
      invocationId: null,
      createdAt: timestampFromEpochMilliseconds(0),
      finalizedAt: timestampFromEpochMilliseconds(1),
      availability: "available",
    },
    kind: "media",
    status: input.status ?? "complete",
    transformed: false,
    sourceByteLength: storedByteLength,
    decodedByteLength: storedByteLength,
    viewByteLength: storedByteLength,
    body: {
      kind: "media",
      format,
      visual: "summary",
      storedByteLength,
      hexPreview,
    },
  };
}

/** A complete diagnostic artifact view for fixture-driven shell tests. */
export function fixtureDiagnosticArtifactView(input: {
  readonly id: string;
  readonly text?: string;
  readonly level?: string | null;
  readonly code?: string | null;
  readonly subsystem?: string | null;
  readonly parsed?: boolean;
  readonly status?: ArtifactView["status"];
}): ArtifactView {
  const id = artifactId.from(input.id);
  const text = input.text ?? '{"level":"error","code":"provider-unreachable"}';
  return {
    schemaVersion: ARTIFACT_VIEW_VERSION,
    artifactId: id,
    record: {
      artifactId: id,
      digest: FIXTURE_DIGEST as ArtifactView["record"]["digest"],
      mediaType: "application/vnd.falryn.diagnostic+json",
      origin: "diagnostic",
      encoding: "identity",
      byteLength: new TextEncoder().encode(text).byteLength,
      sensitivity: "user-content",
      invocationId: null,
      createdAt: timestampFromEpochMilliseconds(0),
      finalizedAt: timestampFromEpochMilliseconds(1),
      availability: "available",
    },
    kind: "diagnostic",
    status: input.status ?? "complete",
    transformed: false,
    sourceByteLength: new TextEncoder().encode(text).byteLength,
    decodedByteLength: new TextEncoder().encode(text).byteLength,
    viewByteLength: new TextEncoder().encode(text).byteLength,
    body: {
      kind: "diagnostic",
      parsed: input.parsed ?? true,
      level: input.level === undefined ? "error" : input.level,
      code: input.code === undefined ? "provider-unreachable" : input.code,
      subsystem: input.subsystem === undefined ? "provider" : input.subsystem,
      text,
    },
  };
}
