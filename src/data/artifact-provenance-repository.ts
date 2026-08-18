/**
 * Durable artifact provenance edges.
 *
 * The graph rules live in the domain. This module decides existence, parent
 * count, and cycles inside the write transaction so a constraint violation
 * never becomes the caller's problem.
 */

import {
  ARTIFACT_API_VERSION,
  type ArtifactApiError,
  type ArtifactId,
  type ArtifactProvenanceEdge,
  type ArtifactProvenanceError,
  type ArtifactProvenancePort,
  err,
  MAX_ARTIFACT_PARENTS,
  ok,
  parseArtifactProvenanceEdge,
  type Result,
  type SqliteRow,
  type SqliteStatements,
  type SqliteStoreError,
  type SqliteStorePort,
} from "../domain/index.ts";
import { ARTIFACT_TRANSFORMATIONS_TABLE } from "./artifact-provenance-schema.ts";
import { ARTIFACTS_TABLE } from "./artifact-schema.ts";

const SELECT_EDGE_LIST = `child_artifact_id AS childArtifactId, parent_artifact_id AS parentArtifactId,
  transformation AS transformation, created_at AS createdAt`;

const SELECT_PARENTS = `SELECT ${SELECT_EDGE_LIST} FROM ${ARTIFACT_TRANSFORMATIONS_TABLE}
  WHERE child_artifact_id = $id ORDER BY created_at, parent_artifact_id`;

const SELECT_CHILDREN = `SELECT ${SELECT_EDGE_LIST} FROM ${ARTIFACT_TRANSFORMATIONS_TABLE}
  WHERE parent_artifact_id = $id ORDER BY created_at, child_artifact_id`;

const SELECT_AVAILABILITY = `SELECT availability AS availability FROM ${ARTIFACTS_TABLE}
  WHERE artifact_id = $id`;

const INSERT_EDGE = `INSERT INTO ${ARTIFACT_TRANSFORMATIONS_TABLE}
  (child_artifact_id, parent_artifact_id, transformation, created_at)
  VALUES ($childArtifactId, $parentArtifactId, $transformation, $createdAt)`;

export type ArtifactProvenanceRepository = ArtifactProvenancePort;

function storageError(error: SqliteStoreError, id: ArtifactId | null): ArtifactApiError {
  return {
    kind: "artifact",
    code: "storage",
    failure: { medium: "metadata", error },
    artifactId: id,
  };
}

function apiError(
  code: ArtifactProvenanceError["code"],
  artifactId: ArtifactId | null,
  field: string | null,
): ArtifactProvenanceError {
  return { kind: "artifact-api", code, artifactId, field };
}

function parseEdge(row: SqliteRow): Result<ArtifactProvenanceEdge, ArtifactApiError> {
  return parseArtifactProvenanceEdge({
    schemaVersion: ARTIFACT_API_VERSION,
    childArtifactId: row.childArtifactId,
    parentArtifactId: row.parentArtifactId,
    transformation: row.transformation,
    createdAt: row.createdAt,
  });
}

function availabilityOf(statements: SqliteStatements, id: ArtifactId): string | null {
  const rows = statements.all(SELECT_AVAILABILITY, { id });
  const value = rows[0]?.availability;
  return typeof value === "string" ? value : null;
}

function parentsInside(statements: SqliteStatements, id: ArtifactId): ArtifactId[] {
  return statements.all(SELECT_PARENTS, { id }).flatMap((row) => {
    const parent = row.parentArtifactId;
    return typeof parent === "string" ? [parent as ArtifactId] : [];
  });
}

function wouldCycle(statements: SqliteStatements, child: ArtifactId, parent: ArtifactId): boolean {
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
    stack.push(...parentsInside(statements, current));
  }
  return false;
}

export function createArtifactProvenanceRepository(
  store: SqliteStorePort,
): ArtifactProvenanceRepository {
  const list = (
    sql: string,
    id: ArtifactId,
  ): Result<readonly ArtifactProvenanceEdge[], ArtifactApiError> => {
    const rows = store.read(sql, { id });
    if (!rows.ok) {
      return err(storageError(rows.error, id));
    }
    const edges: ArtifactProvenanceEdge[] = [];
    for (const row of rows.value) {
      const parsed = parseEdge(row);
      if (!parsed.ok) {
        return parsed;
      }
      edges.push(parsed.value);
    }
    return ok(edges);
  };

  return {
    listParents: (id) => list(SELECT_PARENTS, id),
    listChildren: (id) => list(SELECT_CHILDREN, id),
    insert(edge, signal) {
      const parsed = parseArtifactProvenanceEdge(edge);
      if (!parsed.ok) {
        return parsed;
      }
      const written = store.write((statements) => {
        const childState = availabilityOf(statements, edge.childArtifactId);
        if (childState === null) {
          return apiError("missing-child", edge.childArtifactId, "childArtifactId");
        }
        const parentState = availabilityOf(statements, edge.parentArtifactId);
        if (parentState === null) {
          return apiError("missing-parent", edge.parentArtifactId, "parentArtifactId");
        }
        if (childState !== "available" || parentState !== "available") {
          const blocked = childState !== "available" ? edge.childArtifactId : edge.parentArtifactId;
          return apiError("unavailable", blocked, "availability");
        }
        if (parentsInside(statements, edge.childArtifactId).length >= MAX_ARTIFACT_PARENTS) {
          return apiError("too-many-parents", edge.childArtifactId, "parents");
        }
        if (wouldCycle(statements, edge.childArtifactId, edge.parentArtifactId)) {
          return apiError("cycle", edge.childArtifactId, "parentArtifactId");
        }
        const inserted = statements.run(INSERT_EDGE, {
          childArtifactId: edge.childArtifactId,
          parentArtifactId: edge.parentArtifactId,
          transformation: edge.transformation,
          createdAt: edge.createdAt,
        });
        if (inserted.changes === 0) {
          return apiError("already-linked", edge.childArtifactId, "edge");
        }
        return null;
      }, signal);
      if (!written.ok) {
        const error = written.error;
        if (error.code === "cancelled") {
          return err(apiError("cancelled", edge.childArtifactId, "signal"));
        }
        if (error.code === "statement-rejected" && error.cause.code === "constraint") {
          return err(apiError("already-linked", edge.childArtifactId, "edge"));
        }
        return err(storageError(error, edge.childArtifactId));
      }
      const rejection = written.value.value;
      return rejection === null
        ? ok({ cancelledAfterCommit: written.value.cancelledAfterCommit })
        : err(rejection);
    },
  };
}
