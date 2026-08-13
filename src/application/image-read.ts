/**
 * Application boundary for bounded image reads (#58).
 *
 * The reader reads exact bytes through WorkspaceReader, parses bounded headers,
 * and returns the original encoded bytes only when the declared visual budget
 * can carry them safely. It does not execute SVG, decode pixels, or invoke OCR.
 */

import { createHash } from "node:crypto";

import {
  type ImageDiagnostic,
  type ImageDocument,
  type ImageFormat,
  type ImageOmission,
  type ImageRead,
  type ImageReadError,
  type ImageReadLimits,
  type ImageStopReason,
  type ImageVisualProjection,
  type LocalPath,
  type NormalizedImageReadRequest,
  parseImageReadRequest,
  type Result,
} from "../domain/index.ts";
import type { WorkspaceReader } from "./workspace-read.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_MEDIA_TYPE = "image/jpeg";
const MEDIA_TYPES: Readonly<Record<ImageFormat, string>> = {
  png: "image/png",
  jpeg: JPEG_MEDIA_TYPE,
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

type ParsedImage = {
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

type ParsedImageError =
  | { readonly code: "not-image" }
  | { readonly code: "malformed-image"; readonly format: ImageFormat | null }
  | { readonly code: "unsupported-format"; readonly mediaType: string | null };

export type ImageReader = {
  read(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<Result<ImageRead, ImageReadError>>;
};

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function byteAt(bytes: Uint8Array, offset: number): number | null {
  const value = bytes[offset];
  return value === undefined ? null : value;
}

function uint16BE(bytes: Uint8Array, offset: number): number | null {
  const high = byteAt(bytes, offset);
  const low = byteAt(bytes, offset + 1);
  return high === null || low === null ? null : (high << 8) | low;
}

function uint16LE(bytes: Uint8Array, offset: number): number | null {
  const low = byteAt(bytes, offset);
  const high = byteAt(bytes, offset + 1);
  return low === null || high === null ? null : low | (high << 8);
}

function uint24LE(bytes: Uint8Array, offset: number): number | null {
  const first = byteAt(bytes, offset);
  const second = byteAt(bytes, offset + 1);
  const third = byteAt(bytes, offset + 2);
  return first === null || second === null || third === null
    ? null
    : first | (second << 8) | (third << 16);
}

function uint32BE(bytes: Uint8Array, offset: number): number | null {
  const first = byteAt(bytes, offset);
  const second = byteAt(bytes, offset + 1);
  const third = byteAt(bytes, offset + 2);
  const fourth = byteAt(bytes, offset + 3);
  return first === null || second === null || third === null || fourth === null
    ? null
    : first * 0x1000000 + (second << 16) + (third << 8) + fourth;
}

function uint32LE(bytes: Uint8Array, offset: number): number | null {
  const first = byteAt(bytes, offset);
  const second = byteAt(bytes, offset + 1);
  const third = byteAt(bytes, offset + 2);
  const fourth = byteAt(bytes, offset + 3);
  return first === null || second === null || third === null || fourth === null
    ? null
    : first + (second << 8) + (third << 16) + fourth * 0x1000000;
}

function int32LE(bytes: Uint8Array, offset: number): number | null {
  const value = uint32LE(bytes, offset);
  return value === null ? null : value > 0x7fffffff ? value - 0x100000000 : value;
}

function text(bytes: Uint8Array, offset: number, length: number): string | null {
  if (offset < 0 || length < 0 || offset + length > bytes.byteLength) {
    return null;
  }
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => byteAt(bytes, offset + index) === value);
}

function estimateDecodePixels(width: number | null, height: number | null): number | null {
  if (width === null || height === null) {
    return null;
  }
  const pixels = width * height;
  return Number.isSafeInteger(pixels) ? pixels : Number.MAX_SAFE_INTEGER;
}

function malformed(format: ImageFormat | null): Result<never, ParsedImageError> {
  return { ok: false, error: { code: "malformed-image", format } };
}

function dimensions(
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

function parsePng(
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

function parseJpeg(
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

function consumeGifSubBlocks(
  bytes: Uint8Array,
  start: number,
  captureMaximum = 0,
): { readonly end: number; readonly captured: Uint8Array } | null {
  let offset = start;
  const captured: number[] = [];
  while (offset < bytes.byteLength) {
    const size = byteAt(bytes, offset);
    if (size === null) {
      return null;
    }
    offset += 1;
    if (size === 0) {
      return { end: offset, captured: Uint8Array.from(captured) };
    }
    if (offset + size > bytes.byteLength) {
      return null;
    }
    if (captured.length < captureMaximum) {
      captured.push(
        ...bytes.subarray(offset, offset + Math.min(size, captureMaximum - captured.length)),
      );
    }
    offset += size;
  }
  return null;
}

function parseGif(
  bytes: Uint8Array,
  limits: ImageReadLimits,
): Result<ParsedImage, ParsedImageError> {
  if (bytes.byteLength < 13 || (text(bytes, 0, 6) !== "GIF87a" && text(bytes, 0, 6) !== "GIF89a")) {
    return malformed("gif");
  }
  const width = uint16LE(bytes, 6);
  const height = uint16LE(bytes, 8);
  const packed = byteAt(bytes, 10);
  if (width === null || height === null || packed === null || width === 0 || height === 0) {
    return malformed("gif");
  }
  let offset = 13;
  if ((packed & 0x80) !== 0) {
    const tableBytes = 3 * 2 ** ((packed & 0x07) + 1);
    offset += tableBytes;
  }
  let frameCount = 0;
  let loopCount: number | null = null;
  let chunks = 0;
  let terminated = false;
  while (offset < bytes.byteLength && chunks < limits.maxMetadataChunks) {
    const marker = byteAt(bytes, offset);
    if (marker === 0x3b) {
      terminated = true;
      break;
    }
    if (marker === 0x2c) {
      if (offset + 10 > bytes.byteLength) {
        return malformed("gif");
      }
      frameCount += 1;
      const imagePacked = byteAt(bytes, offset + 9);
      if (imagePacked === null) {
        return malformed("gif");
      }
      offset += 10;
      if ((imagePacked & 0x80) !== 0) {
        offset += 3 * 2 ** ((imagePacked & 0x07) + 1);
      }
      if (offset >= bytes.byteLength) {
        return malformed("gif");
      }
      offset += 1;
      const imageData = consumeGifSubBlocks(bytes, offset);
      if (imageData === null) {
        return malformed("gif");
      }
      offset = imageData.end;
      chunks += 1;
      continue;
    }
    if (marker === 0x21) {
      const label = byteAt(bytes, offset + 1);
      if (label === null) {
        return malformed("gif");
      }
      offset += 2;
      if (label === 0xf9) {
        const blockSize = byteAt(bytes, offset);
        if (blockSize === null || offset + 1 + blockSize >= bytes.byteLength) {
          return malformed("gif");
        }
        offset += 1 + blockSize;
        if (byteAt(bytes, offset) !== 0) {
          return malformed("gif");
        }
        offset += 1;
      } else if (label === 0xff) {
        const blockSize = byteAt(bytes, offset);
        if (blockSize === null || offset + 1 + blockSize > bytes.byteLength) {
          return malformed("gif");
        }
        const application = text(bytes, offset + 1, blockSize);
        offset += 1 + blockSize;
        const blocks = consumeGifSubBlocks(bytes, offset, application === "NETSCAPE2.0" ? 3 : 0);
        if (blocks === null) {
          return malformed("gif");
        }
        if (
          application === "NETSCAPE2.0" &&
          blocks.captured[0] === 1 &&
          blocks.captured.length >= 3
        ) {
          loopCount = (blocks.captured[1] ?? 0) | ((blocks.captured[2] ?? 0) << 8);
        }
        offset = blocks.end;
      } else {
        const blocks = consumeGifSubBlocks(bytes, offset);
        if (blocks === null) {
          return malformed("gif");
        }
        offset = blocks.end;
      }
      chunks += 1;
      continue;
    }
    return malformed("gif");
  }
  if (frameCount === 0) {
    return malformed("gif");
  }
  const diagnostics: ImageDiagnostic[] =
    !terminated && chunks >= limits.maxMetadataChunks
      ? [{ code: "metadata-limit", byteOffset: offset }]
      : [];
  return {
    ok: true,
    value: dimensions(
      "gif",
      width,
      height,
      1,
      "unknown",
      frameCount > 1,
      frameCount,
      loopCount,
      diagnostics,
    ),
  };
}

function parseWebp(
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

function parseBmp(bytes: Uint8Array): Result<ParsedImage, ParsedImageError> {
  if (bytes.byteLength < 26 || text(bytes, 0, 2) !== "BM") {
    return malformed("bmp");
  }
  const headerLength = uint32LE(bytes, 14);
  const width = int32LE(bytes, 18);
  const height = int32LE(bytes, 22);
  if (
    headerLength === null ||
    headerLength < 40 ||
    width === null ||
    height === null ||
    width <= 0 ||
    height === 0
  ) {
    return malformed("bmp");
  }
  return {
    ok: true,
    value: dimensions("bmp", Math.abs(width), Math.abs(height)),
  };
}

function svgNumber(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

function parseSvg(bytes: Uint8Array): Result<ParsedImage, ParsedImageError> {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return malformed("svg");
  }
  const root = source.match(/<svg\b[^>]*>/i)?.[0];
  if (root === undefined) {
    return { ok: false, error: { code: "not-image" } };
  }
  const width = svgNumber(root.match(/\bwidth\s*=\s*["']([^"']+)["']/i)?.[1]);
  const height = svgNumber(root.match(/\bheight\s*=\s*["']([^"']+)["']/i)?.[1]);
  const viewBox = root
    .match(/\bviewBox\s*=\s*["']([^"']+)["']/i)?.[1]
    ?.trim()
    .split(/\s+/);
  const viewBoxWidth = viewBox === undefined ? null : svgNumber(viewBox[2]);
  const viewBoxHeight = viewBox === undefined ? null : svgNumber(viewBox[3]);
  const diagnostics: ImageDiagnostic[] = [];
  if (/<(?:script|foreignObject)\b|<!DOCTYPE|<!ENTITY/i.test(source)) {
    diagnostics.push({ code: "unsafe-svg", byteOffset: 0 });
  }
  return {
    ok: true,
    value: dimensions(
      "svg",
      width ?? viewBoxWidth,
      height ?? viewBoxHeight,
      1,
      /color-profile|icc-color/i.test(source) ? "embedded" : "unknown",
      false,
      1,
      null,
      diagnostics,
    ),
  };
}

function parseImageBytes(
  bytes: Uint8Array,
  limits: ImageReadLimits,
): Result<ParsedImage, ParsedImageError> {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return parsePng(bytes, limits);
  }
  if (byteAt(bytes, 0) === 0xff && byteAt(bytes, 1) === 0xd8) {
    return parseJpeg(bytes, limits);
  }
  if (text(bytes, 0, 6) === "GIF87a" || text(bytes, 0, 6) === "GIF89a") {
    return parseGif(bytes, limits);
  }
  if (text(bytes, 0, 4) === "RIFF" && text(bytes, 8, 4) === "WEBP") {
    return parseWebp(bytes, limits);
  }
  if (text(bytes, 0, 2) === "BM") {
    return parseBmp(bytes);
  }
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.byteLength, 4_096)));
  if (/<svg\b/i.test(prefix)) {
    return parseSvg(bytes);
  }
  if (startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) || startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])) {
    return { ok: false, error: { code: "unsupported-format", mediaType: "image/tiff" } };
  }
  return { ok: false, error: { code: "not-image" } };
}

