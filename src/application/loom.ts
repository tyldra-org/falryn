/**
 * Application boundary for Loom compress-cache-retrieve (#104).
 *
 * Ingests member bytes through ArtifactStorePort, commits a reversible
 * manifest only when every required member is stored, then retrieves a
 * verified projection. Redacted text never claims exact source. Does not
 * register product tools or implement compact-model / history checkpoint lanes.
 */

import { createHash } from "node:crypto";

import {
  type ArtifactEncoding,
  type ArtifactError,
  type ArtifactIngestRequest,
  type ArtifactOrigin,
  type ArtifactSensitivity,
  type ArtifactStorePort,
  admitEvidenceCandidate,
  artifactId,
  CONTENT_DIGEST_ALGORITHM,
  type ContentDigest,
  type ContentHasherPort,
  commitLoomManifest,
  completeLoomRetrieval,
  contentDigest,
  createLoomCache,
  DEFAULT_LOOM_STRATEGY,
  type EvidenceAdmissionError,
  type EvidenceCandidate,
  type EvidenceCandidateInput,
  err,
  type LoomArtifactReadPlan,
  type LoomCache,
  type LoomError,
  type LoomInvalidation,
  type LoomManifest,
  type LoomProjectionResult,
  type LoomProjectionSource,
  type LoomRetrieveInput,
  ok,
  planLoomRetrieval,
  type Result,
  timestampFromEpochMilliseconds,
} from "../domain/index.ts";
import { containsRedactableSecret, redactText } from "./redaction.ts";

export type LoomIngestMember = {
  readonly artifactId: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly encoding?: ArtifactEncoding;
  readonly sensitivity: ArtifactSensitivity;
  readonly origin?: ArtifactOrigin;
  readonly required?: boolean;
  readonly protectedFacts?: readonly string[];
  readonly summary?: string;
};

export type LoomIngestRequest = {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly members: readonly LoomIngestMember[];
  readonly generation?: string;
  readonly retentionUntil?: string;
  readonly invocationId?: string | null;
};

export type LoomRetrieveRequest = {
  readonly id: string;
  readonly manifestId: string;
  readonly expectedWorkspaceId: string;
  readonly expectedSessionId: string;
  readonly projection: unknown;
  readonly destination?: string;
  readonly generation?: string;
  readonly strategyVersion?: string;
  readonly configuration?: string;
  readonly freshness?: string;
  readonly now?: string;
};

export type LoomIngestResult = {
  readonly manifest: LoomManifest;
};

export type LoomPortError =
  | LoomError
  | ArtifactError
  | EvidenceAdmissionError
  | {
      readonly kind: "loom-port";
      readonly code: "cancelled" | "unavailable" | "secret";
      readonly field: "signal" | "manifest" | "member" | "projection";
    };

export type LoomPort = {
  ingest(
    request: LoomIngestRequest,
    signal?: AbortSignal,
  ): Promise<Result<LoomIngestResult, LoomPortError>>;
  retrieve(
    request: LoomRetrieveRequest,
    signal?: AbortSignal,
  ): Promise<Result<LoomProjectionResult, LoomPortError>>;
  get(id: string): LoomManifest | null;
  invalidate(filter: LoomInvalidation): number;
};

export type LoomPortOptions = {
  readonly artifacts: ArtifactStorePort;
  readonly hasher?: ContentHasherPort;
  readonly cache?: LoomCache;
};

export type LoomEvidenceRequest = {
  readonly projection: LoomProjectionResult;
  readonly workspaceId?: string;
  readonly scopeId?: string;
};

