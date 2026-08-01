/**
 * The v0.1 key catalog.
 *
 * The mechanism in this source area is complete; this catalog is not, and is
 * not meant to be. A key is declared here only when something in this milestone
 * actually reads it — the `data` group for local-data roots, retention, and
 * quotas, and the `diagnostics` group for the collector and its debug window.
 *
 * The groups named in the configuration reference but owned elsewhere —
 * application, interface, workspace, providers, agents, context, tools,
 * extensions — are deliberately absent. Declaring a key whose consumer does not
 * exist would document behavior that does not exist, which is the same mistake
 * as emitting an error category nothing produces.
 *
 * Two absences are deliberate rather than incidental:
 *
 * - **No key relocates the configuration root.** Configuration discovery has to
 *   find a root before it can read a key, so a key that moved that root could
 *   only ever be read from the place it was trying to leave.
 * - **No key here has an alias or a deprecation**, because none has a
 *   predecessor: this is the first published version of the family. The alias
 *   and deprecation mechanism is proven against fixture registries instead of
 *   against an invented history.
 */

import { z } from "zod";

import {
  type ConfigurationIssue,
  type ConfigurationValue,
  type ConfigurationValues,
  configurationKeyPath,
  DIAGNOSTIC_LEVELS,
  MAX_DEBUG_PREVIEWS,
  MAX_DEBUG_WINDOW_MS,
  MAX_DIAGNOSTIC_CARDINALITY,
  MAX_RETAINED_DIAGNOSTICS,
  UNLIMITED,
} from "../domain/index.ts";
import {
  type ConfigurationKeyDeclaration,
  enumKey,
  integerKey,
  limitKey,
  limitSchema,
  mapKey,
  pathOverrideKey,
} from "./declaration.ts";
import type { ConfigurationCrossFieldRule } from "./registry.ts";

/** Longest a configured filesystem root may be, matching the platform limit. */
export const MAX_ROOT_PATH_LENGTH = 1_024;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MEBIBYTE = 1_024 * 1_024;
const GIBIBYTE = 1_024 * MEBIBYTE;

/** Shortest and longest retention a class may declare. */
export const MIN_RETENTION_MS = MINUTE_MS;
export const MAX_RETENTION_MS = 365 * DAY_MS;

/** Smallest and largest byte budget a class may declare. */
export const MIN_CLASS_BYTES = MEBIBYTE;
export const MAX_CLASS_BYTES = 1_024 * GIBIBYTE;

/**
 * Classes with a retention posture.
 *
 * Only the rotating and rebuildable classes appear. Configuration and
 * credential-reference metadata are preserved until explicitly selected for
 * removal, so a retention duration for them would describe a deletion that
 * never happens.
 */
export const RETENTION_CLASSES = ["logs", "cache", "temporaryIngest"] as const;

export type RetentionClass = (typeof RETENTION_CLASSES)[number];

const retentionEntrySchema = z.strictObject({
  maxAgeMs: limitSchema({ minimum: MIN_RETENTION_MS, maximum: MAX_RETENTION_MS }),
  maxBytes: limitSchema({ minimum: MIN_CLASS_BYTES, maximum: MAX_CLASS_BYTES }),
});

const DEFAULT_RETENTION: { readonly [key in RetentionClass]: ConfigurationValue } = {
  logs: { maxAgeMs: 14 * DAY_MS, maxBytes: 256 * MEBIBYTE },
  // A cache is rebuilt rather than expired, so only its size is bounded.
  cache: { maxAgeMs: UNLIMITED, maxBytes: GIBIBYTE },
  temporaryIngest: { maxAgeMs: DAY_MS, maxBytes: 256 * MEBIBYTE },
};

const RETENTION_PATH = configurationKeyPath("data.retention");
const TOTAL_QUOTA_PATH = configurationKeyPath("data.quotas.totalMaxBytes");

/** Roots configuration may relocate, and the variable each one reads. */
const RELOCATABLE_ROOTS: readonly {
  readonly path: string;
  readonly environmentVariable: string;
  readonly summary: string;
}[] = [
  {
    path: "data.roots.state",
    environmentVariable: "FALRYN_STATE_DIR",
    summary: "Directory holding durable application state.",
  },
  {
    path: "data.roots.cache",
    environmentVariable: "FALRYN_CACHE_DIR",
    summary: "Directory holding rebuildable caches and indexes.",
  },
  {
    path: "data.roots.logs",
    environmentVariable: "FALRYN_LOG_DIR",
    summary: "Directory holding rotating logs and diagnostics.",
  },
  {
    path: "data.roots.temporaryIngest",
    environmentVariable: "FALRYN_TEMP_DIR",
    summary: "Directory holding incomplete and recoverable temporary content.",
  },
  {
    path: "data.roots.artifacts",
    environmentVariable: "FALRYN_ARTIFACT_DIR",
    summary: "Directory holding durable artifacts under retention.",
  },
  {
    path: "data.roots.exports",
    environmentVariable: "FALRYN_EXPORT_DIR",
    summary: "Directory holding user-created export packages.",
  },
];

const rootOverrides: readonly ConfigurationKeyDeclaration[] = RELOCATABLE_ROOTS.map((root) =>
  pathOverrideKey({
    path: root.path,
    summary: root.summary,
    maxLength: MAX_ROOT_PATH_LENGTH,
    // A project checkout must not be able to move where this machine keeps its
    // data merely by being opened.
    scopes: ["user", "environment", "cli"],
    applicationClass: "application-restart",
    environmentVariable: root.environmentVariable,
  }),
);

