/**
 * The `falryn.configuration` schema family and its reader policy.
 *
 * A configuration document is hand-edited, versioned, and frequently written by
 * a build other than the one reading it, so the two directions of skew get
 * opposite answers:
 *
 * - **A document this build understands is read strictly.** An unrecognized key
 *   is a typo, and a typo silently ignored is a setting that never took effect.
 * - **A document from a newer build is read tolerantly, up to a point.** Keys
 *   this build does not know are dropped with a warning, because a newer
 *   producer is allowed to add optional data. A newer producer that added a
 *   *required* semantic says so by raising `minimumReaderSchemaVersion`, and a
 *   reader below that floor rejects the document and reports the floor rather
 *   than applying half of it.
 *
 * Rejections report versions and paths only, never document content.
 */

import type { ConfigurationIssue } from "../domain/index.ts";

/**
 * Stable name of this schema family, the second Falryn declares.
 *
 * Its source owner is this source area, exported through `src/config/index.ts`.
 */
export const CONFIGURATION_SCHEMA_FAMILY = "falryn.configuration";

/** Version this build writes and can fully interpret. */
export const CONFIGURATION_SCHEMA_VERSION = 1;

/**
 * Oldest document version this build interprets.
 *
 * Equal to the current version because no earlier version was ever published;
 * an older document is a fabrication rather than history.
 */
export const CONFIGURATION_MINIMUM_SCHEMA_VERSION = 1;

/** The field every document declares its version in. */
export const SCHEMA_VERSION_FIELD = "schemaVersion";

/** The field a producer raises when it adds a required semantic. */
export const MINIMUM_READER_FIELD = "minimumReaderSchemaVersion";

/** Fields that describe the document itself rather than a configuration key. */
export const RESERVED_DOCUMENT_FIELDS: readonly string[] = [
  SCHEMA_VERSION_FIELD,
  MINIMUM_READER_FIELD,
];

/**
 * What this build may do with a document.
 *
 * `forward-compatible` is not a weaker `current`: it is the state in which an
 * unknown key is tolerated, which is exactly what must not happen for a
 * document this build owns.
 */
export type SchemaVersionVerdict =
  | { readonly kind: "current"; readonly schemaVersion: number }
  | { readonly kind: "forward-compatible"; readonly schemaVersion: number }
  | { readonly kind: "rejected"; readonly issue: ConfigurationIssue };

export type SchemaVersionPolicy = {
  readonly readerSchemaVersion: number;
  readonly minimumSupportedVersion: number;
};

export const DEFAULT_SCHEMA_VERSION_POLICY: SchemaVersionPolicy = {
  readerSchemaVersion: CONFIGURATION_SCHEMA_VERSION,
  minimumSupportedVersion: CONFIGURATION_MINIMUM_SCHEMA_VERSION,
};

/**
 * Decides how a document's declared version is treated.
 *
 * The version is required. Inferring it from the keys present would mean
 * guessing which contract the author wrote against, and the guess is wrong
 * exactly when it matters — on the document a newer build produced.
 */
export function evaluateSchemaVersion(
  document: Readonly<Record<string, unknown>>,
  policy: SchemaVersionPolicy = DEFAULT_SCHEMA_VERSION_POLICY,
): SchemaVersionVerdict {
  const declared = document[SCHEMA_VERSION_FIELD];
  if (!isPositiveInteger(declared)) {
    return {
      kind: "rejected",
      issue: { kind: "invalid-schema-version", severity: "error", path: SCHEMA_VERSION_FIELD },
    };
  }

  if (declared < policy.minimumSupportedVersion) {
    return {
      kind: "rejected",
      issue: {
        kind: "retired-schema-version",
        severity: "error",
        path: SCHEMA_VERSION_FIELD,
        observedSchemaVersion: declared,
        minimumSupportedVersion: policy.minimumSupportedVersion,
      },
    };
  }

  const declaredFloor = document[MINIMUM_READER_FIELD];
  if (declaredFloor !== undefined && !isPositiveInteger(declaredFloor)) {
    return {
      kind: "rejected",
      issue: { kind: "invalid-schema-version", severity: "error", path: MINIMUM_READER_FIELD },
    };
  }

  // Absent, the floor is this reader's own version: a producer that never
  // raised it added nothing this build is required to understand.
  const floor = declaredFloor ?? policy.readerSchemaVersion;
  if (floor > policy.readerSchemaVersion) {
    return {
      kind: "rejected",
      issue: {
        kind: "unsupported-schema-version",
        severity: "error",
        path: MINIMUM_READER_FIELD,
        observedSchemaVersion: declared,
        minimumCompatibleVersion: floor,
        readerSchemaVersion: policy.readerSchemaVersion,
      },
    };
  }

  return declared > policy.readerSchemaVersion
    ? { kind: "forward-compatible", schemaVersion: declared }
    : { kind: "current", schemaVersion: declared };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}
