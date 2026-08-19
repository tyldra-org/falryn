import { describe, expect, test } from "bun:test";
import { CONTENT_DIGEST_ALGORITHM, parseArtifactRecord } from "./artifact.ts";
import { sessionId } from "./identity.ts";
import { parseSessionRecord } from "./records.ts";
import { parseExportRecordLine } from "./session-replay.ts";

describe("parseExportRecordLine", () => {
  test("accepts a session record the writer would emit", () => {
    const record = parseSessionRecord({
      sessionId: "s1",
      workspaceId: "w",
      streamId: "stream-s1",
      title: null,
      configurationGeneration: 0,
      startedAt: "2026-07-31T12:00:00.000Z",
      closedAt: null,
      outcome: null,
    });
    expect(record.ok).toBe(true);
    const parsed = parseExportRecordLine({
      entity: "session",
      record: record.ok ? record.value : null,
    });
    expect(parsed.ok && parsed.value.entity).toBe("session");
    expect(parsed.ok && parsed.value.entity === "session" && parsed.value.record.sessionId).toBe(
      sessionId.from("s1"),
    );
  });

  test("refuses an unknown entity rather than widening it", () => {
    const parsed = parseExportRecordLine({ entity: "secret", record: {} });
    expect(parsed.ok).toBe(false);
  });

  test("accepts an artifact record the writer would emit", () => {
    const record = parseArtifactRecord({
      artifactId: "artifact-1",
      digest: `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`,
      mediaType: "text/plain",
      encoding: "identity",
      byteLength: 12,
      sensitivity: "user-content",
      origin: "tool-output",
      invocationId: null,
      createdAt: "2026-07-31T12:00:00.000Z",
      finalizedAt: "2026-07-31T12:00:01.000Z",
      availability: "available",
    });
    expect(record.ok).toBe(true);
    const parsed = parseExportRecordLine({
      entity: "artifact",
      record: record.ok ? record.value : null,
    });
    expect(parsed.ok && parsed.value.entity).toBe("artifact");
  });
});
