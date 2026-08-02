import { describe, expect, test } from "bun:test";

import { runId } from "./identity.ts";
import {
  ARTIFACT_RECOVERY_OUTCOMES,
  DEFAULT_RECOVERY_WINDOW_MS,
  isPresumedLive,
  MAX_RECOVERY_WINDOW_MS,
  MIN_RECOVERY_WINDOW_MS,
  parseRunRecord,
  type RunRecord,
  TEMPORARY_BLOB_OUTCOMES,
} from "./run.ts";

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-1",
    startedAt: "2026-07-31T12:00:00.000Z",
    endedAt: null,
    schemaVersion: 3,
    ...overrides,
  };
}

describe("a stored run row", () => {
  test("becomes a record when every field is what it claims", () => {
    const parsed = parseRunRecord(row({ endedAt: "2026-07-31T12:05:00.000Z" }));
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.schemaVersion).toBe(3);
  });

  test("keeps a null end time, which is the whole point of the row", () => {
    const parsed = parseRunRecord(row());
    expect(parsed.ok && parsed.value.endedAt).toBeNull();
  });

  test("is refused when an identity, a time, or a version is not one", () => {
    for (const broken of [
      { runId: "" },
      { startedAt: "not a timestamp" },
      { endedAt: 5 },
      { schemaVersion: -1 },
      { schemaVersion: 1.5 },
    ]) {
      expect(parseRunRecord(row(broken)).ok).toBe(false);
    }
  });

  test("reports a path and an issue code and never the rejected value", () => {
    const parsed = parseRunRecord(row({ startedAt: "1999-not-a-time" }));
    const issues = parsed.ok ? [] : parsed.error;
    expect(issues.map((issue) => issue.path)).toEqual(["startedAt"]);
    expect(JSON.stringify(issues)).not.toContain("1999-not-a-time");
  });
});

describe("liveness", () => {
  const thisRun = runId.from("run-this");

  function record(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
      runId: runId.from("run-other"),
      startedAt: "2026-07-31T12:00:00.000Z" as RunRecord["startedAt"],
      endedAt: null,
      schemaVersion: 3,
      ...overrides,
    };
  }

  test("presumes an unended run is still writing, whatever its age", () => {
    // With no liveness probe, this is the only rule that cannot delete a
    // concurrent Falryn's in-flight bytes. Age is deliberately not consulted:
    // a session that outlives any window is still a live session.
    expect(isPresumedLive(record(), thisRun)).toBe(true);
  });

  test("does not presume a run that recorded its end", () => {
    expect(
      isPresumedLive(
        record({ endedAt: "2026-07-31T12:05:00.000Z" as RunRecord["endedAt"] }),
        thisRun,
      ),
    ).toBe(false);
  });

  test("never presumes this run against itself", () => {
    expect(isPresumedLive(record({ runId: thisRun }), thisRun)).toBe(false);
  });
});

describe("the declared bounds and vocabularies", () => {
  test("keep the recovery window inside its declared range", () => {
    expect(DEFAULT_RECOVERY_WINDOW_MS).toBeGreaterThanOrEqual(MIN_RECOVERY_WINDOW_MS);
    expect(DEFAULT_RECOVERY_WINDOW_MS).toBeLessThanOrEqual(MAX_RECOVERY_WINDOW_MS);
  });

  test("stay closed and distinct, because a report enumerates them", () => {
    for (const vocabulary of [ARTIFACT_RECOVERY_OUTCOMES, TEMPORARY_BLOB_OUTCOMES]) {
      expect(vocabulary.length).toBeGreaterThan(0);
      expect(new Set(vocabulary).size).toBe(vocabulary.length);
    }
  });
});
