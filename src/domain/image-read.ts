/**
 * Bounded image read contracts (#58).
 *
 * Image output is metadata plus an optional provider-compatible encoded
 * projection. The reader never executes image content, guesses source text, or
 * expands a compressed image without a declared cost bound.
 */

import { z } from "zod";

import { MAX_LOCAL_PATH_LENGTH } from "./filesystem.ts";
import { err, ok, type Result } from "./result.ts";
import type { BoundWorkspacePath } from "./workspace-path.ts";
import type { WorkspaceReadError } from "./workspace-read.ts";

export const IMAGE_FORMATS = ["png", "jpeg", "gif", "webp", "bmp", "svg"] as const;
export type ImageFormat = (typeof IMAGE_FORMATS)[number];

export const IMAGE_COLOR_PROFILES = ["srgb", "display-p3", "embedded", "unknown"] as const;
export type ImageColorProfile = (typeof IMAGE_COLOR_PROFILES)[number];

export const IMAGE_DIAGNOSTIC_CODES = [
  "animation-limit",
  "decode-cost",
  "huge-output",
  "metadata-limit",
  "unknown-dimensions",
  "unsafe-svg",
] as const;
export type ImageDiagnosticCode = (typeof IMAGE_DIAGNOSTIC_CODES)[number];

export const IMAGE_OMISSION_KINDS = ["visual", "frames", "metadata"] as const;
export type ImageOmissionKind = (typeof IMAGE_OMISSION_KINDS)[number];

export const IMAGE_OMISSION_REASONS = ["budget", "decode-cost", "unsupported"] as const;
export type ImageOmissionReason = (typeof IMAGE_OMISSION_REASONS)[number];

export const IMAGE_STOP_REASONS = ["cancelled", "budget", "decode-cost"] as const;
export type ImageStopReason = (typeof IMAGE_STOP_REASONS)[number];

export const IMAGE_LIMIT_NAMES = [
  "maxSourceBytes",
  "maxVisualBytes",
  "maxPixels",
  "maxFrames",
  "maxMetadataChunks",
] as const;
export type ImageLimitName = (typeof IMAGE_LIMIT_NAMES)[number];

export const DEFAULT_MAX_IMAGE_SOURCE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_IMAGE_VISUAL_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_IMAGE_PIXELS = 25_000_000;
export const DEFAULT_MAX_IMAGE_FRAMES = 32;
export const DEFAULT_MAX_IMAGE_METADATA_CHUNKS = 512;

export const MAX_IMAGE_SOURCE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_VISUAL_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 100_000_000;
export const MAX_IMAGE_FRAMES = 256;
export const MAX_IMAGE_METADATA_CHUNKS = 4_096;

export const DEFAULT_IMAGE_READ_LIMITS = {
  maxSourceBytes: DEFAULT_MAX_IMAGE_SOURCE_BYTES,
  maxVisualBytes: DEFAULT_MAX_IMAGE_VISUAL_BYTES,
  maxPixels: DEFAULT_MAX_IMAGE_PIXELS,
  maxFrames: DEFAULT_MAX_IMAGE_FRAMES,
  maxMetadataChunks: DEFAULT_MAX_IMAGE_METADATA_CHUNKS,
} as const;

export type ImageReadLimits = {
  readonly maxSourceBytes: number;
  readonly maxVisualBytes: number;
  readonly maxPixels: number;
  readonly maxFrames: number;
  readonly maxMetadataChunks: number;
};

const imageLimitsSchema = z
  .object({
    maxSourceBytes: z.number().int().positive().max(MAX_IMAGE_SOURCE_BYTES).optional(),
    maxVisualBytes: z.number().int().positive().max(MAX_IMAGE_VISUAL_BYTES).optional(),
    maxPixels: z.number().int().positive().max(MAX_IMAGE_PIXELS).optional(),
    maxFrames: z.number().int().positive().max(MAX_IMAGE_FRAMES).optional(),
    maxMetadataChunks: z.number().int().positive().max(MAX_IMAGE_METADATA_CHUNKS).optional(),
  })
  .strict();

export type ImageReadLimitsInput = z.input<typeof imageLimitsSchema>;

const MAX_IMAGE_LIMITS: ImageReadLimits = {
  maxSourceBytes: MAX_IMAGE_SOURCE_BYTES,
  maxVisualBytes: MAX_IMAGE_VISUAL_BYTES,
  maxPixels: MAX_IMAGE_PIXELS,
  maxFrames: MAX_IMAGE_FRAMES,
  maxMetadataChunks: MAX_IMAGE_METADATA_CHUNKS,
};

