/**
 * The `falryn.cli` schema family.
 *
 * These are the properties a consumer's script depends on and cannot check for
 * itself: that a record it cannot understand can be refused before its body is
 * read, that an unknown terminal kind is never mistaken for success, that a
 * bound is an error rather than a quiet trim, and that equal results produce
 * equal bytes.
 *
 * The pinned fixture at the end is the one that matters over time: a change that
 * breaks a v0.1 consumer fails here instead of in a pipeline.
 */

import { describe, expect, test } from "bun:test";

import { FIRST_SEQUENCE, parseTimestamp, sequence, type Timestamp } from "../domain/index.ts";
import {
  CLI_MINIMUM_SCHEMA_VERSION,
  CLI_RECORD_KINDS,
  CLI_SCHEMA_FAMILY,
  CLI_SCHEMA_VERSION,
  cliEventRecord,
  cliRefusalRecord,
  cliResultRecord,
  encodeCliRecord,
  isTerminalCliRecordKind,
  MAX_CLI_RECORD_BYTES,
  readCliRecord,
  readCliStream,
  TERMINAL_CLI_RECORD_KINDS,
} from "./schema.ts";

const AT = "2026-01-01T00:00:00.000Z" as Timestamp;

function resultRecord(payload: unknown = { ok: true }) {
  return cliResultRecord("doctor", FIRST_SEQUENCE, AT, {
    outcome: { kind: "completed" },
    effect: { intent: "none", observed: "none" },
    payload,
    errors: [],
    warnings: [],
    omissions: [],
    truncation: [],
    correlation: { workspaceId: null },
  });
}

/** A record as an untrusted consumer sees it: parsed back out of its own bytes. */
function roundTrip(record: Parameters<typeof encodeCliRecord>[0]): unknown {
  const encoded = encodeCliRecord(record);
  if (!encoded.ok) {
    throw new Error(`could not encode: ${encoded.error.code}`);
  }
  return JSON.parse(encoded.text);
}

