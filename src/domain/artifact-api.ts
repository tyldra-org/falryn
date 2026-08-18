/**
 * Typed artifact API, provenance graph, integrity, and lifecycle (#116).
 *
 * The store already ingests, verifies, finalizes, quarantines, and reads
 * bytes. This boundary is the missing public surface: a record plus its
 * parent transformations, an integrity answer that never mutates, and
 * lifecycle transitions that cannot rewrite a committed edge.
 *
 * Viewers now own encoding expansion. Export bundles, replay, crash recovery,
 * and retention remain later children of #115.
 */

import { z } from "zod";

import {
  type ArtifactError,
  type ArtifactId,
  type ArtifactRecord,
  type ArtifactWrite,
  artifactId,
} from "./artifact.ts";
import { brandedString, timestampSchema } from "./branded-schema.ts";
import { err, ok, type Result } from "./result.ts";
import type { Timestamp } from "./time.ts";

export const ARTIFACT_API_VERSION = "artifact-api.v1";
export const MAX_ARTIFACT_PARENTS = 8;
export const MAX_ARTIFACT_LINEAGE_DEPTH = 16;

/**
 * How a child relates to a parent.
 *
 * Provenance the producer states, never inferred from media type. Encoding is
 * still never applied here: `extracted-from` means a subset of parent bytes
 * or metadata, not a decode this store performed.
 */
export const ARTIFACT_TRANSFORMATIONS = ["derived-from", "extracted-from", "copied-from"] as const;

export type ArtifactTransformation = (typeof ARTIFACT_TRANSFORMATIONS)[number];

export type ArtifactProvenanceEdge = {
  readonly schemaVersion: typeof ARTIFACT_API_VERSION;
  readonly childArtifactId: ArtifactId;
  readonly parentArtifactId: ArtifactId;
  readonly transformation: ArtifactTransformation;
  readonly createdAt: Timestamp;
};

export type ArtifactLineage = {
  readonly schemaVersion: typeof ARTIFACT_API_VERSION;
  readonly artifactId: ArtifactId;
  readonly record: ArtifactRecord;
  readonly parents: readonly ArtifactProvenanceEdge[];
  readonly children: readonly ArtifactProvenanceEdge[];
};

export type ArtifactIntegrityReport = {
  readonly schemaVersion: typeof ARTIFACT_API_VERSION;
  readonly artifactId: ArtifactId;
  readonly availability: ArtifactRecord["availability"];
  /** Whether stored bytes still hash to the recorded digest. */
  readonly intact: boolean;
};

export type ArtifactApiError = ArtifactError | ArtifactProvenanceError;

export type ArtifactProvenanceError = {
  readonly kind: "artifact-api";
  readonly code:
    | "self-parent"
    | "cycle"
    | "missing-parent"
    | "missing-child"
    | "too-many-parents"
    | "already-linked"
    | "unavailable"
    | "malformed"
    | "cancelled";
  readonly artifactId: ArtifactId | null;
  readonly field: string | null;
};

export type ArtifactLinkRequest = {
  readonly childArtifactId: ArtifactId;
  readonly parentArtifactId: ArtifactId;
  readonly transformation: ArtifactTransformation;
  readonly createdAt: Timestamp;
};

export type ArtifactProvenancePort = {
  listParents(id: ArtifactId): Result<readonly ArtifactProvenanceEdge[], ArtifactApiError>;
  listChildren(id: ArtifactId): Result<readonly ArtifactProvenanceEdge[], ArtifactApiError>;
  insert(
    edge: ArtifactProvenanceEdge,
    signal?: AbortSignal,
  ): Result<ArtifactWrite, ArtifactApiError>;
};

export type ArtifactApi = {
  /** Places a record in this API's lookup. Does not ingest bytes. */
  register(record: ArtifactRecord): Result<ArtifactWrite, ArtifactApiError>;
  describe(id: ArtifactId): Result<ArtifactLineage, ArtifactApiError>;
  link(request: ArtifactLinkRequest, signal?: AbortSignal): Result<ArtifactWrite, ArtifactApiError>;
  ancestors(
    id: ArtifactId,
    maximumDepth?: number,
  ): Result<readonly ArtifactProvenanceEdge[], ArtifactApiError>;
  descendants(
    id: ArtifactId,
    maximumDepth?: number,
  ): Result<readonly ArtifactProvenanceEdge[], ArtifactApiError>;
  /**
   * Reports whether a previously verified digest still matches.
   *
   * Does not quarantine, mark missing, or rewrite the record. Those
   * transitions belong to ingest, recovery, and retention owners.
   */
  reportIntegrity(
    id: ArtifactId,
    intact: boolean,
  ): Result<ArtifactIntegrityReport, ArtifactApiError>;
};