export type ImageLimitError = {
  readonly code: "malformed-limits";
  readonly field: ImageLimitName;
};

export function imageReadLimits(
  input: ImageReadLimitsInput | undefined = undefined,
): Result<ImageReadLimits, ImageLimitError> {
  const parsed = imageLimitsSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    if (typeof field === "string" && IMAGE_LIMIT_NAMES.includes(field as ImageLimitName)) {
      return err({ code: "malformed-limits", field: field as ImageLimitName });
    }
    return err({ code: "malformed-limits", field: "maxSourceBytes" });
  }

  const limits: ImageReadLimits = {
    maxSourceBytes: parsed.data.maxSourceBytes ?? DEFAULT_IMAGE_READ_LIMITS.maxSourceBytes,
    maxVisualBytes: parsed.data.maxVisualBytes ?? DEFAULT_IMAGE_READ_LIMITS.maxVisualBytes,
    maxPixels: parsed.data.maxPixels ?? DEFAULT_IMAGE_READ_LIMITS.maxPixels,
    maxFrames: parsed.data.maxFrames ?? DEFAULT_IMAGE_READ_LIMITS.maxFrames,
    maxMetadataChunks: parsed.data.maxMetadataChunks ?? DEFAULT_IMAGE_READ_LIMITS.maxMetadataChunks,
  };
  for (const field of IMAGE_LIMIT_NAMES) {
    if (limits[field] > MAX_IMAGE_LIMITS[field]) {
      return err({ code: "malformed-limits", field });
    }
  }
  return ok(limits);
}

const imageReadRequestSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(MAX_LOCAL_PATH_LENGTH)
      .refine((value) => hasNoControlCharacters(value)),
    limits: imageLimitsSchema.optional(),
  })
  .strict();

export type ImageReadRequest = z.input<typeof imageReadRequestSchema>;
export type ImageRequestField = "request" | "path" | "limits";

export type ImageRequestError = {
  readonly code: "malformed-request";
  readonly field: ImageRequestField;
};

export type NormalizedImageReadRequest = {
  readonly path: string;
  readonly limits: ImageReadLimits;
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

export function parseImageReadRequest(
  value: unknown,
): Result<NormalizedImageReadRequest, ImageRequestError | ImageLimitError> {
  const parsed = imageReadRequestSchema.safeParse(value);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return err({
      code: "malformed-request",
      field: field === "path" || field === "limits" ? field : "request",
    });
  }
  const limits = imageReadLimits(parsed.data.limits);
  if (!limits.ok) {
    return limits;
  }
  return ok({ path: parsed.data.path, limits: limits.value });
}

export type ImageDocument = {
  readonly requested: string;
  readonly bound: BoundWorkspacePath;
  readonly byteLength: number;
  readonly digest: string;
  readonly format: ImageFormat;
  readonly mediaType: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly orientation: number;
  readonly colorProfile: ImageColorProfile;
  readonly animated: boolean;
  readonly frameCount: number;
  readonly loopCount: number | null;
  readonly estimatedDecodePixels: number | null;
};

export type ImageDiagnostic = {
  readonly code: ImageDiagnosticCode;
  readonly byteOffset: number | null;
};

export type ImageVisualProjection = {
  readonly kind: "visual";
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly sourceDigest: string;
  readonly providerCompatible: true;
};

export type ImageOmission = {
  readonly kind: ImageOmissionKind;
  readonly count: number;
  readonly reason: ImageOmissionReason;
};

export type ImageRead = {
  readonly capability: "read_image";
  readonly projection: "image";
  readonly complete: false;
  readonly status: "complete" | "partial";
  readonly document: ImageDocument;
  readonly visual: ImageVisualProjection | null;
  readonly diagnostics: readonly ImageDiagnostic[];
  readonly omissions: readonly ImageOmission[];
  readonly stopReason: ImageStopReason | null;
};

export type ImageReadError =
  | WorkspaceReadError
  | ImageRequestError
  | ImageLimitError
  | { readonly code: "not-image" }
  | { readonly code: "malformed-image"; readonly format: ImageFormat | null }
  | { readonly code: "unsupported-format"; readonly mediaType: string | null }
  | { readonly code: "cancelled" };
