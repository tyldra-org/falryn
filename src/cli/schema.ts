/**
 * The `falryn.cli` schema family: what a machine record is, and what a reader
 * may do with one it does not fully understand.
 *
 * A third declared family is justified rather than habitual. A runtime event
 * outlives the database it sits in; a configuration document outlives the build
 * that wrote it; a CLI record outlives neither — it outlives *a consumer's
 * script*, which is a different compatibility question from either, and answering
 * it inside one of the existing families would tie a script's lifetime to a
 * storage format's.
 *
 * Three rules the shape enforces rather than documents:
 *
 * - **A reader can refuse a record without parsing its body.** Family, version,
 *   minimum reader version, kind, and whether the record is terminal are all in
 *   the envelope, so "I cannot understand this" is answerable before any
 *   command-specific structure is read.
 * - **An unknown *terminal* kind is refused; an unknown non-terminal kind is
 *   tolerated.** A record this build cannot read that claims to end the run
 *   leaves the run's outcome unknown, and treating unknown as success is the
 *   exact failure this rule exists to prevent.
 * - **A bound is an error, never a clamp.** A result too large to emit is a
 *   typed refusal. An object that was quietly trimmed still parses, and a
 *   consumer reads it as the whole answer.
 *
 * The versioning discipline is the one `RUNTIME_EVENT_SCHEMA_FAMILY` and
 * `CONFIGURATION_SCHEMA_FAMILY` already established, applied to a new family
 * rather than restated: additive optional fields do not raise the version, and a
 * field a reader must understand raises `minimumReaderSchemaVersion`.
 */

import { z } from "zod";

import {
  brandedInteger,
  type CodecIssue,
  type Sequence,
  sequence,
  type Timestamp,
  terminalOutcomeSchema,
  timestampSchema,
  toCodecIssues,
} from "../domain/index.ts";
import { COMMAND_IDS } from "./result.ts";

/** Stable name of this schema family, the third Falryn declares. */
export const CLI_SCHEMA_FAMILY = "falryn.cli";

/** Version this build writes and can fully interpret. */
export const CLI_SCHEMA_VERSION = 1;

/**
 * Oldest record version this build interprets.
 *
 * Equal to the current version because no earlier version was ever published,
 * following `CONFIGURATION_MINIMUM_SCHEMA_VERSION`: an older record is a
 * fabrication rather than history.
 */
export const CLI_MINIMUM_SCHEMA_VERSION = 1;

/**
 * Largest single encoded record, in bytes.
 *
 * Matched to `MAX_STREAM_WRITE_BYTES`, because a record the stream boundary
 * would refuse as one write is a record this format cannot emit. Keeping the two
 * apart would move the failure from a typed refusal here to a `too-large` write
 * status the format could not explain.
 */
export const MAX_CLI_RECORD_BYTES = 1024 * 1024;

/**
 * The record kinds this build writes.
 *
 * Open for reading and closed for writing: a reader tolerates a kind outside
 * this list when the record does not claim to be terminal.
 */
export const CLI_RECORD_KINDS = ["event", "result", "refusal"] as const;

export type CliRecordKind = (typeof CLI_RECORD_KINDS)[number];

/** Kinds that end a stream. Exactly one of these appears, and it appears last. */
export const TERMINAL_CLI_RECORD_KINDS: readonly CliRecordKind[] = ["result", "refusal"];

export function isTerminalCliRecordKind(kind: string): boolean {
  return (TERMINAL_CLI_RECORD_KINDS as readonly string[]).includes(kind);
}

/**
 * What every record carries, whatever its kind.
 *
 * `terminal` is redundant with `kind` for a kind this build knows, and is the
 * whole point for one it does not: it is how a reader decides between tolerating
 * and refusing without a table of every kind that will ever exist.
 */
export type CliRecordEnvelope = {
  readonly schemaFamily: typeof CLI_SCHEMA_FAMILY;
  readonly schemaVersion: number;
  readonly minimumReaderSchemaVersion: number;
  readonly kind: CliRecordKind;
  readonly terminal: boolean;
  /** Which command produced this record. Present on every kind. */
  readonly command: string;
  /** Monotonic within one stream, starting at `FIRST_SEQUENCE`. */
  readonly sequence: Sequence;
  readonly occurredAt: Timestamp;
};

