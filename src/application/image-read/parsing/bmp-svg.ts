/** BMP and safe SVG metadata parsers. */

import type { ImageDiagnostic, Result } from "../../../domain/index.ts";
import { int32LE, text, uint32LE } from "./bytes.ts";
import { dimensions, malformed, type ParsedImage, type ParsedImageError } from "./contracts.ts";

export function parseBmp(bytes: Uint8Array): Result<ParsedImage, ParsedImageError> {
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

export function parseSvg(bytes: Uint8Array): Result<ParsedImage, ParsedImageError> {
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
