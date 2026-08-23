/** Maps parsed image metadata and source bytes into the public projection. */

import { createHash } from "node:crypto";

import type {
  ImageDiagnostic,
  ImageDocument,
  ImageFormat,
  ImageOmission,
  ImageRead,
  ImageStopReason,
  ImageVisualProjection,
  NormalizedImageReadRequest,
} from "../../domain/index.ts";
import type { WorkspaceReader } from "../workspace-read.ts";
import type { ParsedImage } from "./parsing.ts";

const MEDIA_TYPES: Readonly<Record<ImageFormat, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

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

export function readImageResult(
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
