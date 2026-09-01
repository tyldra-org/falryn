/** Dispatches bounded image bytes to focused format parsers. */

import type { ImageReadLimits, Result } from "../../domain/index.ts";
import { parseBmp, parseSvg } from "./parsing/bmp-svg.ts";
import { byteAt, startsWith, text } from "./parsing/bytes.ts";
import type { ParsedImage, ParsedImageError } from "./parsing/contracts.ts";
import { parseGif } from "./parsing/gif.ts";
import { parseJpeg } from "./parsing/jpeg.ts";
import { parsePng } from "./parsing/png.ts";
import { parseWebp } from "./parsing/webp.ts";

export type { ParsedImage, ParsedImageError } from "./parsing/contracts.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

export function parseImageBytes(
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