describe("the family", () => {
  test("declares a name, a version, and a floor", () => {
    expect(CLI_SCHEMA_FAMILY).toBe("falryn.cli");
    expect(CLI_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(CLI_MINIMUM_SCHEMA_VERSION).toBeLessThanOrEqual(CLI_SCHEMA_VERSION);
  });

  test("names exactly one non-terminal kind and marks the rest terminal", () => {
    expect([...CLI_RECORD_KINDS].sort()).toEqual(["event", "refusal", "result"]);
    for (const kind of CLI_RECORD_KINDS) {
      expect(isTerminalCliRecordKind(kind)).toBe(TERMINAL_CLI_RECORD_KINDS.includes(kind));
    }
    expect(isTerminalCliRecordKind("event")).toBe(false);
  });

  test("puts every fact a reader needs to refuse in the envelope", () => {
    // The point of the whole design: refusal without parsing the body.
    const record = roundTrip(resultRecord()) as Record<string, unknown>;
    for (const field of [
      "schemaFamily",
      "schemaVersion",
      "minimumReaderSchemaVersion",
      "kind",
      "terminal",
      "command",
      "sequence",
      "occurredAt",
    ]) {
      expect(record).toHaveProperty(field);
    }
  });
});

describe("encoding", () => {
  test("is deterministic across assembly order", () => {
    // The same values built with the keys inserted in opposite orders. Byte
    // equality is what lets a consumer diff or checksum two runs.
    const one = encodeCliRecord(resultRecord({ a: 1, b: { x: 1, y: 2 } }));
    const other = encodeCliRecord(resultRecord({ b: { y: 2, x: 1 }, a: 1 }));
    expect(one.ok && other.ok).toBe(true);
    expect(one.ok ? one.text : "").toBe(other.ok ? other.text : "");
  });

  test("keeps array order, which is data rather than layout", () => {
    const record = roundTrip(resultRecord({ items: [3, 1, 2] })) as {
      payload: { items: number[] };
    };
    expect(record.payload.items).toEqual([3, 1, 2]);
  });

  test("emits one line with no newline inside it", () => {
    const encoded = encodeCliRecord(resultRecord({ text: "one\ntwo" }));
    expect(encoded.ok).toBe(true);
    expect(encoded.ok ? encoded.text.includes("\n") : true).toBe(false);
  });

  test("refuses an over-bound record rather than trimming it", () => {
    const encoded = encodeCliRecord(resultRecord({ blob: "x".repeat(MAX_CLI_RECORD_BYTES) }));
    expect(encoded.ok).toBe(false);
    if (!encoded.ok) {
      expect(encoded.error.code).toBe("record-too-large");
      expect(encoded.error.observedBytes).toBeGreaterThan(MAX_CLI_RECORD_BYTES);
    }
  });

  test("refuses a number JSON would silently change", () => {
    // `JSON.stringify` writes each of these as `null`, which a consumer reads
    // as an absent value rather than as the number that was there.
    for (const value of [Number.POSITIVE_INFINITY, Number.NaN, 2 ** 53]) {
      const encoded = encodeCliRecord(resultRecord({ n: value }));
      expect(encoded.ok).toBe(false);
      expect(encoded.ok ? "" : encoded.error.code).toBe("unrepresentable-number");
    }
  });

  test("accepts an ordinary fractional number", () => {
    expect(encodeCliRecord(resultRecord({ n: 1.5 })).ok).toBe(true);
  });

  test("refuses text UTF-8 cannot carry, rather than writing replacement characters", () => {
    // A lone surrogate encodes to U+FFFD, which a consumer then reads as
    // content that was never there.
    const encoded = encodeCliRecord(resultRecord({ text: "a\ud800b" }));
    expect(encoded.ok).toBe(false);
    expect(encoded.ok ? "" : encoded.error.code).toBe("unencodable-text");
    expect(encoded.ok ? "" : encoded.error.path).toContain("text");
  });

  test("keeps a well-formed astral character", () => {
    expect(encodeCliRecord(resultRecord({ text: "🚀" })).ok).toBe(true);
  });

  test("refuses a value with no JSON form", () => {
    expect(encodeCliRecord(resultRecord({ n: 1n })).ok).toBe(false);
    expect(encodeCliRecord(resultRecord({ f: () => 1 })).ok).toBe(false);
  });

  test("encodes the refusal record, whatever the result held", () => {
    // The refusal carries nothing from the result it replaces, so the branch
    // that emits it can never fail for the reason the result did.
    const refusal = cliRefusalRecord("doctor", FIRST_SEQUENCE, AT, {
      code: "record-too-large",
      path: "",
      observedBytes: 9_000_000,
    });
    const encoded = encodeCliRecord(refusal);
    expect(encoded.ok).toBe(true);
    expect(encoded.ok ? JSON.parse(encoded.text) : {}).toMatchObject({
      kind: "refusal",
      terminal: true,
      code: "record-too-large",
      artifact: null,
      outcome: { kind: "uncertain", effect: "uncertain" },
    });
  });
});

describe("reading", () => {
  test("accepts a record this build wrote", () => {
    const verdict = readCliRecord(roundTrip(resultRecord()));
    expect(verdict.kind).toBe("accepted");
  });

  test("accepts a lifecycle record", () => {
    const record = cliEventRecord("config.show", FIRST_SEQUENCE, AT, {
      kind: "session.started",
      sequence: 1,
    });
    expect(readCliRecord(roundTrip(record)).kind).toBe("accepted");
  });

  test("refuses something that is not a record at all", () => {
    for (const value of [null, 7, "text", []]) {
      const verdict = readCliRecord(value);
      expect(verdict.kind).toBe("refused");
    }
  });

  test("refuses a record from another family without reading its body", () => {
    const verdict = readCliRecord({ schemaFamily: "falryn.runtime-event", kind: "result" });
    expect(verdict).toEqual({
      kind: "refused",
      reason: { code: "foreign-family", observedFamily: "falryn.runtime-event" },
    });
  });

  test("withholds a family name that is not a structural identifier", () => {
    const verdict = readCliRecord({ schemaFamily: "\u001b[2J", kind: "result" });
    expect(verdict.kind === "refused" && verdict.reason.code === "foreign-family").toBe(true);
    expect(JSON.stringify(verdict)).not.toContain("[2J");
  });

  test("tolerates an added optional field", () => {
    // The forward-compatibility rule from the writer's side, seen from the
    // reader's: a newer producer may add data this build drops.
    const record = { ...(roundTrip(resultRecord()) as object), addedLater: { anything: true } };
    expect(readCliRecord(record).kind).toBe("accepted");
  });

  test("tolerates an unknown non-terminal kind", () => {
    const verdict = readCliRecord({
      ...(roundTrip(resultRecord()) as object),
      kind: "progress",
      terminal: false,
    });
    expect(verdict).toEqual({ kind: "tolerated", observedKind: "progress" });
  });

  test("refuses an unknown terminal kind rather than guessing", () => {
    // The rule the whole design exists for. A terminal record this build
    // cannot read means the run's outcome is unknown, and unknown must never
    // be read as success.
    const verdict = readCliRecord({
      ...(roundTrip(resultRecord()) as object),
      kind: "verdict",
      terminal: true,
    });
    expect(verdict).toEqual({
      kind: "refused",
      reason: { code: "unknown-terminal-kind", observedKind: "verdict" },
    });
  });

  test("refuses a record needing a newer reader, and names the version it needs", () => {
    const verdict = readCliRecord({
      ...(roundTrip(resultRecord()) as object),
      schemaVersion: CLI_SCHEMA_VERSION + 3,
      minimumReaderSchemaVersion: CLI_SCHEMA_VERSION + 1,
    });
    expect(verdict).toEqual({
      kind: "refused",
      reason: {
        code: "unsupported-schema-version",
        observedSchemaVersion: CLI_SCHEMA_VERSION + 3,
        minimumCompatibleVersion: CLI_SCHEMA_VERSION + 1,
        readerSchemaVersion: CLI_SCHEMA_VERSION,
      },
    });
  });

  test("accepts a newer record that raised no floor", () => {
    // A newer producer that added only optional data is readable, which is the
    // entire difference the floor exists to express.
    const verdict = readCliRecord({
      ...(roundTrip(resultRecord()) as object),
      schemaVersion: CLI_SCHEMA_VERSION + 3,
    });
    expect(verdict.kind).toBe("accepted");
  });

  test("refuses a malformed version before it reads the structure", () => {
    for (const schemaVersion of [0, -1, 1.5, "one", null]) {
      const verdict = readCliRecord({ ...(roundTrip(resultRecord()) as object), schemaVersion });
      expect(verdict.kind).toBe("refused");
    }
  });

  test("refuses a record whose body does not match its kind", () => {
    const verdict = readCliRecord({
      ...(roundTrip(resultRecord()) as object),
      outcome: { kind: "invented" },
    });
    expect(verdict.kind === "refused" && verdict.reason.code === "invalid-record").toBe(true);
  });
});

describe("reading a stream", () => {
  function line(record: Parameters<typeof encodeCliRecord>[0]): string {
    const encoded = encodeCliRecord(record);
    return encoded.ok ? encoded.text : "";
  }

  const event = (order: number) =>
    cliEventRecord("config.show", sequence.from(order), AT, { kind: "session.started" });

  test("reports the terminal record and finds no gap in a whole stream", () => {
    const reading = readCliStream([
      line(event(1)),
      line(event(2)),
      line(cliResultRecord("config.show", sequence.from(3), AT, resultBody())),
    ]);

    expect(reading.records).toHaveLength(3);
    expect(reading.gaps).toEqual([]);
    expect(reading.terminal?.kind).toBe("result");
    expect(reading.refusals).toEqual([]);
  });

  test("detects a gap a consumer would otherwise miss", () => {
    const reading = readCliStream([
      line(event(1)),
      line(cliResultRecord("config.show", sequence.from(4), AT, resultBody())),
    ]);
    expect(reading.gaps).toEqual([2, 3]);
  });

  test("reports a stream that ended without a terminal record", () => {
    // A stream that just stops is indistinguishable from a killed process
    // unless the consumer can see the terminal record is missing.
    const reading = readCliStream([line(event(1)), line(event(2))]);
    expect(reading.terminal).toBeNull();
  });

  test("skips a line that is not JSON without losing the rest", () => {
    const reading = readCliStream([
      "not json",
      line(cliResultRecord("config.show", FIRST_SEQUENCE, AT, resultBody())),
    ]);
    expect(reading.refusals).toEqual([{ code: "not-a-record" }]);
    expect(reading.terminal?.kind).toBe("result");
  });

  test("ignores blank lines, which a trailing newline produces", () => {
    const reading = readCliStream([
      line(cliResultRecord("config.show", FIRST_SEQUENCE, AT, resultBody())),
      "",
    ]);
    expect(reading.records).toHaveLength(1);
    expect(reading.refusals).toEqual([]);
  });

  test("carries an unknown non-terminal kind through as tolerated", () => {
    const reading = readCliStream([
      JSON.stringify({
        schemaFamily: CLI_SCHEMA_FAMILY,
        schemaVersion: CLI_SCHEMA_VERSION,
        minimumReaderSchemaVersion: CLI_SCHEMA_VERSION,
        kind: "progress",
        terminal: false,
        command: "doctor",
        sequence: 1,
        occurredAt: AT,
      }),
      line(cliResultRecord("doctor", sequence.from(2), AT, resultBody())),
    ]);
    expect(reading.tolerated).toEqual(["progress"]);
    expect(reading.terminal?.kind).toBe("result");
  });
});

function resultBody() {
  return {
    outcome: { kind: "completed" } as const,
    effect: { intent: "none", observed: "none" } as const,
    payload: null,
    errors: [],
    warnings: [],
    omissions: [],
    truncation: [],
    correlation: {},
  };
}

/* -------------------------------------------------------------------------- */
/* Pinned v0.1 fixtures                                                        */
/* -------------------------------------------------------------------------- */

describe("the v0.1 wire form", () => {
  /**
   * The exact bytes a v0.1 consumer was written against.
   *
   * Pinned rather than derived. A change that alters these breaks a script
   * somebody already deployed, so it has to be a deliberate version decision
   * made here rather than a side effect of an edit somewhere else.
   */
  const RESULT_LINE =
    '{"artifacts":[],"command":"doctor","correlation":{},"effect":{"intent":"none","observed":"none"},"errors":[],"kind":"result","minimumReaderSchemaVersion":1,"occurredAt":"2026-01-01T00:00:00.000Z","omissions":[],"outcome":{"kind":"completed"},"payload":null,"schemaFamily":"falryn.cli","schemaVersion":1,"sequence":1,"terminal":true,"truncation":[],"warnings":[]}';

  test("is byte-for-byte what this build writes", () => {
    const encoded = encodeCliRecord(cliResultRecord("doctor", FIRST_SEQUENCE, AT, resultBody()));
    expect(encoded.ok ? encoded.text : "").toBe(RESULT_LINE);
  });

  test("is readable by this build", () => {
    expect(readCliRecord(JSON.parse(RESULT_LINE)).kind).toBe("accepted");
  });

  test("carries a canonical timestamp the domain accepts", () => {
    const parsed = parseTimestamp(JSON.parse(RESULT_LINE).occurredAt);
    expect(parsed.ok).toBe(true);
  });
});
