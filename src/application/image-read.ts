/**
 * Application boundary for bounded image reads (#58).
 *
 * The reader reads exact bytes through WorkspaceReader, parses bounded headers,
 * and returns the original encoded bytes only when the declared visual budget
 * can carry them safely. It does not execute SVG, decode pixels, or invoke OCR.
 */

import {
  type ImageRead,
  type ImageReadError,
  type LocalPath,
  parseImageReadRequest,
  type Result,
} from "../domain/index.ts";
import { parseImageBytes } from "./image-read/parsing.ts";
import { readImageResult } from "./image-read/projection.ts";
import type { WorkspaceReader } from "./workspace-read.ts";

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
