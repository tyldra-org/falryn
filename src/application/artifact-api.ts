/**
 * Application boundary for the typed artifact API (#116).
 *
 * Looks up records through the artifact repository and edges through the
 * provenance repository. Integrity is an observation: the caller supplies
 * whether stored bytes still match, and this boundary never quarantines.
 */

import {
  ARTIFACT_API_VERSION,
  type ArtifactApiError,
  type ArtifactId,
  type ArtifactIntegrityReport,
  type ArtifactLineage,
  type ArtifactLinkRequest,
  type ArtifactProvenanceEdge,
  type ArtifactProvenancePort,
  type ArtifactRepositoryPort,
  type ArtifactWrite,
  err,
  MAX_ARTIFACT_LINEAGE_DEPTH,
  parseArtifactProvenanceEdge,
  type Result,
  walkArtifactLineage,
} from "../domain/index.ts";

export type DurableArtifactApi = {
  describe(id: ArtifactId): Result<ArtifactLineage, ArtifactApiError>;
  link(request: ArtifactLinkRequest, signal?: AbortSignal): Result<ArtifactWrite, ArtifactApiError>;
  listParents(id: ArtifactId): Result<readonly ArtifactProvenanceEdge[], ArtifactApiError>;
  listChildren(id: ArtifactId): Result<readonly ArtifactProvenanceEdge[], ArtifactApiError>;
  ancestors(
    id: ArtifactId,
    maximumDepth?: number,
  ): Result<readonly ArtifactProvenanceEdge[], ArtifactApiError>;
  descendants(
    id: ArtifactId,
    maximumDepth?: number,
  ): Result<readonly ArtifactProvenanceEdge[], ArtifactApiError>;
  reportIntegrity(
    id: ArtifactId,
    intact: boolean,
  ): Result<ArtifactIntegrityReport, ArtifactApiError>;
};

export function createDurableArtifactApi(options: {
  readonly artifacts: ArtifactRepositoryPort;
  readonly provenance: ArtifactProvenancePort;
}): DurableArtifactApi {
  const { artifacts, provenance } = options;

  return {
    describe(id) {
      const found = artifacts.get(id);
      if (!found.ok) {
        return found;
      }
      if (found.value === null) {
        return err({ kind: "artifact", code: "not-found", artifactId: id });
      }
      const parents = provenance.listParents(id);
      if (!parents.ok) {
        return parents;
      }
      const children = provenance.listChildren(id);
      if (!children.ok) {
        return children;
      }
      return {
        ok: true,
        value: {
          schemaVersion: ARTIFACT_API_VERSION,
          artifactId: id,
          record: found.value,
          parents: parents.value,
          children: children.value,
        },
      };
    },

    link(request, signal) {
      const parsed = parseArtifactProvenanceEdge({
        schemaVersion: ARTIFACT_API_VERSION,
        ...request,
      });
      if (!parsed.ok) {
        return parsed;
      }
      return provenance.insert(parsed.value, signal);
    },

    listParents: (id) => provenance.listParents(id),
    listChildren: (id) => provenance.listChildren(id),

    ancestors(id, maximumDepth = MAX_ARTIFACT_LINEAGE_DEPTH) {
      const found = artifacts.get(id);
      if (!found.ok) {
        return found;
      }
      if (found.value === null) {
        return err({ kind: "artifact", code: "not-found", artifactId: id });
      }
      return walkArtifactLineage(
        id,
        (node) => provenance.listParents(node),
        (edge) => edge.parentArtifactId,
        maximumDepth,
      );
    },

    descendants(id, maximumDepth = MAX_ARTIFACT_LINEAGE_DEPTH) {
      const found = artifacts.get(id);
      if (!found.ok) {
        return found;
      }
      if (found.value === null) {
        return err({ kind: "artifact", code: "not-found", artifactId: id });
      }
      return walkArtifactLineage(
        id,
        (node) => provenance.listChildren(node),
        (edge) => edge.childArtifactId,
        maximumDepth,
      );
    },

    reportIntegrity(id, intact) {
      const found = artifacts.get(id);
      if (!found.ok) {
        return found;
      }
      if (found.value === null) {
        return err({ kind: "artifact", code: "not-found", artifactId: id });
      }
      return {
        ok: true,
        value: {
          schemaVersion: ARTIFACT_API_VERSION,
          artifactId: id,
          availability: found.value.availability,
          intact,
        },
      };
    },
  };
}
