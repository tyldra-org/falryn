/** Shared contracts and constructors for image format parsers. */

import type { ImageDiagnostic, ImageDocument, ImageFormat, Result } from "../../../domain/index.ts";

export type ParsedImage = {
  readonly format: ImageFormat;
  readonly width: number | null;
  readonly height: number | null;
  readonly orientation: number;
  readonly colorProfile: ImageDocument["colorProfile"];
  readonly animated: boolean;
  readonly frameCount: number;
  readonly loopCount: number | null;
  readonly estimatedDecodePixels: number | null;
  readonly diagnostics: readonly ImageDiagnostic[];
};

export type ParsedImageError =
  | { readonly code: "not-image" }
  | { readonly code: "malformed-image"; readonly format: ImageFormat | null }
  | { readonly code: "unsupported-format"; readonly mediaType: string | null };

export function estimateDecodePixels(width: number | null, height: number | null): number | null {
  if (width === null || height === null) {
    return null;
  }
  const pixels = width * height;
  return Number.isSafeInteger(pixels) ? pixels : Number.MAX_SAFE_INTEGER;
}

export function malformed(format: ImageFormat | null): Result<never, ParsedImageError> {
  return { ok: false, error: { code: "malformed-image", format } };
}

export function dimensions(
  format: ImageFormat,
  width: number | null,
  height: number | null,
  orientation = 1,
  colorProfile: ImageDocument["colorProfile"] = "unknown",
  animated = false,
  frameCount = 1,
  loopCount: number | null = null,
  diagnostics: readonly ImageDiagnostic[] = [],
): ParsedImage {
  return {
    format,
    width,
    height,
    orientation,
    colorProfile,
    animated,
    frameCount,
    loopCount,
    estimatedDecodePixels: estimateDecodePixels(width, height),
    diagnostics,
  };
}
