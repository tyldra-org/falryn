/** GIF header, frame, and loop metadata parser. */

import type { ImageDiagnostic, ImageReadLimits, Result } from "../../../domain/index.ts";
import { byteAt, text, uint16LE } from "./bytes.ts";
import { dimensions, malformed, type ParsedImage, type ParsedImageError } from "./contracts.ts";

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

export function parseGif(
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