function digestOf(bytes: Uint8Array): string {
  const hash = createHash("sha256");
  hash.update(bytes);
  return `sha-256:${hash.digest("hex")}`;
}

function documentOf(
  request: NormalizedImageReadRequest,
  bound: ImageDocument["bound"],
  byteLength: number,
  digest: string,
  parsed: ParsedImage,
): ImageDocument {
  return {
    requested: request.path,
    bound,
    byteLength,
    digest,
    format: parsed.format,
    mediaType: MEDIA_TYPES[parsed.format],
    width: parsed.width,
    height: parsed.height,
    orientation: parsed.orientation,
    colorProfile: parsed.colorProfile,
    animated: parsed.animated,
    frameCount: parsed.frameCount,
    loopCount: parsed.loopCount,
    estimatedDecodePixels: parsed.estimatedDecodePixels,
  };
}

function addOmission(
  omissions: ImageOmission[],
  kind: ImageOmission["kind"],
  count: number,
  reason: ImageOmission["reason"],
): void {
  omissions.push({ kind, count: Math.max(1, count), reason });
}

function visualOf(bytes: Uint8Array, digest: string, mediaType: string): ImageVisualProjection {
  return {
    kind: "visual",
    mediaType,
    bytes: bytes.slice(),
    byteLength: bytes.byteLength,
    sourceDigest: digest,
    providerCompatible: true,
  };
}