/** The `data` group, consumed by the local-data owner. */
export const DATA_KEYS: readonly ConfigurationKeyDeclaration[] = [
  ...rootOverrides,
  mapKey({
    path: "data.retention",
    summary: "Age and size bounds per local-data ownership class.",
    allowedKeys: RETENTION_CLASSES,
    valueSchema: retentionEntrySchema,
    defaultValue: DEFAULT_RETENTION,
    scopes: ["user", "environment", "cli"],
    applicationClass: "next-operation",
    crossFieldDependencies: [TOTAL_QUOTA_PATH],
  }),
  limitKey({
    path: "data.quotas.totalMaxBytes",
    summary: "Total byte budget across every retained local-data class.",
    unit: "bytes",
    minimum: MIN_CLASS_BYTES,
    maximum: MAX_CLASS_BYTES,
    defaultValue: 4 * GIBIBYTE,
    scopes: ["user", "environment", "cli"],
    applicationClass: "next-operation",
    crossFieldDependencies: [RETENTION_PATH],
  }),
];

/** The `diagnostics` group, consumed by the diagnostics collector. */
export const DIAGNOSTICS_KEYS: readonly ConfigurationKeyDeclaration[] = [
  enumKey({
    path: "diagnostics.level",
    summary: "Lowest diagnostic level that is recorded.",
    allowed: DIAGNOSTIC_LEVELS,
    defaultValue: "info",
    scopes: ["user", "project", "profile", "environment", "cli"],
    applicationClass: "live",
    environmentVariable: "FALRYN_LOG_LEVEL",
  }),
  integerKey({
    path: "diagnostics.retention.maxEvents",
    summary: "Diagnostics retained before the oldest are dropped and counted.",
    unit: "items",
    minimum: 1,
    // The declared runtime bound is a safe hard maximum: a larger request is an
    // error rather than a silent clamp, so nobody believes a budget they asked
    // for is in effect when it is not.
    maximum: MAX_RETAINED_DIAGNOSTICS,
    defaultValue: MAX_RETAINED_DIAGNOSTICS,
    scopes: ["user", "environment", "cli"],
    applicationClass: "application-restart",
  }),
  integerKey({
    path: "diagnostics.retention.maxDistinctSeries",
    summary: "Distinct subsystem and code pairs the collector will accept.",
    unit: "items",
    minimum: 1,
    maximum: MAX_DIAGNOSTIC_CARDINALITY,
    defaultValue: MAX_DIAGNOSTIC_CARDINALITY,
    scopes: ["user", "environment", "cli"],
    applicationClass: "application-restart",
  }),
  integerKey({
    path: "diagnostics.debugWindow.ttlMs",
    summary: "How long a debug window stays open once it is opened.",
    unit: "milliseconds",
    minimum: 1_000,
    maximum: MAX_DEBUG_WINDOW_MS,
    defaultValue: 5 * MINUTE_MS,
    scopes: ["user", "environment", "cli"],
    applicationClass: "next-operation",
  }),
  integerKey({
    path: "diagnostics.debugWindow.maxPreviews",
    summary: "Redacted previews one debug window will produce.",
    unit: "items",
    minimum: 1,
    maximum: MAX_DEBUG_PREVIEWS,
    defaultValue: MAX_DEBUG_PREVIEWS,
    scopes: ["user", "environment", "cli"],
    applicationClass: "next-operation",
  }),
];

export const V0_1_CONFIGURATION_KEYS: readonly ConfigurationKeyDeclaration[] = [
  ...DATA_KEYS,
  ...DIAGNOSTICS_KEYS,
];

/**
 * Per-class budgets have to fit inside the total.
 *
 * Impossible at compose time rather than at use time: without this, the first
 * retention sweep would either exceed the total the user set or silently ignore
 * one of the two numbers, and both are worse than being told.
 */
export const TOTAL_QUOTA_COVERS_CLASSES: ConfigurationCrossFieldRule = {
  id: "data.quotas.total-covers-classes",
  paths: [TOTAL_QUOTA_PATH, RETENTION_PATH],
  evaluate(values: ConfigurationValues): ConfigurationIssue | null {
    const total = values[TOTAL_QUOTA_PATH];
    const retention = values[RETENTION_PATH];
    if (typeof total !== "number" || typeof retention !== "object" || retention === null) {
      // Either the total is unlimited or a shape rule already rejected it.
      return null;
    }

    let claimed = 0;
    for (const entry of Object.values(retention as Record<string, ConfigurationValue>)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        continue;
      }
      const maxBytes = (entry as Record<string, ConfigurationValue>).maxBytes;
      // An unbounded class cannot fit inside a bounded total, whatever the
      // other classes claim.
      if (maxBytes === UNLIMITED) {
        return conflict();
      }
      if (typeof maxBytes === "number") {
        claimed += maxBytes;
      }
    }

    return claimed > total ? conflict() : null;
  },
};

function conflict(): ConfigurationIssue {
  return {
    kind: "cross-field-conflict",
    severity: "error",
    path: TOTAL_QUOTA_PATH,
    rule: "data.quotas.total-covers-classes",
    relatedPaths: [TOTAL_QUOTA_PATH, RETENTION_PATH],
  };
}

export const V0_1_CROSS_FIELD_RULES: readonly ConfigurationCrossFieldRule[] = [
  TOTAL_QUOTA_COVERS_CLASSES,
];
