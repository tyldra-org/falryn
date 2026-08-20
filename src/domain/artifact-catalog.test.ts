import { describe, expect, test } from "bun:test";
import { type ArtifactRecord, artifactId, CONTENT_DIGEST_ALGORITHM } from "./artifact.ts";
import {
  DEFAULT_ARTIFACT_LIST_LIMIT,
  entryFromRecord,
  MAX_ARTIFACT_CATALOG,
  queryArtifactCatalog,
} from "./artifact-catalog.ts";

function record(id: string, createdAt: string): ArtifactRecord {
  return {
    artifactId: artifactId.from(id),
    digest: `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}` as ArtifactRecord["digest"],
    mediaType: "text/plain",
    encoding: "identity",
    byteLength: 4,
    sensitivity: "user-content",
    origin: "tool-output",
    invocationId: null,
    createdAt: createdAt as ArtifactRecord["createdAt"],
    finalizedAt: createdAt as ArtifactRecord["finalizedAt"],
    availability: "available",
  };
}

describe("queryArtifactCatalog", () => {
  test("sorts newest first and reports omitted rows", () => {
    const result = queryArtifactCatalog(
      [
        record("a1", "2026-07-31T12:00:01.000Z"),
        record("a2", "2026-07-31T12:00:02.000Z"),
        record("a3", "2026-07-31T12:00:03.000Z"),
      ],
      2,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.artifacts.map((entry) => String(entry.artifactId))).toEqual(["a3", "a2"]);
      expect(result.value.omitted).toBe(1);
    }
  });

  test("rejects limits outside the catalog bound", () => {
    expect(queryArtifactCatalog([], 0).ok).toBe(false);
    expect(queryArtifactCatalog([], MAX_ARTIFACT_CATALOG + 1).ok).toBe(false);
    expect(queryArtifactCatalog([], DEFAULT_ARTIFACT_LIST_LIMIT).ok).toBe(true);
  });

  test("maps records through entryFromRecord", () => {
    const source = record("keep", "2026-07-31T12:00:00.000Z");
    expect(entryFromRecord(source).artifactId).toEqual(source.artifactId);
  });
});