function readImageResult(
  request: NormalizedImageReadRequest,
  source: Awaited<ReturnType<WorkspaceReader["readBytes"]>> & { readonly ok: true },
  parsed: ParsedImage,
): ImageRead {
  const digest = digestOf(source.value.bytes);
  const document = documentOf(request, source.value.bound, source.value.byteLength, digest, parsed);
  const diagnostics: ImageDiagnostic[] = [...parsed.diagnostics];
  const omissions: ImageOmission[] = [];
  let stopReason: ImageStopReason | null = null;
  let visual: ImageVisualProjection | null = null;
  const frameLimited = parsed.frameCount > request.limits.maxFrames;
  const metadataLimited = parsed.diagnostics.some(
    (diagnostic) => diagnostic.code === "metadata-limit",
  );

  if (parsed.estimatedDecodePixels === null) {
    diagnostics.push({ code: "unknown-dimensions", byteOffset: null });
  }
  if (metadataLimited) {
    addOmission(omissions, "metadata", 1, "budget");
    stopReason = "budget";
  }
  if (
    parsed.estimatedDecodePixels !== null &&
    parsed.estimatedDecodePixels > request.limits.maxPixels
  ) {
    diagnostics.push({ code: "decode-cost", byteOffset: null });
    addOmission(omissions, "visual", 1, "decode-cost");
    stopReason = "decode-cost";
  } else if (source.value.bytes.byteLength > request.limits.maxVisualBytes) {
    diagnostics.push({ code: "huge-output", byteOffset: null });
    addOmission(omissions, "visual", 1, "budget");
    stopReason = "budget";
  } else if (parsed.diagnostics.some((diagnostic) => diagnostic.code === "unsafe-svg")) {
    addOmission(omissions, "visual", 1, "unsupported");
  } else if (frameLimited) {
    addOmission(omissions, "visual", 1, "budget");
    stopReason = "budget";
  } else {
    visual = visualOf(source.value.bytes, digest, document.mediaType);
  }

  if (frameLimited) {
    diagnostics.push({ code: "animation-limit", byteOffset: null });
    addOmission(omissions, "frames", parsed.frameCount - request.limits.maxFrames, "budget");
    stopReason ??= "budget";
  }

  return {
    capability: "read_image",
    projection: "image",
    complete: false,
    status: diagnostics.length > 0 || omissions.length > 0 ? "partial" : "complete",
    document,
    visual,
    diagnostics,
    omissions,
    stopReason,
  };
}

export function createImageReader(workspaceReader: WorkspaceReader): ImageReader {
  return {
    async read(root, request, signal) {
      if (isAborted(signal)) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const parsedRequest = parseImageReadRequest(request);
      if (!parsedRequest.ok) {
        return parsedRequest;
      }
      const source = await workspaceReader.readBytes(
        root,
        parsedRequest.value.path,
        { maxFileBytes: parsedRequest.value.limits.maxSourceBytes },
        signal,
      );
      if (!source.ok) {
        return source;
      }
      if (isAborted(signal)) {
        return { ok: false, error: { code: "cancelled" } };
      }
      const parsed = parseImageBytes(source.value.bytes, parsedRequest.value.limits);
      if (!parsed.ok) {
        return parsed;
      }
      return { ok: true, value: readImageResult(parsedRequest.value, source, parsed.value) };
    },
  };
}