function createSha256Hasher(): ContentHasherPort {
  return {
    create() {
      const hash = createHash("sha256");
      return {
        update(chunk) {
          hash.update(chunk);
        },
        digest() {
          return contentDigest.from(`${CONTENT_DIGEST_ALGORITHM}:${hash.digest("hex")}`);
        },
      };
    },
  };
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function cancelled(field: "signal"): LoomPortError {
  return { kind: "loom-port", code: "cancelled", field };
}

function applyRedaction(result: LoomProjectionResult): Result<LoomProjectionResult, LoomPortError> {
  if (!containsRedactableSecret(result.text)) {
    return ok(result);
  }
  return ok({
    ...result,
    text: redactText(result.text),
    fidelity: "deterministic-transform",
    complete: false,
    claimsExact: false,
    exactSource: null,
    lineage: [...result.lineage, "redacted"],
  });
}

function malformed(field: string): LoomError {
  return { kind: "loom", code: "malformed", field };
}

async function readPlannedBytes(
  artifacts: ArtifactStorePort,
  artifactIdValue: ReturnType<typeof artifactId.from>,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Result<Uint8Array, LoomPortError>> {
  if (isAborted(signal)) {
    return err(cancelled("signal"));
  }
  if (length === 0) {
    return ok(new Uint8Array());
  }
  const range = await artifacts.readRange(artifactIdValue, offset, length, signal);
  return range.ok ? ok(range.value.bytes) : range;
}

async function readProjectionSource(
  artifacts: ArtifactStorePort,
  plan: LoomArtifactReadPlan,
  signal?: AbortSignal,
): Promise<Result<LoomProjectionSource, LoomPortError>> {
  switch (plan.kind) {
    case "complete": {
      const bytes = await readPlannedBytes(
        artifacts,
        plan.artifactId,
        plan.offset,
        plan.length,
        signal,
      );
      return bytes.ok
        ? ok({ kind: "complete", artifactId: plan.artifactId, bytes: bytes.value })
        : bytes;
    }
    case "range": {
      const bytes = await readPlannedBytes(
        artifacts,
        plan.artifactId,
        plan.offset,
        plan.length,
        signal,
      );
      return bytes.ok
        ? ok({
            kind: "range",
            artifactId: plan.artifactId,
            offset: plan.offset,
            bytes: bytes.value,
          })
        : bytes;
    }
    case "head-tail": {
      const head = await readPlannedBytes(
        artifacts,
        plan.artifactId,
        plan.headOffset,
        plan.headLength,
        signal,
      );
      if (!head.ok) {
        return head;
      }
      const tail = await readPlannedBytes(
        artifacts,
        plan.artifactId,
        plan.tailOffset,
        plan.tailLength,
        signal,
      );
      return tail.ok
        ? ok({
            kind: "head-tail",
            artifactId: plan.artifactId,
            headOffset: plan.headOffset,
            headBytes: head.value,
            tailOffset: plan.tailOffset,
            tailBytes: tail.value,
          })
        : tail;
    }
  }
}

export function createLoomPort(options: LoomPortOptions): LoomPort {
  const hasher = options.hasher ?? createSha256Hasher();
  const cache = options.cache ?? createLoomCache();
  const manifests = new Map<string, LoomManifest>();

  return {
    async ingest(request, signal) {
      if (isAborted(signal)) {
        return err(cancelled("signal"));
      }
      const committedMembers: Array<{
        artifactId: string;
        digest: ContentDigest;
        byteLength: number;
        mediaType: string;
        encoding: ArtifactEncoding;
        sensitivity: ArtifactSensitivity;
        availability: "available";
        required: boolean;
        protectedFacts: readonly string[];
        summary: string | null;
      }> = [];
      for (const member of request.members) {
        if (isAborted(signal)) {
          return err(cancelled("signal"));
        }
        const required = member.required !== false;
        const id = artifactId.parse(member.artifactId);
        if (!id.ok) {
          if (required) {
            return err(malformed("artifactId"));
          }
          continue;
        }
        const ingestRequest: ArtifactIngestRequest = {
          artifactId: id.value,
          mediaType: member.mediaType,
          encoding: member.encoding ?? "identity",
          sensitivity: member.sensitivity,
          origin: member.origin ?? "capture",
          invocationId: null,
          declaredByteLength: member.bytes.byteLength,
          content: oneChunk(member.bytes),
        };
        const ingested = await options.artifacts.ingest(ingestRequest, signal);
        if (!ingested.ok) {
          if (required) {
            return ingested;
          }
          continue;
        }
        const facts = member.protectedFacts ?? [];
        committedMembers.push({
          artifactId: ingested.value.record.artifactId,
          digest: ingested.value.record.digest,
          byteLength: ingested.value.record.byteLength,
          mediaType: ingested.value.record.mediaType,
          encoding: ingested.value.record.encoding,
          sensitivity: ingested.value.record.sensitivity,
          availability: "available",
          required,
          protectedFacts: facts,
          summary: member.summary ?? null,
        });
      }
      const commitInput: {
        id: string;
        workspaceId: string;
        sessionId: string;
        members: typeof committedMembers;
        generation?: string;
        retentionUntil?: string;
      } = {
        id: request.id,
        workspaceId: request.workspaceId,
        sessionId: request.sessionId,
        members: committedMembers,
      };
      if (request.generation !== undefined) {
        commitInput.generation = request.generation;
      }
      if (request.retentionUntil !== undefined) {
        commitInput.retentionUntil = request.retentionUntil;
      }
      const committed = commitLoomManifest(commitInput);
      if (!committed.ok) {
        return committed;
      }
      manifests.set(committed.value.id, committed.value);
      return ok({ manifest: committed.value });
    },

    async retrieve(request, signal) {
      if (isAborted(signal)) {
        return err(cancelled("signal"));
      }
      const manifest = manifests.get(request.manifestId);
      if (manifest === undefined) {
        return err({ kind: "loom-port", code: "unavailable", field: "manifest" });
      }
      const members: LoomRetrieveInput["members"][number][] = [];
      for (const member of manifest.members) {
        if (isAborted(signal)) {
          return err(cancelled("signal"));
        }
        const record = options.artifacts.get(member.artifactId);
        if (!record.ok || record.value === null) {
          members.push({ artifactId: member.artifactId, bytes: null, availability: "missing" });
          continue;
        }
        members.push({
          artifactId: member.artifactId,
          availability: record.value.availability,
          digest: record.value.digest,
          byteLength: record.value.byteLength,
        });
      }
      const retrieveInput: LoomRetrieveInput = {
        id: request.id,
        freshness: request.freshness ?? "live",
        manifest,
        expectedWorkspaceId: request.expectedWorkspaceId,
        expectedSessionId: request.expectedSessionId,
        members,
        projection: request.projection,
        destination: request.destination ?? "local",
        strategyVersion: request.strategyVersion ?? DEFAULT_LOOM_STRATEGY,
        configuration: request.configuration ?? "",
        now: request.now ?? timestampFromEpochMilliseconds(Date.now()),
        ...(request.generation === undefined ? {} : { generation: request.generation }),
      };
      const planned = planLoomRetrieval(retrieveInput, cache);
      if (!planned.ok) {
        return planned;
      }
      if (planned.value.cached !== null) {
        return applyRedaction(planned.value.cached);
      }
      const source = await readProjectionSource(options.artifacts, planned.value.read, signal);
      if (!source.ok) {
        return source;
      }
      if (isAborted(signal)) {
        return err(cancelled("signal"));
      }
      const retrieved = completeLoomRetrieval(planned.value, source.value, hasher, cache);
      if (!retrieved.ok) {
        return retrieved;
      }
      return applyRedaction(retrieved.value);
    },

    get(id) {
      return manifests.get(id) ?? null;
    },

    invalidate(filter) {
      return cache.invalidate(filter);
    },
  };
}

export function loomProjectionToEvidence(
  request: LoomEvidenceRequest,
): Result<EvidenceCandidate, LoomPortError> {
  const projection = request.projection;
  const exactHandle = projection.exactSource;
  const payload: EvidenceCandidateInput["payload"] =
    projection.claimsExact && exactHandle !== null && exactHandle.kind === "artifact"
      ? {
          kind: "artifact",
          artifactId: exactHandle.artifactId,
          digest: exactHandle.digest,
          byteLength: exactHandle.byteLength,
        }
      : { kind: "inline", text: projection.text };
  return admitEvidenceCandidate({
    id: projection.id,
    sourceKind: "artifact",
    origin: `loom:${projection.manifestId}`,
    payload,
    estimatedTokens: Math.max(1, Math.ceil(projection.byteLength / 4)),
    freshness: projection.freshness,
    sensitivity: "user-content",
    trust: "adapter-declared",
    fidelity: projection.claimsExact ? "exact-source" : projection.fidelity,
    retrievalCost: 1,
    expansion: projection.expansion,
    ...(projection.claimsExact ? {} : { lineage: projection.lineage }),
    ...(request.workspaceId === undefined ? {} : { workspaceId: request.workspaceId }),
    ...(request.scopeId === undefined ? {} : { scopeId: request.scopeId }),
    ...(exactHandle === null ? {} : { exactSource: exactHandle }),
  });
}
