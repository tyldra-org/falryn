/** PNG and APNG header parser. */

import type {
  ImageDiagnostic,
  ImageDocument,
  ImageReadLimits,
  Result,
} from "../../../domain/index.ts";
import { text, uint32BE } from "./bytes.ts";
import { dimensions, malformed, type ParsedImage, type ParsedImageError } from "./contracts.ts";

export function parsePng(
  bytes: Uint8Array,
  limits: ImageReadLimits,
): Result<ParsedImage, ParsedImageError> {
  if (bytes.byteLength < 33) {
    return malformed("png");
  }
  let offset = 8;
  let chunks = 0;
  let width: number | null = null;
  let height: number | null = null;
  let colorProfile: ImageDocument["colorProfile"] = "unknown";
  let animated = false;
  let frameCount = 1;
  let loopCount: number | null = null;
  let ended = false;
  while (offset + 12 <= bytes.byteLength && chunks < limits.maxMetadataChunks) {
    const length = uint32BE(bytes, offset);
    const kind = text(bytes, offset + 4, 4);
    if (length === null || kind === null || length > bytes.byteLength) {
      return malformed("png");
    }
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const next = dataEnd + 4;
    if (dataEnd > bytes.byteLength || next > bytes.byteLength) {
      return malformed("png");
    }
    chunks += 1;
    if (kind === "IHDR") {
      const parsedWidth = uint32BE(bytes, dataStart);
      const parsedHeight = uint32BE(bytes, dataStart + 4);
      if (length < 13 || parsedWidth === null || parsedHeight === null) {
        return malformed("png");
      }
      width = parsedWidth;
      height = parsedHeight;
      if (width === 0 || height === 0) {
        return malformed("png");
      }
    } else if (kind === "iCCP") {
      colorProfile = "embedded";
    } else if (kind === "sRGB" && colorProfile === "unknown") {
      colorProfile = "srgb";
    } else if (kind === "acTL") {
      const parsedFrames = uint32BE(bytes, dataStart);
      const plays = uint32BE(bytes, dataStart + 4);
      if (length < 8 || parsedFrames === null || plays === null || parsedFrames === 0) {
        return malformed("png");
      }
      animated = true;
      frameCount = parsedFrames;
      loopCount = plays === 0 ? null : plays;
    } else if (kind === "IEND") {
      ended = true;
      break;
    }
    offset = next;
  }
  if (width === null || height === null) {
    return malformed("png");
  }
  if (!ended && chunks < limits.maxMetadataChunks) {
    return malformed("png");
  }
  const diagnostics: ImageDiagnostic[] =
    !ended && chunks >= limits.maxMetadataChunks
      ? [{ code: "metadata-limit", byteOffset: offset }]
      : [];
  return {
    ok: true,
    value: dimensions(
      "png",
      width,
      height,
      1,
      colorProfile,
      animated,
      frameCount,
      loopCount,
      diagnostics,
    ),
  };
}
