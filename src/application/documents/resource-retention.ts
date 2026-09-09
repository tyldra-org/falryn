/** Persist only through ArtifactStorePort; reference artifacts contain metadata, never a byte copy. */
import { createHash, randomUUID } from "node:crypto";
import {
  type ArtifactRecord,
  type ArtifactStorePort,
  artifactId,
} from "../../domain/artifacts/index.ts";
import {
  MAX_RESOURCE_SOURCE_BYTES,
  type ResourceEvidence,
  type ResourceFailure,
  type ResourceTarget,
} from "../../domain/documents/resource-read.ts";
import type { Result } from "../../domain/foundation/index.ts";

export const RESOURCE_REFERENCE_MEDIA = "application/vnd.falryn.resource-evidence+json";
export function resourceDigest(bytes: Uint8Array): string {
  return `sha-256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function failure(code: string) {
  return { ok: false as const, error: { code } };
}

export function createResourceRetention(store: ArtifactStorePort | undefined) {
  const ingest = async (
    id: string,
    bytes: Uint8Array,
    mediaType: string,
    signal?: AbortSignal,
  ): Promise<Result<string, ResourceFailure>> => {
    if (!store) return failure("retention-unavailable");
    async function* content() {
      yield bytes;
    }
    const result = await store.ingest(
      {
        artifactId: artifactId.from(id),
        mediaType,
        encoding: "identity",
        sensitivity: "user-content",
        origin: "tool-output",
        invocationId: null,
        declaredByteLength: bytes.length,
        content: content(),
      },
      signal,
    );
    return result.ok ? { ok: true, value: id } : failure(result.error.code);
  };
  return {
    ingest,
    async artifactBytes(
      id: string,
      signal?: AbortSignal,
    ): Promise<Result<{ bytes: Uint8Array; record: ArtifactRecord }, ResourceFailure>> {
      if (signal?.aborted) return failure("cancelled");
      const parsed = artifactId.parse(id);
      if (!parsed.ok) return failure("malformed-artifact");
      if (!store) return failure("retention-unavailable");
      const found = store.get(parsed.value);
      if (!found.ok) return failure(found.error.code);
      const record = found.value;
      if (!record) return failure("not-found");
      if (record.availability !== "available")
        return failure(record.availability === "quarantined" ? "corrupt" : "expired");
      if (record.sensitivity === "sensitive" || record.sensitivity === "restricted")
        return failure("denied");
      if (record.encoding !== "identity") return failure("unsupported-encoding");
      if (record.byteLength > MAX_RESOURCE_SOURCE_BYTES) return failure("source-limit");
      const read = await store.readRange(parsed.value, 0, record.byteLength, signal);
      if (!read.ok) return failure(read.error.code);
      if (signal?.aborted) return failure("cancelled");
      const current = store.get(parsed.value);
      if (!current.ok) return failure(current.error.code);
      if (current.value?.availability !== "available") return failure("expired");
      if (current.value.sensitivity === "restricted" || current.value.sensitivity === "sensitive")
        return failure("denied");
      if (
        current.value.digest !== record.digest ||
        current.value.byteLength !== record.byteLength ||
        read.value.bytes.length !== record.byteLength ||
        resourceDigest(read.value.bytes) !== record.digest
      )
        return failure("corrupt");
      return { ok: true, value: { bytes: read.value.bytes, record: current.value } };
    },
    async reference(
      metadata: ResourceEvidence,
      signal?: AbortSignal,
    ): Promise<Result<ResourceTarget, ResourceFailure>> {
      const id = `resource-evidence-${randomUUID()}`;
      const retained = await ingest(
        id,
        new TextEncoder().encode(JSON.stringify(metadata)),
        RESOURCE_REFERENCE_MEDIA,
        signal,
      );
      return retained.ok ? { ok: true, value: { kind: "evidence", reference: id } } : retained;
    },
  };
}
