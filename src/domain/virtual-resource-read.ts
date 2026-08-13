/**
 * Virtual-resource read contracts (#58).
 *
 * A virtual resource has a stable Falryn identity but is not a workspace path.
 * Adapters own where it comes from; this boundary owns freshness, retention,
 * exact-byte availability, and bounded expansion.
 */

import { z } from "zod";

import { type ContentDigest, contentDigest } from "./artifact.ts";
import { err, ok, type Result } from "./result.ts";

export const VIRTUAL_RESOURCE_READ_MODES = ["metadata", "range"] as const;
export type VirtualResourceReadMode = (typeof VIRTUAL_RESOURCE_READ_MODES)[number];

export const VIRTUAL_RESOURCE_FRESHNESSES = ["live", "snapshot", "indexed"] as const;
export type VirtualResourceFreshness = (typeof VIRTUAL_RESOURCE_FRESHNESSES)[number];

export const VIRTUAL_RESOURCE_RETENTIONS = ["ephemeral", "retained"] as const;
export type VirtualResourceRetention = (typeof VIRTUAL_RESOURCE_RETENTIONS)[number];

export const VIRTUAL_RESOURCE_READ_LIMIT_NAMES = ["maxRangeBytes"] as const;
export type VirtualResourceReadLimitName = (typeof VIRTUAL_RESOURCE_READ_LIMIT_NAMES)[number];

export const DEFAULT_MAX_VIRTUAL_RESOURCE_RANGE_BYTES = 1024 * 1024;
export const MAX_VIRTUAL_RESOURCE_RANGE_BYTES = 8 * 1024 * 1024;
export const MAX_VIRTUAL_RESOURCE_URI_LENGTH = 2_048;
export const MAX_VIRTUAL_RESOURCE_MEDIA_TYPE_LENGTH = 128;

export const DEFAULT_VIRTUAL_RESOURCE_READ_LIMITS = {
  maxRangeBytes: DEFAULT_MAX_VIRTUAL_RESOURCE_RANGE_BYTES,
} as const;

export type VirtualResourceReadLimits = {
  readonly maxRangeBytes: number;
};

const virtualResourceLimitsSchema = z
  .object({
    maxRangeBytes: z.number().int().positive().max(MAX_VIRTUAL_RESOURCE_RANGE_BYTES).optional(),
  })
  .strict();

export type VirtualResourceReadLimitsInput = z.input<typeof virtualResourceLimitsSchema>;

export type VirtualResourceReadLimitError = {
  readonly code: "malformed-limits";
  readonly field: VirtualResourceReadLimitName;
};

export function virtualResourceReadLimits(
  input: VirtualResourceReadLimitsInput | undefined = undefined,
): Result<VirtualResourceReadLimits, VirtualResourceReadLimitError> {
  const parsed = virtualResourceLimitsSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return err({ code: "malformed-limits", field: "maxRangeBytes" });
  }
  return ok({
    maxRangeBytes: parsed.data.maxRangeBytes ?? DEFAULT_VIRTUAL_RESOURCE_READ_LIMITS.maxRangeBytes,
  });
}

const virtualResourceReadRequestSchema = z
  .object({
    uri: z.string().min(1).max(MAX_VIRTUAL_RESOURCE_URI_LENGTH),
    mode: z.enum(VIRTUAL_RESOURCE_READ_MODES),
    offset: z.number().int().nonnegative().optional(),
    length: z.number().int().nonnegative().optional(),
    limits: virtualResourceLimitsSchema.optional(),
  })
  .strict();

export type VirtualResourceReadRequest = z.input<typeof virtualResourceReadRequestSchema>;
export type VirtualResourceReadRequestField =
  | "request"
  | "uri"
  | "mode"
  | "offset"
  | "length"
  | "limits";

export type VirtualResourceReadRequestError = {
  readonly code: "malformed-request";
  readonly field: VirtualResourceReadRequestField;
};

export type NormalizedVirtualResourceReadRequest = {
  readonly uri: string;
  readonly mode: VirtualResourceReadMode;
  readonly offset: number | null;
  readonly length: number | null;
  readonly limits: VirtualResourceReadLimits;
};

function hasNoControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) {
      return false;
    }
  }
  return true;
}

function hasScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function requestField(path: readonly PropertyKey[]): VirtualResourceReadRequestField {
  const field = path[0];
  if (field === "uri" || field === "mode" || field === "offset" || field === "length") {
    return field;
  }
  if (field === "limits") {
    return "limits";
  }
  return "request";
}

export function parseVirtualResourceReadRequest(
  value: unknown,
): Result<
  NormalizedVirtualResourceReadRequest,
  VirtualResourceReadRequestError | VirtualResourceReadLimitError
