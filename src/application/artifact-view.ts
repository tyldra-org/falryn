/**
 * Application boundary for typed artifact viewers (#117).
 *
 * Reads stored bytes through ArtifactStorePort, expands gzip with an output
 * ceiling, and projects a view. It never highlights, executes, or reaches a
 * blob path. Pixel decode stays with the workspace image reader.
 */

import { gunzipSync } from "node:zlib";

import {
  type ArtifactRecord,
  type ArtifactStorePort,
  type ArtifactView,
  type ArtifactViewError,
  type ArtifactViewLimits,
  encodingNeedsDecode,
  err,
  maximumDecodedBytes,
  parseArtifactViewRequest,
  projectArtifactView,
  type Result,
} from "../domain/index.ts";

export type ArtifactViewer = {
  view(request: unknown, signal?: AbortSignal): Promise<Result<ArtifactView, ArtifactViewError>>;
};

function cancelled(): Result<never, ArtifactViewError> {
  return {
    ok: false,
    error: { kind: "artifact-view", code: "cancelled", artifactId: null, field: null },
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createArtifactViewer(store: ArtifactStorePort): ArtifactViewer {
  return {
    async view(request, signal) {
      if (isAborted(signal)) {
        return cancelled();
      }
      const parsed = parseArtifactViewRequest(request);
      if (!parsed.ok) {
        return parsed;
      }
      const found = store.get(parsed.value.artifactId);
      if (!found.ok) {
        return found;
      }
      if (found.value === null) {
        return err({
          kind: "artifact",
          code: "not-found",
          artifactId: parsed.value.artifactId,
        });
      }
      if (isAborted(signal)) {
        return cancelled();
      }

      const record = found.value;
      const withheld = withholdWithoutBytes(record);
      if (withheld) {
        return okView({
          record,
          bytes: null,
          transformed: false,
          truncated: false,
          stale: false,
          limits: parsed.value.limits,
        });
      }

      const intact = await store.verifyIntegrity(parsed.value.artifactId, signal);
      if (!intact.ok) {
        return intact;
      }
      if (isAborted(signal)) {
        return cancelled();
      }

      const sourceLength = Math.min(record.byteLength, parsed.value.limits.maxSourceBytes);
      const sourceTruncated = record.byteLength > parsed.value.limits.maxSourceBytes;
      if (encodingNeedsDecode(record.encoding) && sourceTruncated) {
        return okView({
          record,
          bytes: null,
          transformed: false,
          truncated: true,
          stale: !intact.value,
          limits: parsed.value.limits,
        });
      }

      const preview = await store.preview(parsed.value.artifactId, sourceLength, signal);
      if (!preview.ok) {
        return preview;
      }
      if (isAborted(signal)) {
        return cancelled();
      }

      const decoded = decodeBytes(record, preview.value.bytes, parsed.value.limits);
      if (!decoded.ok) {
        return decoded;
      }

      const viewTruncated =
        sourceTruncated || decoded.value.bytes.byteLength > parsed.value.limits.maxViewBytes;
      return okView({
        record,
        bytes: decoded.value.bytes,
        transformed: decoded.value.transformed,
        truncated: viewTruncated,
        stale: !intact.value,
        limits: parsed.value.limits,
      });
    },
  };
}

function withholdWithoutBytes(record: ArtifactRecord): boolean {
  return (
    record.availability === "missing" ||
    record.availability === "reserved" ||
    record.availability === "quarantined" ||
    record.sensitivity === "restricted"
  );
}

function okView(input: {
  readonly record: ArtifactRecord;
  readonly bytes: Uint8Array | null;
  readonly transformed: boolean;
  readonly truncated: boolean;
  readonly stale: boolean;
  readonly limits: ArtifactViewLimits;
}): Result<ArtifactView, ArtifactViewError> {
  return {
    ok: true,
    value: projectArtifactView(input),
  };
}

function decodeBytes(
  record: ArtifactRecord,
  bytes: Uint8Array,
  limits: ArtifactViewLimits,
): Result<
  { readonly bytes: Uint8Array; readonly transformed: boolean },
  Extract<ArtifactViewError, { readonly kind: "artifact-view" }>
> {
  if (!encodingNeedsDecode(record.encoding)) {
    return { ok: true, value: { bytes, transformed: false } };
  }
  if (bytes.byteLength < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    return {
      ok: false,
      error: {
        kind: "artifact-view",
        code: "malformed-encoding",
        artifactId: record.artifactId,
        field: "encoding",
      },
    };
  }
  const maximumBytes = maximumDecodedBytes(bytes.byteLength, limits);
  try {
    const expanded = gunzipSync(bytes, { maxOutputLength: maximumBytes });
    if (expanded.byteLength > maximumBytes) {
      return {
        ok: false,
        error: {
          kind: "artifact-view",
          code: "decompression-limit",
          artifactId: record.artifactId,
          field: "encoding",
        },
      };
    }
    return { ok: true, value: { bytes: new Uint8Array(expanded), transformed: true } };
  } catch (error) {
    const limited =
      error instanceof RangeError ||
      (error instanceof Error && /maxOutputLength|too much data/i.test(error.message));
    return {
      ok: false,
      error: {
        kind: "artifact-view",
        code: limited ? "decompression-limit" : "malformed-encoding",
        artifactId: record.artifactId,
        field: "encoding",
      },
    };
  }
}
