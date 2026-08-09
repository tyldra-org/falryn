/**
 * Cross-reader schema fixtures.
 *
 * Test-only. This matrix is intentionally not exported by a product entrypoint:
 * each case calls the reader that owns the contract, so it cannot grow into a
 * second schema implementation or a production compatibility layer.
 */

import {
  CONFIGURATION_SCHEMA_FAMILY,
  CONFIGURATION_SCHEMA_VERSION,
  evaluateSchemaVersion,
  MINIMUM_READER_FIELD,
  SCHEMA_VERSION_FIELD,
} from "./config/schema-family.ts";
import { CONTENT_DIGEST_ALGORITHM } from "./domain/artifact.ts";
import { decodeRuntimeEvent } from "./domain/codec.ts";
import {
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION,
  isCompatible,
  MINIMUM_COMPATIBLE_EXPORT_SCHEMA_VERSION,
  parseExportManifest,
  RECORDS_MEMBER,
} from "./domain/export.ts";
import { sessionStarted } from "./domain/fixtures.ts";
import { RUNTIME_EVENT_SCHEMA_FAMILY, RUNTIME_EVENT_SCHEMA_VERSION } from "./domain/limits.ts";
import { toWireEvent } from "./domain/wire.ts";

export const SCHEMA_FIXTURE_FAMILIES = [
  RUNTIME_EVENT_SCHEMA_FAMILY,
  CONFIGURATION_SCHEMA_FAMILY,
  EXPORT_FORMAT,
] as const;

export type SchemaFixtureFamily = (typeof SCHEMA_FIXTURE_FAMILIES)[number];

export const SCHEMA_FIXTURE_CASES = [
  "current",
  "forward-compatible",
  "requires-newer-reader",
  "secret-shaped-malformed",
] as const;

export type SchemaFixtureCase = (typeof SCHEMA_FIXTURE_CASES)[number];
export type SchemaFixtureOutcome = "accepted" | "rejected";

export type SchemaFixtureObservation = {
  readonly outcome: SchemaFixtureOutcome;
  /** The real reader result, retained only so the test can prove it withholds synthetic input. */
  readonly rendered: string;
};

export type SchemaFixture = {
  readonly id: string;
  readonly family: SchemaFixtureFamily;
  readonly scenario: SchemaFixtureCase;
  readonly expected: SchemaFixtureOutcome;
  /** A synthetic value which must not appear in the real reader's observation. */
  readonly withheldValue: string | null;
  observe(): SchemaFixtureObservation;
};

const SYNTHETIC_SECRET = "sk-fixture-value-must-not-escape";
const DIGEST = `${CONTENT_DIGEST_ALGORITHM}:${"a".repeat(64)}`;

function fixture(
  family: SchemaFixtureFamily,
  scenario: SchemaFixtureCase,
  expected: SchemaFixtureOutcome,
  observe: () => SchemaFixtureObservation,
  withheldValue: string | null = null,
): SchemaFixture {
  return { id: `${family}:${scenario}`, family, scenario, expected, withheldValue, observe };
}

function runtimeEventWire(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({ ...toWireEvent(sessionStarted()), ...overrides });
}

function observeRuntimeEvent(input: string): SchemaFixtureObservation {
  const decoded = decodeRuntimeEvent(input);
  return { outcome: decoded.ok ? "accepted" : "rejected", rendered: JSON.stringify(decoded) };
}

function observeConfiguration(
  document: Readonly<Record<string, unknown>>,
): SchemaFixtureObservation {
  const verdict = evaluateSchemaVersion(document);
  return {
    outcome: verdict.kind === "rejected" ? "rejected" : "accepted",
    rendered: JSON.stringify(verdict),
  };
}

function exportManifest(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    minimumCompatibleSchemaVersion: MINIMUM_COMPATIBLE_EXPORT_SCHEMA_VERSION,
    schemaFamilies: [
      { family: RUNTIME_EVENT_SCHEMA_FAMILY, schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION },
    ],
    createdAt: "2026-08-09T12:00:00.000Z",
    createdBy: "falryn/schema-fixture",
    selection: { kind: "sessions", sessions: 1, includesSensitive: false },
    counts: { sessions: 1, turns: 0, modelAttempts: 0, invocations: 0, events: 0, artifacts: 0 },
    members: [{ name: RECORDS_MEMBER, kind: "records", byteLength: 1, digest: DIGEST }],
    omissions: [],
    ...overrides,
  };
}

