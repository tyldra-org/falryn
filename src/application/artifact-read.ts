/**
 * Application boundary for bounded artifact reads (#58).
 *
 * This reader delegates all metadata and byte access to the injected artifact
 * store. It never reaches SQLite or a blob path directly.
 */

import type { ArtifactStorePort } from "../domain/index.ts";
import {
  type ArtifactRead,
  type ArtifactReadError,
  type ArtifactRecord,
  type NormalizedArtifactReadRequest,
  parseArtifactReadRequest,
  type Result,
} from "../domain/index.ts";

export type ArtifactReader = {
  read(request: unknown, signal?: AbortSignal): Promise<Result<ArtifactRead, ArtifactReadError>>;
};

function cancelled(): Result<never, ArtifactReadError> {
  return { ok: false, error: { code: "cancelled" } };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function previewLength(request: NormalizedArtifactReadRequest): number {
  return request.length ?? request.limits.maxPreviewBytes;
}

function rangeLength(request: NormalizedArtifactReadRequest): number {
  return request.length ?? request.limits.maxRangeBytes;
}

function metadataResult(
  request: NormalizedArtifactReadRequest,
  record: ArtifactRecord,
): ArtifactRead {
  return {
    capability: "read_artifact",
    projection: "artifact",
    complete: false,
    status: "complete",
    mode: request.mode,
    record,
    range: null,
  };
}

export function createArtifactReader(store: ArtifactStorePort): ArtifactReader {
  return {
    async read(request, signal) {
      if (isAborted(signal)) {
        return cancelled();
      }
      const parsed = parseArtifactReadRequest(request);
      if (!parsed.ok) {
        return parsed;
      }

      const found = store.get(parsed.value.artifactId);
      if (!found.ok) {
        return found;
      }
      if (found.value === null) {
        return {
          ok: false,
          error: {
            kind: "artifact",
            code: "not-found",
            artifactId: parsed.value.artifactId,
          },
        };
      }
      if (parsed.value.mode === "metadata") {
        return { ok: true, value: metadataResult(parsed.value, found.value) };
      }
      if (isAborted(signal)) {
        return cancelled();
      }

      const read =
        parsed.value.mode === "preview"
          ? await store.preview(parsed.value.artifactId, previewLength(parsed.value), signal)
          : await store.readRange(
              parsed.value.artifactId,
              parsed.value.offset ?? 0,
              rangeLength(parsed.value),
              signal,
            );
      if (!read.ok) {
        return read;
      }
      if (isAborted(signal)) {
        return cancelled();
      }
      return {
        ok: true,
        value: {
          ...metadataResult(parsed.value, found.value),
          range: read.value,
        },
      };
    },
  };
}