/** A lifecycle record: one runtime event, in the canonical form the codec owns. */
export type CliEventRecord = CliRecordEnvelope & {
  readonly kind: "event";
  readonly terminal: false;
  /**
   * The wire form of a `RuntimeEvent`.
   *
   * Projected through `toWireEvent` rather than re-described, so JSON Lines
   * carries the runtime's own event vocabulary instead of a second one that
   * would have to be kept in step with it.
   */
  readonly event: Readonly<Record<string, unknown>>;
};

/** The terminal record: one command's complete answer. */
export type CliResultRecord = CliRecordEnvelope & {
  readonly kind: "result";
  readonly terminal: true;
  readonly outcome: unknown;
  readonly effect: unknown;
  readonly payload: unknown;
  readonly errors: readonly unknown[];
  readonly warnings: readonly unknown[];
  readonly omissions: readonly unknown[];
  readonly truncation: readonly unknown[];
  /**
   * Handles for content too large to inline.
   *
   * Always empty in this build: no command produces an artifact yet, and the
   * CLI reaches no artifact store. The field is declared now so a consumer's
   * parser does not change shape when one does.
   */
  readonly artifacts: readonly unknown[];
  readonly correlation: unknown;
};

/**
 * The terminal record for a run that could not emit its result.
 *
 * Terminal on purpose: the run ended and the consumer must not wait for a
 * `result` that is never coming. It carries a code rather than a trimmed body,
 * because a truncated object parses cleanly and lies.
 */
export type CliRefusalRecord = CliRecordEnvelope & {
  readonly kind: "refusal";
  readonly terminal: true;
  readonly code: CliEncodeErrorCode;
  readonly outcome: unknown;
  /** The handle holding the full result, or `null` when none could be made. */
  readonly artifact: unknown;
  readonly observedBytes: number | null;
  readonly maximumBytes: number;
};

export type CliRecord = CliEventRecord | CliResultRecord | CliRefusalRecord;

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The envelope every record shares.
 *
 * Written in one place so a record cannot be assembled with the family, the
 * version, or the terminal flag left out — the three facts a reader needs before
 * it may look at anything else.
 */
function envelopeFor(
  kind: CliRecordKind,
  command: string,
  order: Sequence,
  occurredAt: Timestamp,
): CliRecordEnvelope {
  return {
    schemaFamily: CLI_SCHEMA_FAMILY,
    schemaVersion: CLI_SCHEMA_VERSION,
    minimumReaderSchemaVersion: CLI_MINIMUM_SCHEMA_VERSION,
    kind,
    terminal: isTerminalCliRecordKind(kind),
    command,
    sequence: order,
    occurredAt,
  };
}

/** One runtime event as a lifecycle record. */
export function cliEventRecord(
  command: string,
  order: Sequence,
  occurredAt: Timestamp,
  event: Readonly<Record<string, unknown>>,
): CliEventRecord {
  return {
    ...envelopeFor("event", command, order, occurredAt),
    kind: "event",
    terminal: false,
    event,
  };
}

export type CliResultBody = {
  readonly outcome: unknown;
  readonly effect: unknown;
  readonly payload: unknown;
  readonly errors: readonly unknown[];
  readonly warnings: readonly unknown[];
  readonly omissions: readonly unknown[];
  readonly truncation: readonly unknown[];
  readonly correlation: unknown;
};

/** One command's complete answer as the terminal record. */
export function cliResultRecord(
  command: string,
  order: Sequence,
  occurredAt: Timestamp,
  body: CliResultBody,
): CliResultRecord {
  return {
    ...envelopeFor("result", command, order, occurredAt),
    kind: "result",
    terminal: true,
    outcome: body.outcome,
    effect: body.effect,
    payload: body.payload,
    errors: body.errors,
    warnings: body.warnings,
    omissions: body.omissions,
    truncation: body.truncation,
    artifacts: [],
    correlation: body.correlation,
  };
}

/**
 * The terminal record for a result that could not be emitted.
 *
 * It carries nothing that came from the result it replaces — a code, an
 * outcome, and two numbers — so encoding it cannot fail for the reason the
 * result did.
 *
 * `artifact` is `null` in this build. No command produces an artifact and the
 * CLI reaches no artifact store, so there is nowhere to put the full result;
 * inventing a handle that resolves to nothing would be worse than saying none
 * exists.
 */