const transformationSchema = z.enum(ARTIFACT_TRANSFORMATIONS);

const edgeSchema = z.object({
  schemaVersion: z.literal(ARTIFACT_API_VERSION),
  childArtifactId: brandedString(artifactId),
  parentArtifactId: brandedString(artifactId),
  transformation: transformationSchema,
  createdAt: timestampSchema,
});

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function provenanceError(
  code: ArtifactProvenanceError["code"],
  artifactIdValue: ArtifactId | null,
  field: string | null,
): ArtifactProvenanceError {
  return { kind: "artifact-api", code, artifactId: artifactIdValue, field };
}

function writeOk(): ArtifactWrite {
  return { cancelledAfterCommit: false };
}

export function isArtifactTransformation(value: unknown): value is ArtifactTransformation {
  return (
    typeof value === "string" && (ARTIFACT_TRANSFORMATIONS as readonly string[]).includes(value)
  );
}

export function parseArtifactProvenanceEdge(
  value: unknown,
): Result<ArtifactProvenanceEdge, ArtifactProvenanceError> {
  const parsed = edgeSchema.safeParse(value);
  if (!parsed.success) {
    return err(provenanceError("malformed", null, "edge"));
  }
  if (parsed.data.childArtifactId === parsed.data.parentArtifactId) {
    return err(provenanceError("self-parent", parsed.data.childArtifactId, "parentArtifactId"));
  }
  return ok(parsed.data);
}

function edgeKey(edge: ArtifactProvenanceEdge): string {
  return `${edge.childArtifactId}\0${edge.parentArtifactId}\0${edge.transformation}`;
}

export function walkArtifactLineage(
  start: ArtifactId,
  neighbors: (id: ArtifactId) => Result<readonly ArtifactProvenanceEdge[], ArtifactApiError>,
  pick: (edge: ArtifactProvenanceEdge) => ArtifactId,
  maximumDepth: number,
): Result<readonly ArtifactProvenanceEdge[], ArtifactApiError> {
  if (!Number.isSafeInteger(maximumDepth) || maximumDepth < 1) {
    return err(provenanceError("unavailable", start, "maximumDepth"));
  }
  const bounded = Math.min(maximumDepth, MAX_ARTIFACT_LINEAGE_DEPTH);
  const out: ArtifactProvenanceEdge[] = [];
  const seen = new Set<ArtifactId>([start]);
  let frontier: ArtifactId[] = [start];
  for (let depth = 0; depth < bounded; depth += 1) {
    const next: ArtifactId[] = [];
    for (const id of frontier) {
      const listed = neighbors(id);
      if (!listed.ok) {
        return listed;
      }
      for (const edge of listed.value) {
        const other = pick(edge);
        out.push(edge);
        if (!seen.has(other)) {
          seen.add(other);
          next.push(other);
        }
      }
    }
    if (next.length === 0) {
      break;
    }
    frontier = next;
  }
  return ok(out);
}

function wouldCycle(
  child: ArtifactId,
  parent: ArtifactId,
  parentsOf: (id: ArtifactId) => readonly ArtifactProvenanceEdge[],
): boolean {
  if (child === parent) {
    return true;
  }
  const stack: ArtifactId[] = [parent];
  const seen = new Set<ArtifactId>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) {
      continue;
    }
    if (current === child) {
      return true;
    }
    seen.add(current);
    for (const edge of parentsOf(current)) {
      stack.push(edge.parentArtifactId);
    }
  }
  return false;
}

/**
 * In-memory artifact API. Persistence adapters implement the same rules over
 * SQLite; this copy is the contract tests and later children can share.
 */