> {
  const parsed = virtualResourceReadRequestSchema.safeParse(value);
  if (!parsed.success) {
    return err({
      code: "malformed-request",
      field: requestField(parsed.error.issues[0]?.path ?? []),
    });
  }
  if (!hasNoControlCharacters(parsed.data.uri) || !hasScheme(parsed.data.uri)) {
    return err({ code: "malformed-request", field: "uri" });
  }
  const limits = virtualResourceReadLimits(parsed.data.limits);
  if (!limits.ok) {
    return limits;
  }
  const hasOffset = parsed.data.offset !== undefined;
  const hasLength = parsed.data.length !== undefined;
  if (parsed.data.mode === "metadata" && (hasOffset || hasLength)) {
    return err({ code: "malformed-request", field: hasOffset ? "offset" : "length" });
  }
  if (parsed.data.mode === "range" && (!hasOffset || !hasLength)) {
    return err({ code: "malformed-request", field: hasOffset ? "length" : "offset" });
  }
  if (parsed.data.length !== undefined && parsed.data.length > limits.value.maxRangeBytes) {
    return err({ code: "malformed-limits", field: "maxRangeBytes" });
  }
  return ok({
    uri: parsed.data.uri,
    mode: parsed.data.mode,
    offset: parsed.data.offset ?? null,
    length: parsed.data.length ?? null,
    limits: limits.value,
  });
}

export const VIRTUAL_RESOURCE_PORT_ERROR_CODES = [
  "not-found",
  "unavailable",
  "unsupported",
  "failed",
  "cancelled",
] as const;
export type VirtualResourcePortErrorCode = (typeof VIRTUAL_RESOURCE_PORT_ERROR_CODES)[number];

export type VirtualResourcePortError = {
  readonly code: VirtualResourcePortErrorCode;
};

const MEDIA_TYPE = /^[!-~]+\/[!-~]+$/;

export type VirtualResourceSource = {
  readonly uri: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly digest: ContentDigest | null;
  readonly freshness: VirtualResourceFreshness;
  readonly retention: VirtualResourceRetention;
  readonly exactBytes: boolean;
};

const virtualResourceSourceSchema = z
  .object({
    uri: z.string().min(1).max(MAX_VIRTUAL_RESOURCE_URI_LENGTH),
    mediaType: z.string().min(3).max(MAX_VIRTUAL_RESOURCE_MEDIA_TYPE_LENGTH).regex(MEDIA_TYPE),
    byteLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    digest: z.string().nullable(),
    freshness: z.enum(VIRTUAL_RESOURCE_FRESHNESSES),
    retention: z.enum(VIRTUAL_RESOURCE_RETENTIONS),
    exactBytes: z.boolean(),
  })
  .strict();

export function parseVirtualResourceSource(
  value: unknown,
): Result<VirtualResourceSource, { readonly code: "malformed-source" }> {
  const parsed = virtualResourceSourceSchema.safeParse(value);
  if (!parsed.success) {
    return err({ code: "malformed-source" });
  }
  if (!hasNoControlCharacters(parsed.data.uri) || !hasScheme(parsed.data.uri)) {
    return err({ code: "malformed-source" });
  }
  if (parsed.data.digest !== null) {
    const digest = contentDigest.parse(parsed.data.digest);
    if (!digest.ok) {
      return err({ code: "malformed-source" });
    }
    return ok({ ...parsed.data, digest: digest.value });
  }
  return ok({
    uri: parsed.data.uri,
    mediaType: parsed.data.mediaType,
    byteLength: parsed.data.byteLength,
    digest: null,
    freshness: parsed.data.freshness,
    retention: parsed.data.retention,
    exactBytes: parsed.data.exactBytes,
  });
}

export type VirtualResourcePort = {
  describe(
    uri: string,
    signal?: AbortSignal,
  ): Promise<Result<unknown | null, VirtualResourcePortError>>;
  readRange(
    uri: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Result<Uint8Array, VirtualResourcePortError>>;
};

export type VirtualResourceRange = {
  readonly uri: string;
  readonly offset: number;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  readonly endOfResource: boolean;
  readonly digest: ContentDigest | null;
};

export type VirtualResourceRead = {
  readonly capability: "read_virtual_resource";
  readonly projection: "virtual-resource";
  readonly complete: false;
  readonly status: "complete";
  readonly mode: VirtualResourceReadMode;
  readonly resource: VirtualResourceSource;
  readonly range: VirtualResourceRange | null;
};

export type VirtualResourceReadError =
  | VirtualResourcePortError
  | VirtualResourceReadRequestError
  | VirtualResourceReadLimitError
  | { readonly code: "malformed-source" }
  | { readonly code: "resource-identity-mismatch" }
  | { readonly code: "exact-bytes-unavailable" }
  | { readonly code: "range-out-of-bounds" }
  | { readonly code: "range-overflow" }
  | { readonly code: "cancelled" };