function observeExportManifest(input: Readonly<Record<string, unknown>>): SchemaFixtureObservation {
  const parsed = parseExportManifest(input);
  const compatible = parsed.ok && isCompatible(parsed.value, EXPORT_SCHEMA_VERSION);
  return {
    outcome: parsed.ok && compatible ? "accepted" : "rejected",
    rendered: JSON.stringify({ parsed, compatible }),
  };
}

export const SCHEMA_FIXTURES: readonly SchemaFixture[] = [
  fixture(RUNTIME_EVENT_SCHEMA_FAMILY, "current", "accepted", () =>
    observeRuntimeEvent(runtimeEventWire()),
  ),
  fixture(RUNTIME_EVENT_SCHEMA_FAMILY, "forward-compatible", "accepted", () =>
    observeRuntimeEvent(
      runtimeEventWire({
        schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION + 1,
        minimumReaderSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
        addedLater: true,
      }),
    ),
  ),
  fixture(RUNTIME_EVENT_SCHEMA_FAMILY, "requires-newer-reader", "rejected", () =>
    observeRuntimeEvent(
      runtimeEventWire({
        schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION + 1,
        minimumReaderSchemaVersion: RUNTIME_EVENT_SCHEMA_VERSION + 1,
      }),
    ),
  ),
  fixture(
    RUNTIME_EVENT_SCHEMA_FAMILY,
    "secret-shaped-malformed",
    "rejected",
    () => observeRuntimeEvent(runtimeEventWire({ kind: `token ${SYNTHETIC_SECRET}` })),
    SYNTHETIC_SECRET,
  ),
  fixture(CONFIGURATION_SCHEMA_FAMILY, "current", "accepted", () =>
    observeConfiguration({ [SCHEMA_VERSION_FIELD]: CONFIGURATION_SCHEMA_VERSION }),
  ),
  fixture(CONFIGURATION_SCHEMA_FAMILY, "forward-compatible", "accepted", () =>
    observeConfiguration({
      [SCHEMA_VERSION_FIELD]: CONFIGURATION_SCHEMA_VERSION + 1,
      [MINIMUM_READER_FIELD]: CONFIGURATION_SCHEMA_VERSION,
    }),
  ),
  fixture(CONFIGURATION_SCHEMA_FAMILY, "requires-newer-reader", "rejected", () =>
    observeConfiguration({
      [SCHEMA_VERSION_FIELD]: CONFIGURATION_SCHEMA_VERSION + 1,
      [MINIMUM_READER_FIELD]: CONFIGURATION_SCHEMA_VERSION + 1,
    }),
  ),
  fixture(
    CONFIGURATION_SCHEMA_FAMILY,
    "secret-shaped-malformed",
    "rejected",
    () => observeConfiguration({ [SCHEMA_VERSION_FIELD]: SYNTHETIC_SECRET }),
    SYNTHETIC_SECRET,
  ),
  fixture(EXPORT_FORMAT, "current", "accepted", () => observeExportManifest(exportManifest())),
  fixture(EXPORT_FORMAT, "forward-compatible", "accepted", () =>
    observeExportManifest(
      exportManifest({
        schemaVersion: EXPORT_SCHEMA_VERSION + 1,
        minimumCompatibleSchemaVersion: EXPORT_SCHEMA_VERSION,
      }),
    ),
  ),
  fixture(EXPORT_FORMAT, "requires-newer-reader", "rejected", () =>
    observeExportManifest(
      exportManifest({
        schemaVersion: EXPORT_SCHEMA_VERSION + 1,
        minimumCompatibleSchemaVersion: EXPORT_SCHEMA_VERSION + 1,
      }),
    ),
  ),
  fixture(
    EXPORT_FORMAT,
    "secret-shaped-malformed",
    "rejected",
    () => observeExportManifest(exportManifest({ format: SYNTHETIC_SECRET })),
    SYNTHETIC_SECRET,
  ),
];
