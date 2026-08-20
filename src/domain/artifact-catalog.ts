/**
 * Bounded artifact catalog queries for list surfaces (#340).
 *
 * Listing stays distinct from byte retrieval. This module names stored artifacts;
 * it does not read blob content or project a viewer.
 */

import { z } from "zod";
import {
  ARTIFACT_AVAILABILITIES,
  type ArtifactAvailability,
  type ArtifactId,
  type ArtifactRecord,
  type ArtifactSensitivity,
  artifactId,
} from "./artifact.ts";
import { brandedString } from "./branded-schema.ts";
import { assertNever, err, type Result } from "./result.ts";
import type { Timestamp } from "./time.ts";

export const ARTIFACT_CATALOG_VERSION = "artifact-catalog.v1";
export const MAX_ARTIFACT_CATALOG = 256;
export const DEFAULT_ARTIFACT_LIST_LIMIT = 32;

export type ArtifactCatalogErrorCode = "cancelled" | "malformed" | "invalid-limit";

export type ArtifactCatalogError = {
  readonly kind: "artifact-catalog";
  readonly code: ArtifactCatalogErrorCode;
  readonly field: string | null;
};

export type ArtifactCatalogEntry = {
  readonly artifactId: ArtifactId;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly availability: ArtifactAvailability;
  readonly sensitivity: ArtifactSensitivity;
  readonly createdAt: Timestamp;
};

export type ArtifactCatalog = {
  readonly artifacts: readonly ArtifactCatalogEntry[];
  readonly omitted: number;
};

function catalogError(code: ArtifactCatalogErrorCode, field: string | null): ArtifactCatalogError {
  return { kind: "artifact-catalog", code, field };
}

export function entryFromRecord(record: ArtifactRecord): ArtifactCatalogEntry {
  return {
    artifactId: record.artifactId,
    mediaType: record.mediaType,
    byteLength: record.byteLength,
    availability: record.availability,
    sensitivity: record.sensitivity,
    createdAt: record.createdAt,
  };
}

export function queryArtifactCatalog(
  records: readonly ArtifactRecord[],
  limit: number,
  signal?: AbortSignal,
): Result<ArtifactCatalog, ArtifactCatalogError> {
  if (signal?.aborted === true) {
    return err(catalogError("cancelled", null));
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_CATALOG) {
    return err(catalogError("invalid-limit", "limit"));
  }
  const sorted = [...records].sort((left, right) => {
    const byTime = right.createdAt.localeCompare(left.createdAt);
    return byTime === 0 ? String(left.artifactId).localeCompare(String(right.artifactId)) : byTime;
  });
  const artifacts = sorted.slice(0, limit).map(entryFromRecord);
  return {
    ok: true,
    value: {
      artifacts,
      omitted: Math.max(0, sorted.length - artifacts.length),
    },
  };
}

export function describeArtifactCatalogError(error: ArtifactCatalogError): string {
  switch (error.code) {
    case "cancelled":
      return "cancelled signal";
    case "invalid-limit":
      return "invalid limit";
    case "malformed":
      return "malformed catalog input";
    default:
      return assertNever(error.code, "unhandled artifact catalog error");
  }
}

export const artifactCatalogEntrySchema = z.object({
  artifactId: brandedString(artifactId),
  mediaType: z.string(),
  byteLength: z.number().int().nonnegative(),
  availability: z.enum(ARTIFACT_AVAILABILITIES),
  sensitivity: z.enum(["public", "user-content", "credential", "restricted"]),
  createdAt: z.string(),
});
