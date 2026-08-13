/**
 * Bounded artifact read contracts (#58).
 *
 * Artifact metadata and bytes use one identity-aware boundary. Metadata reads
 * never load content; previews and exact ranges are explicit and bounded.
 */

import { z } from "zod";

import {
  type ArtifactError,
  type ArtifactId,
  type ArtifactRange,
  type ArtifactRecord,
  artifactId,
  MAX_ARTIFACT_PREVIEW_BYTES,
  MAX_ARTIFACT_RANGE_BYTES,
} from "./artifact.ts";
import { err, ok, type Result } from "./result.ts";

export const ARTIFACT_READ_MODES = ["metadata", "preview", "range"] as const;
export type ArtifactReadMode = (typeof ARTIFACT_READ_MODES)[number];

export const ARTIFACT_READ_LIMIT_NAMES = ["maxPreviewBytes", "maxRangeBytes"] as const;
export type ArtifactReadLimitName = (typeof ARTIFACT_READ_LIMIT_NAMES)[number];

export const DEFAULT_ARTIFACT_READ_LIMITS = {
  maxPreviewBytes: 16 * 1024,
  maxRangeBytes: 1024 * 1024,
} as const;

export const MAX_ARTIFACT_READ_PREVIEW_BYTES = MAX_ARTIFACT_PREVIEW_BYTES;
export const MAX_ARTIFACT_READ_RANGE_BYTES = MAX_ARTIFACT_RANGE_BYTES;

export type ArtifactReadLimits = {
  readonly maxPreviewBytes: number;
  readonly maxRangeBytes: number;
};

const artifactReadLimitsSchema = z
  .object({
    maxPreviewBytes: z.number().int().positive().max(MAX_ARTIFACT_READ_PREVIEW_BYTES).optional(),
    maxRangeBytes: z.number().int().positive().max(MAX_ARTIFACT_READ_RANGE_BYTES).optional(),
  })
  .strict();

export type ArtifactReadLimitsInput = z.input<typeof artifactReadLimitsSchema>;

const MAX_ARTIFACT_READ_LIMITS: ArtifactReadLimits = {
  maxPreviewBytes: MAX_ARTIFACT_READ_PREVIEW_BYTES,
  maxRangeBytes: MAX_ARTIFACT_READ_RANGE_BYTES,
};

export type ArtifactReadLimitError = {
  readonly code: "malformed-limits";
  readonly field: ArtifactReadLimitName;
};

export function artifactReadLimits(
  input: ArtifactReadLimitsInput | undefined = undefined,
): Result<ArtifactReadLimits, ArtifactReadLimitError> {
  const parsed = artifactReadLimitsSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (
      typeof field === "string" &&
      ARTIFACT_READ_LIMIT_NAMES.includes(field as ArtifactReadLimitName)
    ) {
      return err({ code: "malformed-limits", field: field as ArtifactReadLimitName });
    }
    return err({ code: "malformed-limits", field: "maxPreviewBytes" });
  }

  const limits: ArtifactReadLimits = {
    maxPreviewBytes: parsed.data.maxPreviewBytes ?? DEFAULT_ARTIFACT_READ_LIMITS.maxPreviewBytes,
    maxRangeBytes: parsed.data.maxRangeBytes ?? DEFAULT_ARTIFACT_READ_LIMITS.maxRangeBytes,
  };
  for (const field of ARTIFACT_READ_LIMIT_NAMES) {
    if (limits[field] > MAX_ARTIFACT_READ_LIMITS[field]) {
      return err({ code: "malformed-limits", field });
    }
  }
  return ok(limits);
}

const artifactReadRequestSchema = z
  .object({
    artifactId: z.string().min(1),
    mode: z.enum(ARTIFACT_READ_MODES),
    offset: z.number().int().nonnegative().optional(),
    length: z.number().int().nonnegative().optional(),
    limits: artifactReadLimitsSchema.optional(),
  })
  .strict();

export type ArtifactReadRequest = z.input<typeof artifactReadRequestSchema>;
export type ArtifactReadRequestField =
  | "request"
  | "artifactId"
  | "mode"
  | "offset"
  | "length"
  | "limits";

export type ArtifactReadRequestError = {
  readonly code: "malformed-request";
  readonly field: ArtifactReadRequestField;
};

export type NormalizedArtifactReadRequest = {
  readonly artifactId: ArtifactId;
  readonly mode: ArtifactReadMode;
  readonly offset: number | null;
  readonly length: number | null;
  readonly limits: ArtifactReadLimits;
};

function requestField(path: readonly PropertyKey[]): ArtifactReadRequestField {
  const field = path[0];
  if (
    field === "artifactId" ||
    field === "mode" ||
    field === "offset" ||
    field === "length" ||
    field === "limits"
  ) {
    return field;
  }
  return "request";
}

export function parseArtifactReadRequest(
  value: unknown,
): Result<NormalizedArtifactReadRequest, ArtifactReadRequestError | ArtifactReadLimitError> {
  const parsed = artifactReadRequestSchema.safeParse(value);
  if (!parsed.success) {
    return err({
      code: "malformed-request",
      field: requestField(parsed.error.issues[0]?.path ?? []),
    });
  }
  const id = artifactId.parse(parsed.data.artifactId);
  if (!id.ok) {
    return err({ code: "malformed-request", field: "artifactId" });
  }
  const limits = artifactReadLimits(parsed.data.limits);
  if (!limits.ok) {
    return limits;
  }

  const hasOffset = parsed.data.offset !== undefined;
  const hasLength = parsed.data.length !== undefined;
  if (parsed.data.mode === "metadata" && (hasOffset || hasLength)) {
    return err({ code: "malformed-request", field: hasOffset ? "offset" : "length" });
  }
  if (parsed.data.mode === "preview" && hasOffset) {
    return err({ code: "malformed-request", field: "offset" });
  }
  if (parsed.data.mode === "range" && (!hasOffset || !hasLength)) {
    return err({ code: "malformed-request", field: hasOffset ? "length" : "offset" });
  }
  if (
    parsed.data.mode === "preview" &&
    parsed.data.length !== undefined &&
    parsed.data.length > limits.value.maxPreviewBytes
  ) {
    return err({ code: "malformed-limits", field: "maxPreviewBytes" });
  }
  if (
    parsed.data.mode === "range" &&
    parsed.data.length !== undefined &&
    parsed.data.length > limits.value.maxRangeBytes
  ) {
    return err({ code: "malformed-limits", field: "maxRangeBytes" });
  }
  return ok({
    artifactId: id.value,
    mode: parsed.data.mode,
    offset: parsed.data.offset ?? null,
    length: parsed.data.length ?? null,
    limits: limits.value,
  });
}

export type ArtifactRead = {
  readonly capability: "read_artifact";
  readonly projection: "artifact";
  readonly complete: false;
  readonly status: "complete";
  readonly mode: ArtifactReadMode;
  readonly record: ArtifactRecord;
  readonly range: ArtifactRange | null;
};

export type ArtifactReadError =
  | ArtifactError
  | ArtifactReadRequestError
  | ArtifactReadLimitError
  | { readonly code: "cancelled" };
