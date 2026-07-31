/**
 * Encode and decode runtime events at the untrusted boundary.
 *
 * Decoding applies the declared compatibility policy in a fixed order, so a
 * hostile or future input is rejected by the cheapest applicable rule:
 *
 * 1. byte bound, before any parsing work;
 * 2. UTF-8 validity;
 * 3. JSON validity;
 * 4. known kind — an unknown kind is preserved and rejected, never widened;
 * 5. version skew — an event whose required semantics need a newer reader is
 *    rejected with the minimum compatible version;
 * 6. structure and identity.
 *
 * Additive optional data written by a newer producer survives step 6 and is
 * dropped, because this build cannot interpret it. Callers that must forward
 * such an event without loss forward its original bytes.
 */

import type { CodecError } from "./codec-error.ts";
import type { RuntimeEvent } from "./event.ts";
import { isEventKind } from "./event.ts";
import {
  MAX_EVENT_BYTES,
  RUNTIME_EVENT_MINIMUM_SCHEMA_VERSION,
  RUNTIME_EVENT_SCHEMA_VERSION,
} from "./limits.ts";
import { err, ok, type Result } from "./result.ts";
import { parseWireEvent, toWireEvent } from "./wire.ts";

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/** Longest observed-kind string echoed back in an error. */
const MAX_REPORTED_KIND_LENGTH = 64;

/** Kinds are structural identifiers; anything else is withheld from the error. */
const REPORTABLE_KIND = /^[A-Za-z0-9._-]+$/;

const WITHHELD_KIND = "<unreportable>";

function reportableKind(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_REPORTED_KIND_LENGTH) {
    return WITHHELD_KIND;
  }
  return REPORTABLE_KIND.test(value) ? value : WITHHELD_KIND;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Applies the version-skew policy.
 *
 * `minimumReaderSchemaVersion` is the producer's declaration of the oldest
 * reader that can honour the event's required semantics. Absent, it defaults
 * to the current version, which keeps events written before the field was
 * introduced readable.
 */
function checkSchemaVersion(candidate: Record<string, unknown>): CodecError | null {
  const observed = candidate.schemaVersion;
  if (typeof observed !== "number" || !Number.isSafeInteger(observed) || observed < 1) {
    return { kind: "invalid-envelope", issues: [{ path: "schemaVersion", code: "invalid_type" }] };
  }
  if (observed < RUNTIME_EVENT_MINIMUM_SCHEMA_VERSION) {
    return {
      kind: "retired-schema-version",
      observedSchemaVersion: observed,
      minimumSupportedVersion: RUNTIME_EVENT_MINIMUM_SCHEMA_VERSION,
    };
  }

  const declared = candidate.minimumReaderSchemaVersion;
  const required = declared === undefined ? RUNTIME_EVENT_SCHEMA_VERSION : (declared as unknown);
  if (typeof required !== "number" || !Number.isSafeInteger(required) || required < 1) {
    return {
      kind: "invalid-envelope",
      issues: [{ path: "minimumReaderSchemaVersion", code: "invalid_type" }],
    };
  }
  if (required > RUNTIME_EVENT_SCHEMA_VERSION) {
    return {
      kind: "unsupported-schema-version",
      observedSchemaVersion: observed,
      minimumCompatibleVersion: required,
      readerSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    };
  }
  return null;
}

/**
 * Decodes an untrusted event.
 *
 * Accepts bytes from storage or transport, or text that has already been
 * decoded. Never throws: every rejection is a typed {@link CodecError}.
 */
export function decodeRuntimeEvent(input: Uint8Array | string): Result<RuntimeEvent, CodecError> {
  const bytes = typeof input === "string" ? encoder.encode(input) : input;
  if (bytes.byteLength > MAX_EVENT_BYTES) {
    return err({
      kind: "oversized-event",
      byteLength: bytes.byteLength,
      maximumBytes: MAX_EVENT_BYTES,
    });
  }

  let text: string;
  try {
    text = strictDecoder.decode(bytes);
  } catch {
    return err({ kind: "malformed-encoding" });
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(text);
  } catch {
    return err({ kind: "malformed-json" });
  }

  if (!isPlainObject(candidate)) {
    return err({ kind: "not-an-object" });
  }

  if (!isEventKind(candidate.kind)) {
    return err({ kind: "unknown-event-kind", observedKind: reportableKind(candidate.kind) });
  }

  const versionError = checkSchemaVersion(candidate);
  if (versionError !== null) {
    return err(versionError);
  }

  const normalized = {
    ...candidate,
    minimumReaderSchemaVersion:
      candidate.minimumReaderSchemaVersion ?? RUNTIME_EVENT_SCHEMA_VERSION,
  };

  const parsed = parseWireEvent(normalized);
  if (!parsed.ok) {
    return err({ kind: "invalid-envelope", issues: parsed.issues });
  }
  return ok(parsed.event);
}

/**
 * Encodes an event to its canonical bytes.
 *
 * The event is revalidated first, so a value assembled through an unchecked
 * cast cannot reach storage or transport, and the byte bound is enforced on
 * the encoded form rather than on an estimate.
 */
export function encodeRuntimeEvent(event: RuntimeEvent): Result<Uint8Array, CodecError> {
  const json = toWireEvent(event);
  const versionError = checkSchemaVersion(json);
  if (versionError !== null) {
    return err(versionError);
  }

  const parsed = parseWireEvent(json);
  if (!parsed.ok) {
    return err({ kind: "invalid-envelope", issues: parsed.issues });
  }

  const bytes = encoder.encode(JSON.stringify(json));
  if (bytes.byteLength > MAX_EVENT_BYTES) {
    return err({
      kind: "oversized-event",
      byteLength: bytes.byteLength,
      maximumBytes: MAX_EVENT_BYTES,
    });
  }
  return ok(bytes);
}

/** Encoded size of an event, or the reason it cannot be encoded. */
export function encodedByteLength(event: RuntimeEvent): Result<number, CodecError> {
  const encoded = encodeRuntimeEvent(event);
  return encoded.ok ? ok(encoded.value.byteLength) : encoded;
}