export function cliRefusalRecord(
  command: string,
  order: Sequence,
  occurredAt: Timestamp,
  error: CliEncodeError,
): CliRefusalRecord {
  return {
    ...envelopeFor("refusal", command, order, occurredAt),
    kind: "refusal",
    terminal: true,
    code: error.code,
    // The run's own work may well have completed; what failed is emitting the
    // answer. A consumer that cannot read the result cannot know its effect,
    // and `uncertain` is the outcome that says exactly that.
    outcome: { kind: "uncertain", effect: "uncertain" },
    artifact: null,
    observedBytes: error.observedBytes,
    maximumBytes: MAX_CLI_RECORD_BYTES,
  };
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                    */
/* -------------------------------------------------------------------------- */

export const CLI_ENCODE_ERROR_CODES = [
  /** The encoded record exceeded {@link MAX_CLI_RECORD_BYTES}. */
  "record-too-large",
  /** A value held a number JSON cannot carry without changing it. */
  "unrepresentable-number",
  /** A value held an unpaired surrogate, which UTF-8 cannot encode. */
  "unencodable-text",
  /** A value held something with no JSON form at all. */
  "unrepresentable-value",
] as const;

export type CliEncodeErrorCode = (typeof CLI_ENCODE_ERROR_CODES)[number];

export type CliEncodeError = {
  readonly code: CliEncodeErrorCode;
  /** Where in the record it was found. Structural only, never the value. */
  readonly path: string;
  readonly observedBytes: number | null;
};

export type CliEncodeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: CliEncodeError };

/**
 * A value rewritten into a deterministic JSON form, or the reason it has none.
 *
 * Object keys are sorted, so two runs that produced equal values encode to equal
 * bytes even when the values were assembled in different orders — the property
 * `toWireEvent` gets from fixed construction, obtained here by sorting because
 * a command's payload is not built by this module.
 *
 * Three things are refused rather than coerced, because JSON's defaults for each
 * of them are silent corruption:
 *
 * - a non-finite or unsafe number, which `JSON.stringify` writes as `null`;
 * - an unpaired surrogate, which UTF-8 encoding replaces with `U+FFFD` and a
 *   consumer then reads as content;
 * - a function, symbol, or `undefined` in a position where dropping it would
 *   change the shape a consumer parses.
 */
function canonicalize(value: unknown, path: string): CanonicalResult {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return typeof value === "string" && hasLoneSurrogate(value)
      ? refuse("unencodable-text", path)
      : { ok: true, value };
  }

  if (typeof value === "number") {
    // `Number.isSafeInteger` is too narrow — a legitimate fractional value is
    // fine. What is not is a value JSON cannot round-trip.
    if (!Number.isFinite(value)) {
      return refuse("unrepresentable-number", path);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      return refuse("unrepresentable-number", path);
    }
    return { ok: true, value };
  }

  if (typeof value === "bigint") {
    // A bigint has no JSON form and `JSON.stringify` throws on one. Refusing it
    // here makes the failure typed rather than an exception from the encoder.
    return refuse("unrepresentable-number", path);
  }

  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const [index, item] of value.entries()) {
      const canonical = canonicalize(item, `${path}[${index}]`);
      if (!canonical.ok) {
        return canonical;
      }
      items.push(canonical.value);
    }
    return { ok: true, value: items };
  }

  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const entry = source[key];
      // An explicitly-undefined property is what `JSON.stringify` drops. The
      // domain's convention is present-and-nullable, so a value that is
      // undefined here is a defect rather than an absence to be preserved.
      if (entry === undefined) {
        continue;
      }
      const encoded = canonicalize(entry, path === "" ? key : `${path}.${key}`);
      if (!encoded.ok) {
        return encoded;
      }
      canonical[key] = encoded.value;
    }
    return { ok: true, value: canonical };
  }

  return refuse("unrepresentable-value", path);
}

type CanonicalResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: CliEncodeError };

function refuse(code: CliEncodeErrorCode, path: string): CanonicalResult {
  return { ok: false, error: { code, path, observedBytes: null } };
}

/** Whether this text holds a surrogate with no partner, which UTF-8 cannot carry. */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) {
        return true;
      }
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const ENCODER = new TextEncoder();

/**
 * One record as the single line it is written as.
 *
 * Every object's keys are sorted, envelope included, so equal records encode to
 * equal bytes however they were assembled. `toWireEvent` gets the same property
 * from fixed construction; sorting is the version of it available to a module
 * that did not build the payload it is encoding. The byte bound is checked on
 * the encoded form rather than on an estimate, as `encodeRuntimeEvent` does.
 */
