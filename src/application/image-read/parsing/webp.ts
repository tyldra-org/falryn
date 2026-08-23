/** WebP container and animation metadata parser. */

import type {
  ImageDiagnostic,
  ImageDocument,
  ImageReadLimits,
  Result,
} from "../../../domain/index.ts";
import { byteAt, text, uint16LE, uint24LE, uint32LE } from "./bytes.ts";
import { dimensions, malformed, type ParsedImage, type ParsedImageError } from "./contracts.ts";

export function parseWebp(
  bytes: Uint8Array,
  limits: ImageReadLimits,
): Result<ParsedImage, ParsedImageError> {
  if (bytes.byteLength < 16 || text(bytes, 0, 4) !== "RIFF" || text(bytes, 8, 4) !== "WEBP") {
    return malformed("webp");
  }
  const declaredLength = uint32LE(bytes, 4);
  if (declaredLength === null || declaredLength + 8 > bytes.byteLength) {
    return malformed("webp");
  }
  let offset = 12;
  let chunks = 0;
  const containerEnd = declaredLength + 8;
  let width: number | null = null;
  let height: number | null = null;
  let colorProfile: ImageDocument["colorProfile"] = "unknown";
  let animated = false;
  let frameCount = 0;
  let loopCount: number | null = null;
  while (offset + 8 <= containerEnd && chunks < limits.maxMetadataChunks) {
    const kind = text(bytes, offset, 4);
    const length = uint32LE(bytes, offset + 4);
    if (kind === null || length === null || offset + 8 + length > bytes.byteLength) {
      return malformed("webp");
    }
    const dataStart = offset + 8;
    if (kind === "VP8X") {
      const flags = byteAt(bytes, dataStart);
      const parsedWidth = uint24LE(bytes, dataStart + 4);
      const parsedHeight = uint24LE(bytes, dataStart + 7);
      if (
        length < 10 ||
        flags === null ||
        parsedWidth === null ||
        parsedHeight === null ||
        parsedWidth === 0 ||
        parsedHeight === 0
      ) {
        return malformed("webp");
      }
      width = parsedWidth + 1;
      height = parsedHeight + 1;
      animated = (flags & 0x02) !== 0;
      if ((flags & 0x20) !== 0) {
        colorProfile = "embedded";
      }
    } else if (kind === "ANIM") {
      if (length < 6) {
        return malformed("webp");
      }
      animated = true;
      loopCount = uint16LE(bytes, dataStart + 4);
    } else if (kind === "ANMF") {
      animated = true;
      frameCount += 1;
    } else if (kind === "ICCP") {
      colorProfile = "embedded";
    } else if (
      kind === "VP8 " &&
      length >= 10 &&
      text(bytes, dataStart + 3, 3) === "\x9d\x01\x2a"
    ) {
      width = uint16LE(bytes, dataStart + 6);
      height = uint16LE(bytes, dataStart + 8);
    } else if (kind === "VP8L" && length >= 5 && byteAt(bytes, dataStart) === 0x2f) {
      const bits = [
        byteAt(bytes, dataStart + 1),
        byteAt(bytes, dataStart + 2),
        byteAt(bytes, dataStart + 3),
        byteAt(bytes, dataStart + 4),
      ];
      if (bits.some((value) => value === null)) {
        return malformed("webp");
      }
      const first = bits[0] as number;
      const second = bits[1] as number;
      const third = bits[2] as number;
      const fourth = bits[3] as number;
      width = 1 + first + ((second & 0x3f) << 8);
      height = 1 + ((second >> 6) | (third << 2) | ((fourth & 0x0f) << 10));
    }
    offset += 8 + length + (length % 2);
    chunks += 1;
  }
  if (width === null || height === null || width === 0 || height === 0) {
    return malformed("webp");
  }
  if (animated && frameCount === 0) {
    frameCount = 1;
  }
  const diagnostics: ImageDiagnostic[] =
    chunks >= limits.maxMetadataChunks && offset < containerEnd
      ? [{ code: "metadata-limit", byteOffset: offset }]
      : [];
  return {
    ok: true,
    value: dimensions(
      "webp",
      width,
      height,
      1,
      colorProfile,
      animated,
      animated ? frameCount : 1,
      loopCount,
      diagnostics,
    ),
  };
}