export function createArtifactApi(): ArtifactApi {
  const records = new Map<ArtifactId, ArtifactRecord>();
  const byChild = new Map<ArtifactId, ArtifactProvenanceEdge[]>();
  const byParent = new Map<ArtifactId, ArtifactProvenanceEdge[]>();
  const keys = new Set<string>();

  function parentsOf(id: ArtifactId): readonly ArtifactProvenanceEdge[] {
    return byChild.get(id) ?? [];
  }

  function childrenOf(id: ArtifactId): readonly ArtifactProvenanceEdge[] {
    return byParent.get(id) ?? [];
  }

  return {
    register(record) {
      if (records.has(record.artifactId)) {
        return err({
          kind: "artifact",
          code: "already-exists",
          artifactId: record.artifactId,
        });
      }
      records.set(record.artifactId, record);
      return ok(writeOk());
    },

    describe(id) {
      const record = records.get(id);
      if (record === undefined) {
        return err({ kind: "artifact", code: "not-found", artifactId: id });
      }
      return ok({
        schemaVersion: ARTIFACT_API_VERSION,
        artifactId: id,
        record,
        parents: parentsOf(id),
        children: childrenOf(id),
      });
    },

    link(request, signal) {
      if (isAborted(signal)) {
        return err(provenanceError("cancelled", request.childArtifactId, "signal"));
      }
      const parsed = parseArtifactProvenanceEdge({
        schemaVersion: ARTIFACT_API_VERSION,
        ...request,
      });
      if (!parsed.ok) {
        return parsed;
      }
      const edge = parsed.value;
      const child = records.get(edge.childArtifactId);
      if (child === undefined) {
        return err(provenanceError("missing-child", edge.childArtifactId, "childArtifactId"));
      }
      const parent = records.get(edge.parentArtifactId);
      if (parent === undefined) {
        return err(provenanceError("missing-parent", edge.parentArtifactId, "parentArtifactId"));
      }
      if (child.availability !== "available" || parent.availability !== "available") {
        const blocked = child.availability !== "available" ? child : parent;
        return err(provenanceError("unavailable", blocked.artifactId, "availability"));
      }
      if (parentsOf(edge.childArtifactId).length >= MAX_ARTIFACT_PARENTS) {
        return err(provenanceError("too-many-parents", edge.childArtifactId, "parents"));
      }
      if (keys.has(edgeKey(edge))) {
        return err(provenanceError("already-linked", edge.childArtifactId, "edge"));
      }
      if (wouldCycle(edge.childArtifactId, edge.parentArtifactId, parentsOf)) {
        return err(provenanceError("cycle", edge.childArtifactId, "parentArtifactId"));
      }

      keys.add(edgeKey(edge));
      const childEdges = byChild.get(edge.childArtifactId) ?? [];
      childEdges.push(edge);
      byChild.set(edge.childArtifactId, childEdges);
      const parentEdges = byParent.get(edge.parentArtifactId) ?? [];
      parentEdges.push(edge);
      byParent.set(edge.parentArtifactId, parentEdges);
      if (isAborted(signal)) {
        return ok({ cancelledAfterCommit: true });
      }
      return ok(writeOk());
    },

    ancestors(id, maximumDepth = MAX_ARTIFACT_LINEAGE_DEPTH) {
      if (!records.has(id)) {
        return err({ kind: "artifact", code: "not-found", artifactId: id });
      }
      return walkArtifactLineage(
        id,
        (node) => ok(parentsOf(node)),
        (edge) => edge.parentArtifactId,
        maximumDepth,
      );
    },

    descendants(id, maximumDepth = MAX_ARTIFACT_LINEAGE_DEPTH) {
      if (!records.has(id)) {
        return err({ kind: "artifact", code: "not-found", artifactId: id });
      }
      return walkArtifactLineage(
        id,
        (node) => ok(childrenOf(node)),
        (edge) => edge.childArtifactId,
        maximumDepth,
      );
    },

    reportIntegrity(id, intact) {
      const record = records.get(id);
      if (record === undefined) {
        return err({ kind: "artifact", code: "not-found", artifactId: id });
      }
      return ok({
        schemaVersion: ARTIFACT_API_VERSION,
        artifactId: id,
        availability: record.availability,
        intact,
      });
    },
  };
}