export function encodeCliRecord(record: CliRecord): CliEncodeResult {
  const canonical = canonicalize(record, "");
  if (!canonical.ok) {
    return { ok: false, error: canonical.error };
  }

  const text = JSON.stringify(canonical.value);
  const byteLength = ENCODER.encode(text).byteLength;
  if (byteLength > MAX_CLI_RECORD_BYTES) {
    return {
      ok: false,
      error: { code: "record-too-large", path: "", observedBytes: byteLength },
    };
  }
  return { ok: true, text };
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

const versionSchema = z.int().min(1);

const envelopeSpine = {
  schemaFamily: z.literal(CLI_SCHEMA_FAMILY),
  schemaVersion: versionSchema,
  minimumReaderSchemaVersion: versionSchema,
  command: z.literal(COMMAND_IDS),
  sequence: brandedInteger(sequence),
  occurredAt: timestampSchema,
};

/**
 * Unknown keys are stripped rather than rejected, exactly as `runtimeEventSchema`
 * does: a reader tolerates additive optional data from a newer producer, and a
 * newer producer that added a *required* semantic says so by raising
 * `minimumReaderSchemaVersion`, which is checked before this schema runs.
 */
const cliRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    ...envelopeSpine,
    kind: z.literal("event"),
    terminal: z.literal(false),
    event: z.record(z.string(), z.unknown()),
  }),
  z.object({
    ...envelopeSpine,
    kind: z.literal("result"),
    terminal: z.literal(true),
    outcome: terminalOutcomeSchema,
    effect: z.object({
      intent: z.literal(["none", "mutate"]),
      observed: z.literal(["none", "completed", "partial", "uncertain"]),
    }),
    payload: z.unknown(),
    errors: z.array(z.unknown()),
    warnings: z.array(z.unknown()),
    omissions: z.array(z.unknown()),
    truncation: z.array(z.unknown()),
    artifacts: z.array(z.unknown()),
    correlation: z.unknown(),
  }),
  z.object({
    ...envelopeSpine,
    kind: z.literal("refusal"),
    terminal: z.literal(true),
    code: z.literal(CLI_ENCODE_ERROR_CODES),
    outcome: terminalOutcomeSchema,
    artifact: z.unknown(),
    observedBytes: z.number().nullable(),
    maximumBytes: z.number(),
  }),
]);

export type CliReadVerdict =
  /** A record this build understands. */
  | { readonly kind: "accepted"; readonly record: CliRecord }
  /**
   * A non-terminal record whose kind this build does not know.
   *
   * A newer producer added a lifecycle record. The run's outcome still arrives
   * in its terminal record, so skipping this one loses detail rather than the
   * answer.
   */
  | { readonly kind: "tolerated"; readonly observedKind: string }
  | { readonly kind: "refused"; readonly reason: CliReadRefusal };

export type CliReadRefusal =
  | { readonly code: "not-a-record" }
  | { readonly code: "foreign-family"; readonly observedFamily: string }
  | {
      readonly code: "retired-schema-version";
      readonly observedSchemaVersion: number;
      readonly minimumSupportedVersion: number;
    }
  | {
      readonly code: "unsupported-schema-version";
      readonly observedSchemaVersion: number;
      readonly minimumCompatibleVersion: number;
      readonly readerSchemaVersion: number;
    }
  /** A terminal record this build cannot read. The run's outcome is unknown. */
  | { readonly code: "unknown-terminal-kind"; readonly observedKind: string }
  | { readonly code: "invalid-record"; readonly issues: readonly CodecIssue[] };

/** Longest observed-kind string echoed back in a refusal. */
const MAX_REPORTED_KIND_LENGTH = 64;

/** Kinds are structural identifiers; anything else is withheld from the refusal. */
const REPORTABLE_KIND = /^[A-Za-z0-9._-]+$/;

const WITHHELD = "<unreportable>";

function reportable(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_REPORTED_KIND_LENGTH) {
    return WITHHELD;
  }
  return REPORTABLE_KIND.test(value) ? value : WITHHELD;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads one untrusted record and says what may be done with it.
 *
 * The order is the codec's, and it is the contract: the cheapest applicable rule
 * rejects first, and the version check runs before the structure check so a
 * record from a newer producer is refused with the version it needs rather than
 * with a list of fields this build did not recognize.
 */
