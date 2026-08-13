/**
 * Application boundary for virtual-resource reads (#58).
 *
 * The injected port is the only owner of provider, browser, debugger, MCP, or
 * generated-resource storage. This module only validates identity and bounds
 * metadata/range projections.
 */

import type { VirtualResourcePort } from "../domain/index.ts";
import {
  type NormalizedVirtualResourceReadRequest,
  parseVirtualResourceReadRequest,
  parseVirtualResourceSource,
  type Result,
  type VirtualResourceRange,
  type VirtualResourceRead,
  type VirtualResourceReadError,
  type VirtualResourceSource,
} from "../domain/index.ts";

export type VirtualResourceReader = {
  read(
    request: unknown,
    signal?: AbortSignal,
  ): Promise<Result<VirtualResourceRead, VirtualResourceReadError>>;
};

function cancelled(): Result<never, VirtualResourceReadError> {
  return { ok: false, error: { code: "cancelled" } };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function metadataResult(
  request: NormalizedVirtualResourceReadRequest,
  resource: VirtualResourceSource,
): VirtualResourceRead {
  return {
    capability: "read_virtual_resource",
    projection: "virtual-resource",
    complete: false,
    status: "complete",
    mode: request.mode,
    resource,
    range: null,
  };
}

export function createVirtualResourceReader(port: VirtualResourcePort): VirtualResourceReader {
  return {
    async read(request, signal) {
      if (isAborted(signal)) {
        return cancelled();
      }
      const parsed = parseVirtualResourceReadRequest(request);
      if (!parsed.ok) {
        return parsed;
      }
      const described = await port.describe(parsed.value.uri, signal);
      if (!described.ok) {
        return described;
      }
      if (isAborted(signal)) {
        return cancelled();
      }
      if (described.value === null) {
        return { ok: false, error: { code: "not-found" } };
      }
      const source = parseVirtualResourceSource(described.value);
      if (!source.ok) {
        return source;
      }
      if (source.value.uri !== parsed.value.uri) {
        return { ok: false, error: { code: "resource-identity-mismatch" } };
      }
      if (parsed.value.mode === "metadata") {
        return { ok: true, value: metadataResult(parsed.value, source.value) };
      }
      if (!source.value.exactBytes) {
        return { ok: false, error: { code: "exact-bytes-unavailable" } };
      }
      if (isAborted(signal)) {
        return cancelled();
      }
      const offset = parsed.value.offset ?? 0;
      const length = parsed.value.length ?? parsed.value.limits.maxRangeBytes;
      if (offset > source.value.byteLength) {
        return { ok: false, error: { code: "range-out-of-bounds" } };
      }
      const bytes = await port.readRange(parsed.value.uri, offset, length, signal);
      if (!bytes.ok) {
        return bytes;
      }
      if (isAborted(signal)) {
        return cancelled();
      }
      if (
        bytes.value.byteLength > length ||
        bytes.value.byteLength > source.value.byteLength - offset
      ) {
        return { ok: false, error: { code: "range-overflow" } };
      }
      const range: VirtualResourceRange = {
        uri: source.value.uri,
        offset,
        byteLength: bytes.value.byteLength,
        bytes: bytes.value,
        endOfResource: offset + bytes.value.byteLength >= source.value.byteLength,
        digest: source.value.digest,
      };
      return {
        ok: true,
        value: {
          ...metadataResult(parsed.value, source.value),
          range,
        },
      };
    },
  };
}
