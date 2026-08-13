import { describe, expect, test } from "bun:test";

import {
  contentDigest,
  ok,
  type VirtualResourcePort,
  type VirtualResourcePortError,
} from "../domain/index.ts";
import { createVirtualResourceReader } from "./virtual-resource-read.ts";

const URI = "browser://capture/session-1";
const digest = contentDigest.from(`sha-256:${"b".repeat(64)}`);

function port(
  sourceOverrides: Record<string, unknown> = {},
  range: Uint8Array = new TextEncoder().encode("snapshot"),
): VirtualResourcePort {
  const source = {
    uri: URI,
    mediaType: "text/plain",
    byteLength: range.byteLength,
    digest,
    freshness: "snapshot",
    retention: "retained",
    exactBytes: true,
    ...sourceOverrides,
  };
  return {
    describe: async () => ok(source),
    readRange: async (_uri, offset, length) => ok(range.slice(offset, offset + length)),
  };
}

describe("virtual-resource reader", () => {
  test("returns stable metadata without treating the URI as a workspace path", async () => {
    const result = await createVirtualResourceReader(port()).read({
      uri: URI,
      mode: "metadata",
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.resource).toMatchObject({
      uri: URI,
      freshness: "snapshot",
      retention: "retained",
      exactBytes: true,
      digest,
    });
    expect(result.ok && result.value.range).toBeNull();
  });

  test("returns bounded exact ranges with source provenance", async () => {
    const result = await createVirtualResourceReader(port()).read({
      uri: URI,
      mode: "range",
      offset: 2,
      length: 3,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.range).toMatchObject({
      uri: URI,
      offset: 2,
      byteLength: 3,
      endOfResource: false,
      digest,
    });
  });

  test("refuses non-resource paths, unavailable exact bytes, and over-budget ranges", async () => {
    const reader = createVirtualResourceReader(port());
    expect(await reader.read({ uri: "/tmp/capture", mode: "metadata" })).toEqual({
      ok: false,
      error: { code: "malformed-request", field: "uri" },
    });
    expect(
      await createVirtualResourceReader(port({ exactBytes: false })).read({
        uri: URI,
        mode: "range",
        offset: 0,
        length: 2,
      }),
    ).toEqual({
      ok: false,
      error: { code: "exact-bytes-unavailable" },
    });
    expect(
      await reader.read({
        uri: URI,
        mode: "range",
        offset: 0,
        length: 2 * 1024 * 1024,
        limits: { maxRangeBytes: 1024 },
      }),
    ).toEqual({
      ok: false,
      error: { code: "malformed-limits", field: "maxRangeBytes" },
    });
  });

  test("refuses adapter identity drift and preserves adapter failure codes", async () => {
    const mismatch = await createVirtualResourceReader(
      port({ uri: "mcp://different-resource" }),
    ).read({ uri: URI, mode: "metadata" });
    const adapterError: VirtualResourcePortError = { code: "unavailable" };
    const unavailable = await createVirtualResourceReader({
      describe: async () => ({ ok: false, error: adapterError }),
      readRange: async () => ({ ok: false, error: adapterError }),
    }).read({ uri: URI, mode: "metadata" });

    expect(mismatch).toEqual({
      ok: false,
      error: { code: "resource-identity-mismatch" },
    });
    expect(unavailable).toEqual({ ok: false, error: adapterError });
  });

  test("propagates cancellation before asking an adapter", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await createVirtualResourceReader(port()).read(
      { uri: URI, mode: "metadata" },
      controller.signal,
    );

    expect(result).toEqual({ ok: false, error: { code: "cancelled" } });
  });
});
