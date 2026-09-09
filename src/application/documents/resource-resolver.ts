/** Resolve source owners and retain revision evidence through the existing artifact store. */
import { createHash, randomUUID } from "node:crypto";
import { type ArtifactStorePort, artifactId } from "../../domain/artifacts/index.ts";
import {
  MAX_RESOURCE_SOURCE_BYTES,
  type ResourceEvidence,
  type ResourceFailure,
  type ResourceReadItem,
  type ResourceReadResult,
  type ResourceTarget,
  resourceEvidenceSchema,
  resourceReadInputSchema,
} from "../../domain/documents/resource-read.ts";
import {
  parseVirtualResourceSource,
  type VirtualResourcePort,
} from "../../domain/documents/virtual-resource-read.ts";
import type { Result, SessionId } from "../../domain/foundation/index.ts";
import type { LocalPath } from "../../domain/workspace/index.ts";
import type { ScratchResourcePort } from "../artifacts/scratch-resources.ts";
import type { LoomPort } from "../compression/loom.ts";
import type { WorkspaceReader } from "../workspace/workspace-read.ts";
import { projectResource } from "./resource-projection.ts";
import {
  createResourceRetention,
  RESOURCE_REFERENCE_MEDIA as REFERENCE_MEDIA,
  resourceDigest,
} from "./resource-retention.ts";

export { resourceDigest } from "./resource-retention.ts";

const encoder = new TextEncoder();
function failure(code: string) {
  return { ok: false as const, error: { code } };
}
type LoadedSource = {
  readonly metadata: Omit<ResourceEvidence, "coverage" | "fidelity">;
  readonly bytes: Uint8Array;
  readonly currentness: "current" | "historical";
};
export type ResourceResolverOptions = {
  readonly reader: WorkspaceReader;
  readonly artifacts?: ArtifactStorePort;
  readonly scratch?: ScratchResourcePort;
  readonly loom?: LoomPort;
  readonly workspaceRoot: LocalPath;
  readonly workspaceId: string;
  readonly sessionId: SessionId;
  readonly generation: string;
  /** Host-owned authorization on every use; no model input can supply this port. */
  readonly virtual?: {
    readonly reader: VirtualResourcePort;
    authorize(
      uri: string,
      scope: { workspaceId: string; sessionId: string; generation: string },
      signal?: AbortSignal,
    ): Promise<
      Result<{ sensitivity: "public" | "user-content"; generation: string }, ResourceFailure>
    >;
  };
};
export type ResourceResolver = {
  read(input: unknown, signal?: AbortSignal): Promise<Result<ResourceReadResult, ResourceFailure>>;
  /** Trusted host selection, never exposed as model authorization. */
  retainSelection(
    identity: string,
    bytes: Uint8Array,
    mediaType: string,
    signal?: AbortSignal,
  ): Promise<Result<ResourceTarget, ResourceFailure>>;
  selectArtifact(
    id: string,
    signal?: AbortSignal,
  ): Promise<Result<ResourceTarget, ResourceFailure>>;
};

