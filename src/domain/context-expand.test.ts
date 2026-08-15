/**
 * Context expansion: exact retrieval, cache reuse, and invalidation.
 */

import { describe, expect, test } from "bun:test";

import { artifactId, CONTENT_DIGEST_ALGORITHM, contentDigest } from "./artifact.ts";
import type { ContentHasherPort } from "./blob.ts";
import {
  createContextExpandCache,
  DEFAULT_CONTEXT_EXPAND_STRATEGY,
  describeContextExpandError,
  expandContextEvidence,
  HARD_CONTEXT_EXPAND_MAX_BYTES,
} from "./context-expand.ts";

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;
const OTHER_DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"b".repeat(64)}`;
const SECRET = "sk-live-SECRET-MUST-NOT-ESCAPE";
const TEXT = "export const ok = true;\n";
const TEXT_BYTES = new TextEncoder().encode(TEXT).byteLength;

function hasherReturning(digest: string): ContentHasherPort {
  return {
    create() {
      return {
        update() {},
        digest() {
          return contentDigest.from(digest);
        },
      };
    },
  };
}

describe("expandContextEvidence", () => {
  test("retrieves a complete verified inline source as exact-source", () => {
    const expanded = expandContextEvidence(
      {
        id: "ev-1",
        freshness: "live",
        sensitivity: "user-content",
        source: {
          kind: "inline",
          text: TEXT,
          digest: DIGEST,
          byteLength: TEXT_BYTES,
        },
      },
      hasherReturning(DIGEST),
    );
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) {
      return;
    }
    expect(expanded.value.fidelity).toBe("exact-source");
    expect(expanded.value.claimsExact).toBe(true);
    expect(expanded.value.complete).toBe(true);
    expect(expanded.value.text).toBe(TEXT);
    expect(expanded.value.cache).toBe("miss");
    expect(expanded.value.exactSource.kind).toBe("inline");
  });

  test("returns a bounded range without claiming exact-source", () => {
    const expanded = expandContextEvidence(
      {
        id: "ev-1",
        freshness: "live",
        sensitivity: "user-content",
        offset: 0,
        length: 6,
        source: {
          kind: "inline",
          text: TEXT,
          digest: DIGEST,
          byteLength: TEXT_BYTES,
        },
      },
      hasherReturning(DIGEST),
    );
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) {
      return;
    }
    expect(expanded.value.fidelity).toBe("bounded-excerpt");
    expect(expanded.value.claimsExact).toBe(false);
    expect(expanded.value.complete).toBe(false);
    expect(expanded.value.text).toBe("export");
    expect(expanded.value.exactSource.digest).toBe(contentDigest.from(DIGEST));
  });

  test("reuses a matching cache entry and misses after invalidation", () => {
    const cache = createContextExpandCache();
    const input = {
      id: "ev-1",
      freshness: "live" as const,
      sensitivity: "user-content",
      source: {
        kind: "inline" as const,
        text: TEXT,
        digest: DIGEST,
        byteLength: TEXT_BYTES,
      },
    };
    const first = expandContextEvidence(input, hasherReturning(DIGEST), cache);
    const second = expandContextEvidence(input, hasherReturning(DIGEST), cache);
    expect(first.ok && first.value.cache).toBe("miss");
    expect(second.ok && second.value.cache).toBe("hit");
    expect(cache.size).toBe(1);
    expect(cache.invalidate({ digest: contentDigest.from(DIGEST) })).toBe(1);
    const third = expandContextEvidence(input, hasherReturning(DIGEST), cache);
    expect(third.ok && third.value.cache).toBe("miss");
  });

  test("treats a strategy or configuration change as a cache miss", () => {
    const cache = createContextExpandCache();
    const source = {
      kind: "inline" as const,
      text: TEXT,
      digest: DIGEST,
      byteLength: TEXT_BYTES,
    };
    const first = expandContextEvidence(
      {
        id: "ev-1",
        freshness: "live",
        sensitivity: "user-content",
        source,
      },
      hasherReturning(DIGEST),
      cache,
    );
    const second = expandContextEvidence(
      {
        id: "ev-1",
        freshness: "live",
        sensitivity: "user-content",
        strategyVersion: "expand.v2",
        configuration: "policy-2",
        source,
      },
      hasherReturning(DIGEST),
      cache,
    );
    expect(first.ok && first.value.cache).toBe("miss");
    expect(second.ok && second.value.cache).toBe("miss");
    expect(first.ok && first.value.exactSource).toBeDefined();
    expect(DEFAULT_CONTEXT_EXPAND_STRATEGY).toBe("expand.v1");
  });

  test("refuses a digest mismatch as checksum without echoing payload", () => {
    const expanded = expandContextEvidence(
      {
        id: "ev-secret",
        freshness: "live",
        sensitivity: "user-content",
        source: {
          kind: "inline",
          text: SECRET,
          digest: DIGEST,
          byteLength: new TextEncoder().encode(SECRET).byteLength,
        },
      },
      hasherReturning(OTHER_DIGEST),
    );
    expect(expanded.ok).toBe(false);
    if (expanded.ok) {
      return;
    }
    expect(expanded.error).toEqual({
      kind: "context-expand",
      code: "checksum",
      field: "digest",
    });
    expect(describeContextExpandError(expanded.error)).toBe("checksum digest");
    expect(describeContextExpandError(expanded.error)).not.toContain(SECRET);
  });

  test("refuses missing artifact bytes as unavailable", () => {
    const expanded = expandContextEvidence(
      {
        id: "ev-1",
        freshness: "live",
        sensitivity: "user-content",
        source: {
          kind: "artifact",
          artifactId: "source-1",
          digest: DIGEST,
          byteLength: TEXT_BYTES,
          bytes: null,
        },
      },
      hasherReturning(DIGEST),
    );
    expect(expanded.ok).toBe(false);
    if (expanded.ok) {
      return;
    }
    expect(expanded.error.code).toBe("unavailable");
    expect(expanded.error.field).toBe("source");
  });

  test("refuses restricted sensitivity as secret and does not cache it", () => {
    const cache = createContextExpandCache();
    const expanded = expandContextEvidence(
      {
        id: "ev-1",
        freshness: "live",
        sensitivity: "restricted",
        source: {
          kind: "inline",
          text: SECRET,
          digest: DIGEST,
          byteLength: new TextEncoder().encode(SECRET).byteLength,
        },
      },
      hasherReturning(DIGEST),
      cache,
    );
    expect(expanded.ok).toBe(false);
    if (expanded.ok) {
      return;
    }
    expect(expanded.error.code).toBe("secret");
    expect(cache.size).toBe(0);
    expect(describeContextExpandError(expanded.error)).not.toContain(SECRET);
  });

  test("refuses a full retrieve that exceeds the byte bound", () => {
    const expanded = expandContextEvidence(
      {
        id: "ev-1",
        freshness: "live",
        sensitivity: "user-content",
        maxBytes: 4,
        source: {
          kind: "inline",
          text: TEXT,
          digest: DIGEST,
          byteLength: TEXT_BYTES,
        },
      },
      hasherReturning(DIGEST),
    );
    expect(expanded.ok).toBe(false);
    if (expanded.ok) {
      return;
    }
    expect(expanded.error.code).toBe("oversized");
    expect(expanded.error.field).toBe("source");
  });

  test("preserves stale freshness and never rewrites it to live", () => {
    const expanded = expandContextEvidence(
      {
        id: "ev-1",
        freshness: "stale",
        sensitivity: "user-content",
        source: {
          kind: "inline",
          text: TEXT,
          digest: DIGEST,
          byteLength: TEXT_BYTES,
        },
      },
      hasherReturning(DIGEST),
    );
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) {
      return;
    }
    expect(expanded.value.freshness).toBe("stale");
    expect(expanded.value.freshness).not.toBe("live");
  });

  test("invalidates a lost artifact entry", () => {
    const cache = createContextExpandCache();
    const bytes = new TextEncoder().encode(TEXT);
    const input = {
      id: "ev-1",
      freshness: "live" as const,
      sensitivity: "user-content",
      source: {
        kind: "artifact" as const,
        artifactId: "source-1",
        digest: DIGEST,
        byteLength: bytes.byteLength,
        bytes,
      },
    };
    const first = expandContextEvidence(input, hasherReturning(DIGEST), cache);
    expect(first.ok && first.value.cache).toBe("miss");
    expect(cache.invalidate({ artifactId: artifactId.from("source-1") })).toBe(1);
    const second = expandContextEvidence(input, hasherReturning(DIGEST), cache);
    expect(second.ok && second.value.cache).toBe("miss");
  });

  test("refuses an oversized maxBytes bound", () => {
    const expanded = expandContextEvidence(
      {
        id: "ev-1",
        freshness: "live",
        sensitivity: "user-content",
        maxBytes: HARD_CONTEXT_EXPAND_MAX_BYTES + 1,
        source: {
          kind: "inline",
          text: TEXT,
          digest: DIGEST,
          byteLength: TEXT_BYTES,
        },
      },
      hasherReturning(DIGEST),
    );
    expect(expanded.ok).toBe(false);
    if (expanded.ok) {
      return;
    }
    expect(expanded.error.code).toBe("oversized");
    expect(expanded.error.field).toBe("maxBytes");
  });
});