export function readCliRecord(value: unknown): CliReadVerdict {
  if (!isPlainObject(value)) {
    return { kind: "refused", reason: { code: "not-a-record" } };
  }

  if (value.schemaFamily !== CLI_SCHEMA_FAMILY) {
    return {
      kind: "refused",
      reason: { code: "foreign-family", observedFamily: reportable(value.schemaFamily) },
    };
  }

  const versionRefusal = checkVersion(value);
  if (versionRefusal !== null) {
    return { kind: "refused", reason: versionRefusal };
  }

  const kind = value.kind;
  if (typeof kind !== "string" || !(CLI_RECORD_KINDS as readonly string[]).includes(kind)) {
    // The whole reason `terminal` is on the envelope. An unknown kind that ends
    // the run leaves the outcome unknown, and an unknown kind that does not is
    // detail this build can do without.
    return value.terminal === true
      ? {
          kind: "refused",
          reason: { code: "unknown-terminal-kind", observedKind: reportable(kind) },
        }
      : { kind: "tolerated", observedKind: reportable(kind) };
  }

  const parsed = cliRecordSchema.safeParse(value);
  if (!parsed.success) {
    return {
      kind: "refused",
      reason: { code: "invalid-record", issues: toCodecIssues(parsed.error) },
    };
  }
  return { kind: "accepted", record: parsed.data as CliRecord };
}

function checkVersion(record: Record<string, unknown>): CliReadRefusal | null {
  const observed = record.schemaVersion;
  if (typeof observed !== "number" || !Number.isSafeInteger(observed) || observed < 1) {
    return { code: "invalid-record", issues: [{ path: "schemaVersion", code: "invalid_type" }] };
  }
  if (observed < CLI_MINIMUM_SCHEMA_VERSION) {
    return {
      code: "retired-schema-version",
      observedSchemaVersion: observed,
      minimumSupportedVersion: CLI_MINIMUM_SCHEMA_VERSION,
    };
  }

  const declared = record.minimumReaderSchemaVersion;
  // Absent, the floor is this reader's own version: a producer that never
  // raised it added nothing this build is required to understand.
  const required = declared === undefined ? CLI_SCHEMA_VERSION : declared;
  if (typeof required !== "number" || !Number.isSafeInteger(required) || required < 1) {
    return {
      code: "invalid-record",
      issues: [{ path: "minimumReaderSchemaVersion", code: "invalid_type" }],
    };
  }
  if (required > CLI_SCHEMA_VERSION) {
    return {
      code: "unsupported-schema-version",
      observedSchemaVersion: observed,
      minimumCompatibleVersion: required,
      readerSchemaVersion: CLI_SCHEMA_VERSION,
    };
  }
  return null;
}

/**
 * Reads a whole JSON Lines stream.
 *
 * Gap detection is the consumer's, and this is what it needs: the sequences it
 * saw, in order, plus what it tolerated and what it refused. A stream that ended
 * without a terminal record is reported as such rather than as a success with
 * one record missing.
 */
export type CliStreamReading = {
  readonly records: readonly CliRecord[];
  readonly tolerated: readonly string[];
  readonly refusals: readonly CliReadRefusal[];
  /** Sequences missing between the first and last record seen. */
  readonly gaps: readonly number[];
  readonly terminal: CliRecord | null;
};

export function readCliStream(lines: readonly string[]): CliStreamReading {
  const records: CliRecord[] = [];
  const tolerated: string[] = [];
  const refusals: CliReadRefusal[] = [];

  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(line);
    } catch {
      refusals.push({ code: "not-a-record" });
      continue;
    }
    const verdict = readCliRecord(candidate);
    switch (verdict.kind) {
      case "accepted":
        records.push(verdict.record);
        break;
      case "tolerated":
        tolerated.push(verdict.observedKind);
        break;
      case "refused":
        refusals.push(verdict.reason);
        break;
    }
  }

  const last = records[records.length - 1];
  return {
    records,
    tolerated,
    refusals,
    gaps: gapsIn(records.map((record) => record.sequence)),
    terminal: last?.terminal === true ? last : null,
  };
}

/** Sequence numbers absent between the lowest and highest observed. */
function gapsIn(sequences: readonly number[]): readonly number[] {
  if (sequences.length === 0) {
    return [];
  }
  const seen = new Set(sequences);
  const gaps: number[] = [];
  for (let value = Math.min(...sequences); value <= Math.max(...sequences); value += 1) {
    if (!seen.has(value)) {
      gaps.push(value);
    }
  }
  return gaps;
}
