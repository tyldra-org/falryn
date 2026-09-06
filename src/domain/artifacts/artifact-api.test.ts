import { describe, expect, test } from "bun:test";

import { type ArtifactRecord, artifactId, CONTENT_DIGEST_ALGORITHM } from "./artifact.ts";
import {
  ARTIFACT_API_VERSION,
  ARTIFACT_TRANSFORMATIONS,
  createArtifactApi,
  MAX_ARTIFACT_PARENTS,
  parseArtifactProvenanceEdge,
} from "./artifact-api.ts";

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;
const CREATED = "2026-08-18T12:00:00.000Z";
const FINALIZED = "2026-08-18T12:00:01.000Z";

function available(id: string, overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifactId: artifactId.from(id),
    digest: DIGEST as ArtifactRecord["digest"],
    mediaType: "text/plain",
    encoding: "identity",
    byteLength: 4,
    sensitivity: "user-content",
    origin: "tool-output",
    invocationId: null,
    createdAt: CREATED as ArtifactRecord["createdAt"],
    finalizedAt: FINALIZED as ArtifactRecord["finalizedAt"],
    availability: "available",
    ...overrides,
  };
}

describe("a provenance edge", () => {
  test("parses a closed transformation", () => {
    const parsed = parseArtifactProvenanceEdge({
      schemaVersion: ARTIFACT_API_VERSION,
      childArtifactId: "child1",
      parentArtifactId: "parent1",
      transformation: "derived-from",
      createdAt: CREATED,
    });
    expect(parsed.ok).toBe(true);
    expect(ARTIFACT_TRANSFORMATIONS).toContain("copied-from");
  });

  test("refuses a self-parent", () => {
    const parsed = parseArtifactProvenanceEdge({
      schemaVersion: ARTIFACT_API_VERSION,
      childArtifactId: "same",
      parentArtifactId: "same",
      transformation: "copied-from",
      createdAt: CREATED,
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok || parsed.error.code).toBe("self-parent");
  });

  test("refuses an unknown transformation without echoing it", () => {
    const parsed = parseArtifactProvenanceEdge({
      schemaVersion: ARTIFACT_API_VERSION,
      childArtifactId: "child1",
      parentArtifactId: "parent1",
      transformation: "decoded-from",
      createdAt: CREATED,
    });
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("decoded-from");
  });
});

describe("the typed artifact API", () => {
  test("describes a registered record with empty lineage", () => {
    const api = createArtifactApi();
    expect(api.register(available("a1")).ok).toBe(true);
    const described = api.describe(artifactId.from("a1"));
    expect(described.ok).toBe(true);
    if (!described.ok) {
      return;
    }
    expect(described.value.parents).toEqual([]);
    expect(described.value.children).toEqual([]);
    expect(described.value.schemaVersion).toBe(ARTIFACT_API_VERSION);
  });

  test("links an available child to an available parent", () => {
    const api = createArtifactApi();
    api.register(available("parent"));
    api.register(available("child"));
    const linked = api.link({
      childArtifactId: artifactId.from("child"),
      parentArtifactId: artifactId.from("parent"),
      transformation: "derived-from",
      createdAt: CREATED as ArtifactRecord["createdAt"],
    });
    expect(linked.ok).toBe(true);
    const lineage = api.describe(artifactId.from("child"));
    expect(lineage.ok && lineage.value.parents).toHaveLength(1);
    const fromParent = api.describe(artifactId.from("parent"));
    expect(fromParent.ok && fromParent.value.children).toHaveLength(1);
  });

  test("refuses a reserved parent rather than inventing a complete lineage", () => {
    const api = createArtifactApi();
    api.register(available("child"));
    api.register(available("parent", { availability: "reserved", finalizedAt: null }));
    const linked = api.link({
      childArtifactId: artifactId.from("child"),
      parentArtifactId: artifactId.from("parent"),
      transformation: "extracted-from",
      createdAt: CREATED as ArtifactRecord["createdAt"],
    });
    expect(linked.ok).toBe(false);
    expect(linked.ok || linked.error).toMatchObject({
      kind: "artifact-api",
      code: "unavailable",
    });
  });

  test("refuses a missing parent", () => {
    const api = createArtifactApi();
    api.register(available("child"));
    const linked = api.link({
      childArtifactId: artifactId.from("child"),
      parentArtifactId: artifactId.from("ghost"),
      transformation: "copied-from",
      createdAt: CREATED as ArtifactRecord["createdAt"],
    });
    expect(linked.ok || linked.error).toMatchObject({ code: "missing-parent" });
  });

  test("refuses a cycle", () => {
    const api = createArtifactApi();
    api.register(available("a"));
    api.register(available("b"));
    expect(
      api.link({
        childArtifactId: artifactId.from("b"),
        parentArtifactId: artifactId.from("a"),
        transformation: "derived-from",
        createdAt: CREATED as ArtifactRecord["createdAt"],
      }).ok,
    ).toBe(true);
    const cycle = api.link({
      childArtifactId: artifactId.from("a"),
      parentArtifactId: artifactId.from("b"),
      transformation: "derived-from",
      createdAt: CREATED as ArtifactRecord["createdAt"],
    });
    expect(cycle.ok || cycle.error).toMatchObject({ code: "cycle" });
  });

  test("refuses a duplicate edge", () => {
    const api = createArtifactApi();
    api.register(available("parent"));
    api.register(available("child"));
    const request = {
      childArtifactId: artifactId.from("child"),
      parentArtifactId: artifactId.from("parent"),
      transformation: "copied-from" as const,
      createdAt: CREATED as ArtifactRecord["createdAt"],
    };
    expect(api.link(request).ok).toBe(true);
    const repeated = api.link(request);
    expect(repeated.ok).toBe(false);
    expect(repeated.ok || repeated.error).toMatchObject({
      code: "already-linked",
    });
  });

  test("bounds how many parents one child may declare", () => {
    const api = createArtifactApi();
    api.register(available("child"));
    for (let index = 0; index < MAX_ARTIFACT_PARENTS; index += 1) {
      const id = `p${index}`;
      api.register(available(id));
      expect(
        api.link({
          childArtifactId: artifactId.from("child"),
          parentArtifactId: artifactId.from(id),
          transformation: "derived-from",
          createdAt: CREATED as ArtifactRecord["createdAt"],
        }).ok,
      ).toBe(true);
    }
    api.register(available("extra"));
    const overflow = api.link({
      childArtifactId: artifactId.from("child"),
      parentArtifactId: artifactId.from("extra"),
      transformation: "derived-from",
      createdAt: CREATED as ArtifactRecord["createdAt"],
    });
    expect(overflow.ok || overflow.error).toMatchObject({ code: "too-many-parents" });
  });

  test("walks ancestors without rewriting edges", () => {
    const api = createArtifactApi();
    api.register(available("root"));
    api.register(available("mid"));
    api.register(available("leaf"));
    api.link({
      childArtifactId: artifactId.from("mid"),
      parentArtifactId: artifactId.from("root"),
      transformation: "derived-from",
      createdAt: CREATED as ArtifactRecord["createdAt"],
    });
    api.link({
      childArtifactId: artifactId.from("leaf"),
      parentArtifactId: artifactId.from("mid"),
      transformation: "extracted-from",
      createdAt: CREATED as ArtifactRecord["createdAt"],
    });
    const ancestors = api.ancestors(artifactId.from("leaf"));
    expect(ancestors.ok && ancestors.value.map((edge) => edge.parentArtifactId)).toEqual([
      artifactId.from("mid"),
      artifactId.from("root"),
    ]);
    const descendants = api.descendants(artifactId.from("root"));
    expect(descendants.ok && descendants.value.map((edge) => edge.childArtifactId)).toEqual([
      artifactId.from("mid"),
      artifactId.from("leaf"),
    ]);
  });

  test("reports integrity without mutating availability", () => {
    const api = createArtifactApi();
    api.register(available("a1"));
    const report = api.reportIntegrity(artifactId.from("a1"), false);
    expect(report.ok && report.value.intact).toBe(false);
    expect(report.ok && report.value.availability).toBe("available");
    const still = api.describe(artifactId.from("a1"));
    expect(still.ok && still.value.record.availability).toBe("available");
  });

  test("treats cancellation before commit as cancelled", () => {
    const api = createArtifactApi();
    api.register(available("parent"));
    api.register(available("child"));
    const linked = api.link(
      {
        childArtifactId: artifactId.from("child"),
        parentArtifactId: artifactId.from("parent"),
        transformation: "derived-from",
        createdAt: CREATED as ArtifactRecord["createdAt"],
      },
      AbortSignal.abort(),
    );
    expect(linked.ok || linked.error).toMatchObject({ code: "cancelled" });
    const lineage = api.describe(artifactId.from("child"));
    expect(lineage.ok && lineage.value.parents).toEqual([]);
  });
});