export function createResourceResolver(options: ResourceResolverOptions): ResourceResolver {
  const scope = {
    version: 1 as const,
    workspaceId: options.workspaceId,
    sessionId: String(options.sessionId),
    root: String(options.workspaceRoot),
    generation: options.generation,
  };
  const store = options.artifacts;
  const { ingest, artifactBytes, reference } = createResourceRetention(store);
  const load = async (
    target: ResourceTarget,
    signal?: AbortSignal,
  ): Promise<Result<LoadedSource, ResourceFailure>> => {
    if (signal?.aborted) return failure("cancelled");
    if (target.kind === "virtual") {
      if (!options.virtual) return failure("unsupported-resource-host");
      const policy = await options.virtual.authorize(target.uri, scope, signal);
      if (!policy.ok) return policy;
      if (policy.value.generation !== scope.generation) return failure("policy-changed");
      const described = await options.virtual.reader.describe(target.uri, signal);
      if (!described.ok) return described;
      const source = parseVirtualResourceSource(described.value);
      if (!source.ok) return source;
      if (source.value.uri !== target.uri) return failure("resource-identity-mismatch");
      if (!source.value.exactBytes || source.value.digest === null)
        return failure("exact-bytes-unavailable");
      if (source.value.byteLength > MAX_RESOURCE_SOURCE_BYTES) return failure("source-limit");
      const bytes = await options.virtual.reader.readRange(
        target.uri,
        0,
        source.value.byteLength,
        signal,
      );
      if (!bytes.ok) return bytes;
      const rechecked = await options.virtual.authorize(target.uri, scope, signal);
      if (!rechecked.ok) return rechecked;
      if (rechecked.value.generation !== policy.value.generation) return failure("policy-changed");
      if (
        bytes.value.length !== source.value.byteLength ||
        resourceDigest(bytes.value) !== source.value.digest
      )
        return failure("corrupt");
      const id = `resource-source-${randomUUID()}`;
      const saved = await ingest(id, bytes.value, source.value.mediaType, signal);
      if (!saved.ok) return saved;
      return {
        ok: true,
        value: {
          bytes: bytes.value,
          currentness: "current",
          metadata: {
            ...scope,
            target,
            sourceIdentity: source.value.uri,
            revision: source.value.digest,
            digest: source.value.digest,
            artifactId: id,
            byteLength: bytes.value.length,
            mediaType: source.value.mediaType,
            sensitivity: policy.value.sensitivity,
            trust: "adapter-declared",
          },
        },
      };
    }
    if (target.kind === "evidence") {
      if (!target.reference.startsWith("resource-evidence-")) return failure("invalid-reference");
      const retained = await artifactBytes(target.reference, signal);
      if (!retained.ok) return retained;
      if (retained.value.record.mediaType !== REFERENCE_MEDIA) return failure("invalid-reference");
      let decoded: unknown;
      try {
        decoded = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(retained.value.bytes),
        );
      } catch {
        return failure("corrupt");
      }
      const parsed = resourceEvidenceSchema.safeParse(decoded);
      if (!parsed.success) return failure("invalid-reference");
      const evidence = parsed.data;
      if (
        evidence.workspaceId !== scope.workspaceId ||
        evidence.sessionId !== scope.sessionId ||
        evidence.root !== scope.root
      )
        return failure("wrong-scope");
      if (evidence.generation !== scope.generation) return failure("policy-changed");
      if (evidence.target.kind === "evidence") return failure("invalid-reference");
      // Revalidate the live owner even though retained bytes have their own lifetime.
      let currentness: "current" | "historical" = "current";
      if (evidence.target.kind === "workspace") {
        const current = await options.reader.readBytes(
          options.workspaceRoot,
          evidence.target.path,
          { maxFileBytes: MAX_RESOURCE_SOURCE_BYTES, maxExpansionBytes: MAX_RESOURCE_SOURCE_BYTES },
          signal,
        );
        if (!current.ok) return failure(current.error.code);
        if (current.value.sourceIdentity !== evidence.sourceIdentity)
          return failure("root-rebound");
        if (
          current.value.revision !== evidence.revision ||
          current.value.digest !== evidence.digest
        )
          currentness = "historical";
      } else if (evidence.target.kind === "scratch") {
        if (!options.scratch) return failure("unsupported-resource-host");
        const current = await options.scratch.read(
          options.sessionId,
          evidence.target.handle,
          evidence.target.revision,
          signal,
        );
        if (!current.ok) return failure(current.error.code);
        if (
          current.value.digest !== evidence.digest ||
          resourceDigest(encoder.encode(current.value.text)) !== evidence.digest
        )
          return failure("stale");
        return {
          ok: true,
          value: { metadata: evidence, bytes: encoder.encode(current.value.text), currentness },
        };
      } else if (evidence.target.kind === "virtual") {
        if (!options.virtual) return failure("unsupported-resource-host");
        const policy = await options.virtual.authorize(evidence.target.uri, scope, signal);
        if (!policy.ok) return policy;
        if (policy.value.generation !== scope.generation) return failure("policy-changed");
        const described = await options.virtual.reader.describe(evidence.target.uri, signal);
        if (!described.ok) return described;
        const current = parseVirtualResourceSource(described.value);
        if (!current.ok) return current;
        if (current.value.uri !== evidence.sourceIdentity)
          return failure("resource-identity-mismatch");
        if (current.value.digest !== evidence.digest) currentness = "historical";
      } else {
        const manifest = options.loom?.get(evidence.target.manifestId);
        if (
          !manifest ||
          manifest.workspaceId !== scope.workspaceId ||
          manifest.sessionId !== scope.sessionId ||
          !manifest.members.some((m) => m.artifactId === evidence.artifactId)
        )
          return failure("denied");
        const admitted = await options.loom?.retrieve(
          {
            id: `resource-policy-${randomUUID()}`,
            manifestId: evidence.target.manifestId,
            expectedWorkspaceId: scope.workspaceId,
            expectedSessionId: scope.sessionId,
            generation: scope.generation,
            projection: {
              kind: "range",
              member: evidence.artifactId,
              offset: 0,
              length: 0,
              maxBytes: 1,
            },
          },
          signal,
        );
        if (!admitted?.ok) return failure("expired");
      }
      if (evidence.artifactId === null) return failure("invalid-reference");
      const source = await artifactBytes(evidence.artifactId, signal);
      if (!source.ok) return source;
      if (
        source.value.record.digest !== evidence.digest ||
        source.value.record.byteLength !== evidence.byteLength
      )
        return failure("corrupt");
      return { ok: true, value: { metadata: evidence, bytes: source.value.bytes, currentness } };
    }
    if (target.kind === "workspace") {
      if (target.root !== undefined && target.root !== scope.root) return failure("wrong-root");
      const read = await options.reader.readBytes(
        options.workspaceRoot,
        target.path,
        { maxFileBytes: MAX_RESOURCE_SOURCE_BYTES, maxExpansionBytes: MAX_RESOURCE_SOURCE_BYTES },
        signal,
      );
      if (!read.ok) return failure(read.error.code);
      if (read.value.completeness !== "complete") return failure("source-limit");
      const bytes = read.value.bytes;
      const digest = resourceDigest(bytes);
      if (digest !== read.value.digest) return failure("corrupt");
      const id = `resource-source-${createHash("sha256")
        .update(JSON.stringify([scope, read.value.sourceIdentity, read.value.revision, digest]))
        .digest("hex")
        .slice(0, 48)}`;
      const existing = store?.get(artifactId.from(id));
      if (!existing?.ok || existing.value === null) {
        const retained = await ingest(id, bytes, "text/plain", signal);
        if (!retained.ok) return retained;
      }
      const retained = await artifactBytes(id, signal);
      if (!retained.ok) return retained;
      if (retained.value.record.digest !== digest) return failure("corrupt");
      return {
        ok: true,
        value: {
          bytes,
          currentness: "current",
          metadata: {
            ...scope,
            target,
            sourceIdentity: read.value.sourceIdentity,
            revision: read.value.revision,
            digest,
            artifactId: id,
            byteLength: bytes.length,
            mediaType: "text/plain",
            sensitivity: "user-content",
            trust: "user-confirmed",
          },
        },
      };
    }
    if (target.kind === "scratch") {
      if (!options.scratch) return failure("unsupported-resource-host");
      const read = await options.scratch.read(
        options.sessionId,
        target.handle,
        target.revision,
        signal,
      );
      if (!read.ok) return failure(read.error.code);
      const bytes = encoder.encode(read.value.text);
      if (resourceDigest(bytes) !== read.value.digest) return failure("corrupt");
      // Scratch owns its artifact identity. Expose its exact revision without a second payload.
      return {
        ok: true,
        value: {
          bytes,
          currentness: "current",
          metadata: {
            ...scope,
            target: { ...target, revision: read.value.revision },
            sourceIdentity: read.value.handle,
            revision: String(read.value.revision),
            digest: read.value.digest,
            artifactId: null,
            byteLength: bytes.length,
            mediaType: read.value.mediaType,
            sensitivity: "user-content",
            trust: "user-confirmed",
          },
        },
      };
    }
    const manifest = options.loom?.get(target.manifestId);
    if (
      !manifest ||
      manifest.workspaceId !== scope.workspaceId ||
      manifest.sessionId !== scope.sessionId ||
      !manifest.members.some((m) => m.artifactId === target.artifactId)
    )
      return failure("denied");
    const admitted = await options.loom?.retrieve(
      {
        id: `resource-policy-${randomUUID()}`,
        manifestId: target.manifestId,
        expectedWorkspaceId: scope.workspaceId,
        expectedSessionId: scope.sessionId,
        generation: scope.generation,
        projection: { kind: "range", member: target.artifactId, offset: 0, length: 0, maxBytes: 1 },
      },
      signal,
    );
    if (!admitted?.ok) return failure("expired");
    const loaded = await artifactBytes(target.artifactId, signal);
    if (!loaded.ok) return loaded;
    const { record, bytes } = loaded.value;
    if (record.mediaType === REFERENCE_MEDIA) return failure("unsupported-media");
    return {
      ok: true,
      value: {
        bytes,
        currentness: "current",
        metadata: {
          ...scope,
          target,
          sourceIdentity: target.artifactId,
          revision: record.digest,
          digest: record.digest,
          artifactId: target.artifactId,
          byteLength: record.byteLength,
          mediaType: record.mediaType,
          sensitivity: record.sensitivity,
          trust: "adapter-declared",
        },
      },
    };
  };
  const adoptArtifact = async (
    id: string,
    sourceIdentity: string,
    signal?: AbortSignal,
  ): Promise<Result<ResourceTarget, ResourceFailure>> => {
    if (!options.loom) return failure("retention-unavailable");
    const loaded = await artifactBytes(id, signal);
    if (!loaded.ok) return loaded;
    const manifestId = `resource-selection-${randomUUID()}`;
    const adopted = await options.loom.adopt(
      {
        id: manifestId,
        workspaceId: scope.workspaceId,
        sessionId: scope.sessionId,
        generation: scope.generation,
        members: [{ artifactId: id, summary: sourceIdentity }],
      },
      signal,
    );
    return adopted.ok
      ? { ok: true, value: { kind: "artifact", artifactId: id, manifestId } }
      : failure(adopted.error.code);
  };
  return {
    selectArtifact: (id, signal) => adoptArtifact(id, id, signal),
    async retainSelection(identity, bytes, mediaType, signal) {
      if (bytes.length > MAX_RESOURCE_SOURCE_BYTES || identity.length > 2048)
        return failure("source-limit");
      const id = `resource-selection-${randomUUID()}`;
      const saved = await ingest(id, bytes, mediaType, signal);
      return saved.ok ? adoptArtifact(id, identity, signal) : saved;
    },
    async read(input, signal) {
      const parsed = resourceReadInputSchema.safeParse(input);
      if (!parsed.success) return failure("malformed-input");
      const items: ResourceReadItem[] = [];
      let aggregateBytes = 0;
      for (const target of parsed.data.resources) {
        const unavailable = (code: string): void => {
          items.push({ status: "unavailable", target, code, reacquisition: "new-read-required" });
        };
        if (signal?.aborted) {
          unavailable("cancelled");
          continue;
        }
        if (aggregateBytes >= parsed.data.maxBytes) {
          unavailable("aggregate-limit");
          continue;
        }
        const loaded = await load(target, signal);
        if (!loaded.ok) {
          unavailable(loaded.error.code);
          continue;
        }
        if (!/^(?:text\/|application\/(?:json|xml)$)/u.test(loaded.value.metadata.mediaType)) {
          unavailable("unsupported-media");
          continue;
        }
        const projected = projectResource(
          loaded.value.bytes,
          parsed.data.projection,
          parsed.data.maxBytes - aggregateBytes,
        );
        if (!projected.ok) {
          unavailable(projected.error.code);
          continue;
        }
        if (signal?.aborted) {
          unavailable("cancelled");
          continue;
        }
        const source: ResourceEvidence = {
          ...loaded.value.metadata,
          coverage: projected.value.segments.map(({ offset, length }) => ({ offset, length })),
          fidelity: projected.value.fidelity,
        };
        const retained = await reference(source, signal);
        if (!retained.ok) {
          unavailable(retained.error.code);
          continue;
        }
        aggregateBytes += projected.value.used;
        const last = projected.value.segments.at(-1);
        items.push({
          status: "read",
          target,
          source,
          reference: retained.value,
          segments: projected.value.segments,
          complete: projected.value.complete,
          omissions: projected.value.omissions,
          currentness: loaded.value.currentness,
          writable: false,
          continuation: projected.value.complete
            ? null
            : {
                target: retained.value,
                offset: last === undefined ? 0 : last.offset + last.length,
              },
        });
      }
      return {
        ok: true,
        value: {
          items,
          aggregateBytes,
          consistency: "per-resource",
          complete: items.every((item) => item.status === "read" && item.complete),
        },
      };
    },
  };
}
