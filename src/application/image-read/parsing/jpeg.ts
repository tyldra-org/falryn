/** JPEG header and EXIF orientation parser. */

import type {
  ImageDiagnostic,
  ImageDocument,
  ImageReadLimits,
  Result,
} from "../../../domain/index.ts";
import { byteAt, text, uint16BE, uint16LE, uint32BE, uint32LE } from "./bytes.ts";
import { dimensions, malformed, type ParsedImage, type ParsedImageError } from "./contracts.ts";

function isJpegFrameMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function hasJpegEnd(bytes: Uint8Array, start: number): boolean {
  for (let offset = start; offset + 1 < bytes.byteLength; offset += 1) {
    if (byteAt(bytes, offset) === 0xff && byteAt(bytes, offset + 1) === 0xd9) {
      return true;
    }
  }
  return false;
}

function parseExifOrientation(bytes: Uint8Array, start: number, length: number): number {
  if (length < 14 || text(bytes, start, 6) !== "Exif\0\0") {
    return 1;
  }
  const tiff = start + 6;
  const little = text(bytes, tiff, 2) === "II";
  if (!little && text(bytes, tiff, 2) !== "MM") {
    return 1;
  }
  const read16 = little ? uint16LE : uint16BE;
  const read32 = little ? uint32LE : uint32BE;
  if (read16(bytes, tiff + 2) !== 42) {
    return 1;
  }
  const directory = read32(bytes, tiff + 4);
  if (directory === null || directory > length - 8) {
    return 1;
  }
  const count = read16(bytes, tiff + directory);
  if (count === null || count > 256) {
    return 1;
  }
  for (let index = 0; index < count; index += 1) {
    const entry = tiff + directory + 2 + index * 12;
    const tag = read16(bytes, entry);
    const type = read16(bytes, entry + 2);
    const itemCount = read32(bytes, entry + 4);
    if (tag === null || type === null || itemCount === null) {
      return 1;
    }
    if (tag !== 0x0112 || type !== 3 || itemCount < 1) {
      continue;
    }
    const orientation = read16(bytes, entry + 8);
    return orientation !== null && orientation >= 1 && orientation <= 8 ? orientation : 1;
  }
  return 1;
}

export function parseJpeg(
  bytes: Uint8Array,
  limits: ImageReadLimits,
): Result<ParsedImage, ParsedImageError> {
  if (bytes.byteLength < 4 || byteAt(bytes, 0) !== 0xff || byteAt(bytes, 1) !== 0xd8) {
    return malformed("jpeg");
  }
  let offset = 2;
  let width: number | null = null;
  let height: number | null = null;
  let orientation = 1;
  let colorProfile: ImageDocument["colorProfile"] = "unknown";
  let chunks = 0;
  let terminated = false;
  while (offset < bytes.byteLength && chunks < limits.maxMetadataChunks) {
    if (byteAt(bytes, offset) !== 0xff) {
      return malformed("jpeg");
    }
    while (byteAt(bytes, offset) === 0xff) {
      offset += 1;
    }
    const marker = byteAt(bytes, offset);
    if (marker === null) {
      return malformed("jpeg");
    }
    offset += 1;
    if (marker === 0xd9) {
      terminated = true;
      break;
    }
    if (marker === 0xda) {
      const scanLength = uint16BE(bytes, offset);
      if (
        scanLength === null ||
        scanLength < 2 ||
        offset + scanLength > bytes.byteLength ||
        !hasJpegEnd(bytes, offset + scanLength)
      ) {
        return malformed("jpeg");
      }
      terminated = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    const length = uint16BE(bytes, offset);
    if (length === null || length < 2 || offset + length > bytes.byteLength) {
      return malformed("jpeg");
    }
    const dataStart = offset + 2;
    const dataLength = length - 2;
    chunks += 1;
    if (isJpegFrameMarker(marker)) {
      const parsedHeight = uint16BE(bytes, dataStart + 1);
      const parsedWidth = uint16BE(bytes, dataStart + 3);
      if (dataLength < 6 || parsedWidth === null || parsedHeight === null) {
        return malformed("jpeg");
      }
      width = parsedWidth;
      height = parsedHeight;
    } else if (marker === 0xe1) {
      orientation = parseExifOrientation(bytes, dataStart, dataLength);
    } else if (marker === 0xe2 && text(bytes, dataStart, 12) === "ICC_PROFILE\0") {
      colorProfile = "embedded";
    }
    offset += length;
  }
  if (width === null || height === null || width === 0 || height === 0) {
    return malformed("jpeg");
  }
  if (!terminated) {
    return malformed("jpeg");
  }
  const diagnostics: ImageDiagnostic[] =
    !terminated && chunks >= limits.maxMetadataChunks
      ? [{ code: "metadata-limit", byteOffset: offset }]
      : [];
  return {
    ok: true,
    value: dimensions(
      "jpeg",
      width,
      height,
      orientation,
      colorProfile,
      false,
      1,
      null,
      diagnostics,
    ),
  };
}
