/** Artifact-backed scratch-resource orchestration (#848). */

import { randomUUID } from "node:crypto";

import {
  type ArtifactId,
  type ArtifactStorePort,
  artifactId,
  type ClockPort,
  err,
  type InvocationId,
  MAX_SCRATCH_LIST_LIMIT,
  MAX_SCRATCH_TEXT_BYTES,
  ok,
  parseScratchHandle,
  parseScratchListLimit,
  parseScratchMediaType,
  parseScratchName,
  type Result,
  type ScratchHandle,
  type ScratchMediaType,
  type ScratchResourceRepositoryPort,
  type ScratchResourceView,
  type ScratchRevision,
  type SessionId,
  scratchHandle,
  scratchRevision,
  validateScratchText,
} from "../domain/index.ts";

export type ScratchResourceError = {
  readonly kind: "scratch-resource";
  readonly code:
    | "malformed-input"
    | "malformed-handle"
    | "cross-session"
    | "unsupported-media-type"
    | "oversize"
    | "not-found"
    | "discarded"
    | "conflict"
    | "cancelled"
    | "artifact-unavailable"
    | "malformed-storage"
    | "storage-unavailable";
};

export type ScratchMetadata = {
  readonly handle: ScratchHandle;
  readonly name: string;
  readonly status: "active" | "discarded";
  readonly revision: ScratchRevision;
  readonly digest: string;
  readonly mediaType: ScratchMediaType;
  readonly byteLength: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type ScratchRead = ScratchMetadata & { readonly text: string };

export type ScratchWriteInput = {
  readonly sessionId: SessionId;
  readonly invocationId: InvocationId;
  readonly name: unknown;
  readonly text: unknown;
  readonly mediaType?: unknown;
  readonly expectedRevision?: unknown;
};

export type ScratchResourcePort = {
  write(
    input: ScratchWriteInput,
    signal?: AbortSignal,
  ): Promise<Result<ScratchMetadata, ScratchResourceError>>;
  read(
    sessionId: SessionId,
    handle: unknown,
    revision?: unknown,
    signal?: AbortSignal,
  ): Promise<Result<ScratchRead, ScratchResourceError>>;
  list(
    sessionId: SessionId,
    limit?: unknown,
  ): Result<readonly ScratchMetadata[], ScratchResourceError>;
  discard(
    sessionId: SessionId,
    handle: unknown,
    expectedRevision: unknown,
    signal?: AbortSignal,
  ): Result<ScratchMetadata, ScratchResourceError>;
  readBytes(
    sessionId: SessionId,
    handle: unknown,
    revision: unknown,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, ScratchResourceError>>;
};

export type ScratchResourceOptions = {
  readonly artifacts: ArtifactStorePort;
  readonly repository: ScratchResourceRepositoryPort;
  readonly clock: ClockPort;
  readonly createArtifactId?: () => ArtifactId;
};

function failure(code: ScratchResourceError["code"]): ScratchResourceError {
  return { kind: "scratch-resource", code };
}

function repositoryFailure(code: string): ScratchResourceError {
  switch (code) {
    case "not-found":
    case "discarded":
    case "conflict":
    case "cancelled":
      return failure(code);
    case "malformed":
      return failure("malformed-storage");
    default:
      return failure("storage-unavailable");
  }
}

function metadata(view: ScratchResourceView): ScratchMetadata {
  return {
    handle: scratchHandle(view.resource.sessionId, view.resource.name),
    name: view.resource.name,
    status: view.resource.status,
    revision: view.revision.revision,
    digest: view.revision.digest,
    mediaType: view.revision.mediaType,
    byteLength: view.revision.byteLength,
    createdAt: view.resource.createdAt,
    updatedAt: view.resource.updatedAt,
  };
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

export function createScratchResources(options: ScratchResourceOptions): ScratchResourcePort {
  const nextArtifactId =
    options.createArtifactId ?? (() => artifactId.from(`scratch-${randomUUID()}`));

  const resolve = (
    owner: SessionId,
    handleValue: unknown,
    revisionValue?: unknown,
  ): Result<ScratchResourceView, ScratchResourceError> => {
    const handle = parseScratchHandle(handleValue, owner);
    if (!handle.ok) {
      return err(
        failure(handle.error.code === "cross-session" ? "cross-session" : "malformed-handle"),
      );
    }
    const revision = revisionValue === undefined ? undefined : scratchRevision(revisionValue);
    if (revision !== undefined && !revision.ok) return err(failure("malformed-input"));
    const found = options.repository.get(owner, handle.value.name, revision?.value);
    if (!found.ok) return err(repositoryFailure(found.error.code));
    return found.value === null ? err(failure("not-found")) : ok(found.value);
  };

  const exactBytes = async (
    view: ScratchResourceView,
    maximumBytes: number,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, ScratchResourceError>> => {
    if (view.revision.byteLength > maximumBytes) return err(failure("oversize"));
    const record = options.artifacts.get(view.revision.artifactId);
    if (
      !record.ok ||
      record.value === null ||
      record.value.availability !== "available" ||
      record.value.digest !== view.revision.digest ||
      record.value.byteLength !== view.revision.byteLength ||
      record.value.mediaType !== view.revision.mediaType ||
      record.value.invocationId !== view.revision.invocationId
    ) {
      return err(failure("artifact-unavailable"));
    }
    const range = await options.artifacts.readRange(
      view.revision.artifactId,
      0,
      view.revision.byteLength,
      signal,
    );
    if (!range.ok || range.value.byteLength !== view.revision.byteLength) {
      return err(failure("artifact-unavailable"));
    }
    return ok(range.value.bytes);
  };

  return {
    async write(input, signal) {
      if (signal?.aborted === true) return err(failure("cancelled"));
      const name = parseScratchName(input.name);
      const mediaType = parseScratchMediaType(input.mediaType ?? "text/plain");
      if (typeof input.text !== "string") return err(failure("malformed-input"));
      const bytes = validateScratchText(input.text);
      if (!name.ok) return err(failure("malformed-input"));
      if (!mediaType.ok) return err(failure("unsupported-media-type"));
      if (!bytes.ok) return err(failure("oversize"));
      const expected =
        input.expectedRevision === undefined ? null : scratchRevision(input.expectedRevision);
      if (expected !== null && !expected.ok) return err(failure("malformed-input"));
      const current = options.repository.get(input.sessionId, name.value);
      if (!current.ok && current.error.code !== "discarded") {
        return err(repositoryFailure(current.error.code));
      }
      if (!current.ok || (current.value === null) !== (expected === null)) {
        return err(current.ok ? failure("conflict") : repositoryFailure(current.error.code));
      }
      if (
        current.ok &&
        current.value !== null &&
        (expected === null || current.value.resource.currentRevision !== expected.value)
      ) {
        return err(failure("conflict"));
      }
      const revision = scratchRevision(
        current.ok && current.value !== null ? current.value.resource.currentRevision + 1 : 1,
      );
      if (!revision.ok) return err(failure("malformed-storage"));
      const now = options.clock.now();
      const ingested = await options.artifacts.ingest(
        {
          artifactId: nextArtifactId(),
          mediaType: mediaType.value,
          encoding: "identity",
          sensitivity: "user-content",
          origin: "model-output",
          invocationId: input.invocationId,
          declaredByteLength: bytes.value.byteLength,
          content: oneChunk(bytes.value),
        },
        signal,
      );
      if (!ingested.ok) {
        return err(
          failure(ingested.error.code === "cancelled" ? "cancelled" : "artifact-unavailable"),
        );
      }
      const published = options.repository.publish({
        sessionId: input.sessionId,
        name: name.value,
        expectedRevision: expected?.value ?? null,
        revision: {
          sessionId: input.sessionId,
          name: name.value,
          revision: revision.value,
          artifactId: ingested.value.record.artifactId,
          digest: ingested.value.record.digest,
          mediaType: mediaType.value,
          byteLength: bytes.value.byteLength,
          invocationId: input.invocationId,
          createdAt: now,
        },
      });
      return published.ok
        ? ok(metadata(published.value))
        : err(repositoryFailure(published.error.code));
    },
    async read(session, handle, revision, signal) {
      const resolved = resolve(session, handle, revision);
      if (!resolved.ok) return resolved;
      const bytes = await exactBytes(resolved.value, MAX_SCRATCH_TEXT_BYTES, signal);
      if (!bytes.ok) return bytes;
      try {
        return ok({
          ...metadata(resolved.value),
          text: new TextDecoder("utf-8", { fatal: true }).decode(bytes.value),
        });
      } catch {
        return err(failure("artifact-unavailable"));
      }
    },
    list(session, limit = MAX_SCRATCH_LIST_LIMIT) {
      const parsedLimit = parseScratchListLimit(limit);
      if (!parsedLimit.ok) return err(failure("malformed-input"));
      const listed = options.repository.list(session, parsedLimit.value);
      return listed.ok ? ok(listed.value.map(metadata)) : err(repositoryFailure(listed.error.code));
    },
    discard(session, handle, expectedRevision, signal) {
      const parsed = parseScratchHandle(handle, session);
      const revision = scratchRevision(expectedRevision);
      if (!parsed.ok) {
        return err(
          failure(parsed.error.code === "cross-session" ? "cross-session" : "malformed-handle"),
        );
      }
      if (!revision.ok) return err(failure("malformed-input"));
      const discarded = options.repository.discard(
        session,
        parsed.value.name,
        revision.value,
        options.clock.now(),
        signal,
      );
      if (!discarded.ok) return err(repositoryFailure(discarded.error.code));
      return ok(metadata(discarded.value));
    },
    async readBytes(session, handle, revision, maximumBytes, signal) {
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
        return err(failure("malformed-input"));
      }
      const resolved = resolve(session, handle, revision);
      return resolved.ok ? exactBytes(resolved.value, maximumBytes, signal) : resolved;
    },
  };
}
