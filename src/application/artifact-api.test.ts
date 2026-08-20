import { describe, expect, test } from "bun:test";

import {
  ARTIFACT_API_VERSION,
  type ArtifactRecord,
  artifactId,
  CONTENT_DIGEST_ALGORITHM,
  type ContentDigest,
  ok,
} from "../domain/index.ts";
import { createDurableArtifactApi } from "./artifact-api.ts";

const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;

function available(id: string): ArtifactRecord {
  return {
    artifactId: artifactId.from(id),
    digest: DIGEST as ArtifactRecord["digest"],
    mediaType: "text/plain",
    encoding: "identity",
    byteLength: 1,
    sensitivity: "user-content",
    origin: "tool-output",
    invocationId: null,
    createdAt: "2026-08-18T12:00:00.000Z" as ArtifactRecord["createdAt"],
    finalizedAt: "2026-08-18T12:00:01.000Z" as ArtifactRecord["finalizedAt"],
    availability: "available",
  };
}

function ports(record: ArtifactRecord) {
  return {
    artifacts: {
      reserve: () => ok({ cancelledAfterCommit: false }),
      finalize: () => ok({ cancelledAfterCommit: false }),
      quarantine: () => ok({ cancelledAfterCommit: false }),
      get: () => ok(record),
      findByDigest: () => ok([]),
      listByInvocation: () => ok([]),
      list: () => ok([]),
      referencedDigests: () => ok(new Set<ContentDigest>()),
    },
    provenance: {
      listParents: () => ok([]),
      listChildren: () => ok([]),
      insert: () => ok({ cancelledAfterCommit: false }),
    },
  };
}

describe("the durable artifact API", () => {
  test("describes a record with empty lineage", () => {
    const api = createDurableArtifactApi(ports(available("a1")));
    const described = api.describe(artifactId.from("a1"));
    expect(described.ok && described.value.schemaVersion).toBe(ARTIFACT_API_VERSION);
    expect(described.ok && described.value.parents).toEqual([]);
  });

  test("refuses a self-parent before insert", () => {
    const api = createDurableArtifactApi(ports(available("same")));
    const linked = api.link({
      childArtifactId: artifactId.from("same"),
      parentArtifactId: artifactId.from("same"),
      transformation: "derived-from",
      createdAt: "2026-08-18T12:00:00.000Z" as ArtifactRecord["createdAt"],
    });
    expect(linked.ok || linked.error).toMatchObject({ code: "self-parent" });
  });

  test("reports integrity without changing the record", () => {
    const api = createDurableArtifactApi(ports(available("a1")));
    const report = api.reportIntegrity(artifactId.from("a1"), true);
    expect(report.ok && report.value.intact).toBe(true);
    expect(report.ok && report.value.availability).toBe("available");
  });
});
