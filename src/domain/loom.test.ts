/**
 * Loom manifests: digest verification, cache, and exact retrieval.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { CONTENT_DIGEST_ALGORITHM, contentDigest } from "./artifact.ts";
import type { ContentHasherPort } from "./blob.ts";
import { loomManifestId } from "./identity.ts";
import {
  commitLoomManifest,
  createLoomCache,
  DEFAULT_LOOM_STRATEGY,
  describeLoomError,
  retrieveLoomProjection,
} from "./loom.ts";
import { timestampFromEpochMilliseconds } from "./time.ts";

const encoder = new TextEncoder();
const TEXT = "export const ok = true;\nline two\nline three\n";
const TEXT_BYTES = encoder.encode(TEXT);
const SECRET = "sk-live-SECRET-MUST-NOT-ESCAPE";

function digestOf(bytes: Uint8Array): string {
  return `${CONTENT_DIGEST_ALGORITHM}:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hasher(): ContentHasherPort {
  return {
    create() {
      const hash = createHash("sha256");
      return {
        update(chunk) {
          hash.update(chunk);
        },
        digest() {
          return contentDigest.from(`${CONTENT_DIGEST_ALGORITHM}:${hash.digest("hex")}`);
        },
      };
    },
  };
}

function member(
  overrides: {
    readonly artifactId?: string;
    readonly bytes?: Uint8Array;
    readonly required?: boolean;
    readonly sensitivity?: string;
    readonly availability?: string;
    readonly encoding?: "identity" | "gzip";
    readonly protectedFacts?: readonly string[];
  } = {},
) {
  const bytes = overrides.bytes ?? TEXT_BYTES;
  return {
    artifactId: overrides.artifactId ?? "src-main",
    digest: digestOf(bytes),
    byteLength: bytes.byteLength,
    mediaType: "text/plain",
    encoding: overrides.encoding ?? "identity",
    sensitivity: overrides.sensitivity ?? "user-content",
    availability: overrides.availability ?? "available",
    required: overrides.required ?? true,
    protectedFacts: overrides.protectedFacts ?? ["exit=0"],
    summary: "module source",
    bytes,
  };
}

function commit(members = [member()]) {
  return commitLoomManifest({
    id: "loom-1",
    workspaceId: "ws-1",
    sessionId: "sess-1",
    members: members.map(({ bytes: _bytes, ...rest }) => rest),
  });
}

describe("commitLoomManifest", () => {
  test("commits an exact-recoverable single-member group", () => {
    const committed = commit();
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    expect(committed.value.exactRecoverable).toBe(true);
    expect(committed.value.members).toHaveLength(1);
  });

  test("is not exact-recoverable when a required member is missing", () => {
    const committed = commit([member({ availability: "missing" })]);
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    expect(committed.value.exactRecoverable).toBe(false);
  });

  test("rejects a duplicate member identity", () => {
    const first = member();
    const second = member({ artifactId: first.artifactId, bytes: encoder.encode("other") });
    const committed = commit([first, second]);
    expect(committed.ok).toBe(false);
    if (committed.ok) {
      return;
    }
    expect(committed.error).toEqual({ kind: "loom", code: "malformed", field: "members" });
  });
});

describe("retrieveLoomProjection", () => {
  test("retrieves a complete verified member as exact-source", () => {
    const committed = commit();
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    const retrieved = retrieveLoomProjection(
      {
        id: "ev-1",
        manifest: committed.value,
        expectedWorkspaceId: "ws-1",
        expectedSessionId: "sess-1",
        members: [{ artifactId: "src-main", bytes: TEXT_BYTES }],
        projection: { kind: "exact", member: "src-main" },
      },
      hasher(),
    );
    expect(retrieved.ok).toBe(true);
    if (!retrieved.ok) {
      return;
    }
    expect(retrieved.value.fidelity).toBe("exact-source");
    expect(retrieved.value.claimsExact).toBe(true);
    expect(retrieved.value.complete).toBe(true);
    expect(retrieved.value.text).toBe(TEXT);
    expect(retrieved.value.cache).toBe("miss");
    expect(retrieved.value.protectedFacts).toEqual(["exit=0"]);
    expect(retrieved.value.handle.manifestId).toBe(loomManifestId.from("loom-1"));
  });

  test("returns a bounded range without claiming exact-source", () => {
    const committed = commit();
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    const retrieved = retrieveLoomProjection(
      {
        id: "ev-1",
        manifest: committed.value,
        expectedWorkspaceId: "ws-1",
        expectedSessionId: "sess-1",
        members: [{ artifactId: "src-main", bytes: TEXT_BYTES }],
        projection: { kind: "range", member: "src-main", offset: 0, length: 6 },
      },
      hasher(),
    );
    expect(retrieved.ok).toBe(true);
    if (!retrieved.ok) {
      return;
    }
    expect(retrieved.value.fidelity).toBe("bounded-excerpt");
    expect(retrieved.value.claimsExact).toBe(false);
    expect(retrieved.value.exactSource).toBeNull();
    expect(retrieved.value.text).toBe("export");
  });

  test("head-tail omits the middle and never claims exact-source", () => {
    const committed = commit();
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    const retrieved = retrieveLoomProjection(
      {
        id: "ev-1",
        manifest: committed.value,
        expectedWorkspaceId: "ws-1",
        expectedSessionId: "sess-1",
        members: [{ artifactId: "src-main", bytes: TEXT_BYTES }],
        projection: { kind: "head-tail", member: "src-main", headBytes: 6, tailBytes: 6 },
      },
      hasher(),
    );
    expect(retrieved.ok).toBe(true);
    if (!retrieved.ok) {
      return;
    }
    expect(retrieved.value.fidelity).toBe("bounded-excerpt");
    expect(retrieved.value.claimsExact).toBe(false);
    expect(retrieved.value.text.startsWith("export")).toBe(true);
    expect(retrieved.value.omissions).toEqual([
      { kind: "bytes", count: TEXT_BYTES.byteLength - 12 },
    ]);
  });

  test("search hits are a deterministic transform", () => {
    const committed = commit();
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    const retrieved = retrieveLoomProjection(
      {
        id: "ev-1",
        manifest: committed.value,
        expectedWorkspaceId: "ws-1",
        expectedSessionId: "sess-1",
        members: [{ artifactId: "src-main", bytes: TEXT_BYTES }],
        projection: { kind: "search-hits", member: "src-main", query: "line" },
      },
      hasher(),
    );
    expect(retrieved.ok).toBe(true);
    if (!retrieved.ok) {
      return;
    }
    expect(retrieved.value.fidelity).toBe("deterministic-transform");
    expect(retrieved.value.claimsExact).toBe(false);
    expect(retrieved.value.hits.length).toBeGreaterThan(0);
    expect(retrieved.value.lineage).toEqual([DEFAULT_LOOM_STRATEGY, "search-hits"]);
  });

  test("empty search hits refuse as empty rather than exact-source", () => {
    const committed = commit();
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    const retrieved = retrieveLoomProjection(
      {
        id: "ev-1",
        manifest: committed.value,
        expectedWorkspaceId: "ws-1",
        expectedSessionId: "sess-1",
        members: [{ artifactId: "src-main", bytes: TEXT_BYTES }],
        projection: { kind: "search-hits", member: "src-main", query: "no-such-token" },
      },
      hasher(),
    );
    expect(retrieved).toEqual({
      ok: false,
      error: { kind: "loom", code: "empty", field: "query" },
    });
  });

  test("refuses a digest mismatch", () => {
    const committed = commit();
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    const tampered = Uint8Array.from(TEXT_BYTES);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    const retrieved = retrieveLoomProjection(
      {
        id: "ev-1",
        manifest: committed.value,
        expectedWorkspaceId: "ws-1",
        expectedSessionId: "sess-1",
        members: [{ artifactId: "src-main", bytes: tampered }],
        projection: { kind: "exact", member: "src-main" },
      },
      hasher(),
    );
    expect(retrieved).toEqual({
      ok: false,
      error: { kind: "loom", code: "checksum", field: "digest" },
    });
  });

  test("refuses missing member bytes", () => {
    const committed = commit();
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    const retrieved = retrieveLoomProjection(
      {
        id: "ev-1",
        manifest: committed.value,
        expectedWorkspaceId: "ws-1",
        expectedSessionId: "sess-1",
        members: [{ artifactId: "src-main", bytes: null }],
        projection: { kind: "exact", member: "src-main" },
      },
      hasher(),
    );
    expect(retrieved).toEqual({
      ok: false,
      error: { kind: "loom", code: "unavailable", field: "member" },
    });
  });

  test("refuses restricted content and never caches it", () => {
    const cache = createLoomCache();
    const committed = commit([member({ sensitivity: "restricted" })]);
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    const retrieved = retrieveLoomProjection(
      {
        id: "ev-1",
        manifest: committed.value,
        expectedWorkspaceId: "ws-1",
        expectedSessionId: "sess-1",
        members: [{ artifactId: "src-main", bytes: TEXT_BYTES }],
        projection: { kind: "exact", member: "src-main" },
      },
      hasher(),
      cache,
    );
    expect(retrieved).toEqual({
      ok: false,
      error: { kind: "loom", code: "secret", field: "sensitivity" },
    });
    expect(cache.size).toBe(0);
  });

  test("denies a foreign workspace or session", () => {
    const committed = commit();
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    const retrieved = retrieveLoomProjection(
      {
        id: "ev-1",
        manifest: committed.value,
        expectedWorkspaceId: "ws-other",
        expectedSessionId: "sess-1",
        members: [{ artifactId: "src-main", bytes: TEXT_BYTES }],
        projection: { kind: "exact", member: "src-main" },
      },
      hasher(),
    );
    expect(retrieved).toEqual({
      ok: false,
      error: { kind: "loom", code: "denied", field: "scope" },
    });
  });

  test("refuses an expired retention window", () => {
    const committed = commitLoomManifest({
      id: "loom-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      members: [member()].map(({ bytes: _bytes, ...rest }) => rest),
      retentionUntil: timestampFromEpochMilliseconds(1_000),
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    const retrieved = retrieveLoomProjection(
      {
        id: "ev-1",
        manifest: committed.value,
        expectedWorkspaceId: "ws-1",
        expectedSessionId: "sess-1",
        members: [{ artifactId: "src-main", bytes: TEXT_BYTES }],
        projection: { kind: "exact", member: "src-main" },
        now: timestampFromEpochMilliseconds(2_000),
      },
      hasher(),
    );
    expect(retrieved).toEqual({
      ok: false,
      error: { kind: "loom", code: "expired", field: "retentionUntil" },
    });
  });

  test("reuses a matching cache entry and invalidates on digest change", () => {
    const cache = createLoomCache();
    const committed = commit();
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    const input = {
      id: "ev-1",
      manifest: committed.value,
      expectedWorkspaceId: "ws-1",
      expectedSessionId: "sess-1",
      members: [{ artifactId: "src-main", bytes: TEXT_BYTES }],
      projection: { kind: "exact", member: "src-main" as const },
    };
    const first = retrieveLoomProjection(input, hasher(), cache);
    const second = retrieveLoomProjection(input, hasher(), cache);
    expect(first.ok && first.value.cache).toBe("miss");
    expect(second.ok && second.value.cache).toBe("hit");
    expect(cache.invalidate({ digest: contentDigest.from(digestOf(TEXT_BYTES)) })).toBe(1);
    expect(cache.size).toBe(0);
  });

  test("does not treat structural or lossy projections as exact-source", () => {
    const committed = commit();
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    const structural = retrieveLoomProjection(
      {
        id: "ev-1",
        manifest: committed.value,
        expectedWorkspaceId: "ws-1",
        expectedSessionId: "sess-1",
        members: [{ artifactId: "src-main", bytes: TEXT_BYTES }],
        projection: { kind: "structural", member: "src-main" },
      },
      hasher(),
    );
    expect(structural).toEqual({
      ok: false,
      error: { kind: "loom", code: "unsupported", field: "projection" },
    });
  });

  test("never reports a secret in an error", () => {
    const committed = commit();
    expect(committed.ok).toBe(true);
    if (!committed.ok) {
      return;
    }
    const parsed = retrieveLoomProjection(
      {
        id: "ev-1",
        manifest: committed.value,
        expectedWorkspaceId: SECRET,
        expectedSessionId: "sess-1",
        members: [],
        projection: { kind: "exact", member: "src-main" },
      },
      hasher(),
    );
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
  });

  test("describeLoomError names the field without a payload", () => {
    expect(describeLoomError({ kind: "loom", code: "checksum", field: "digest" })).toBe(
      "checksum digest",
    );
  });
});
