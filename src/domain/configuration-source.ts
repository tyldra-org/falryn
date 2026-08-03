/**
 * Where a configuration value came from, and what changing it costs.
 *
 * #7 owns what a key *is*. This module owns what a composed value *is*: which
 * source won, which sources were overridden, which were ignored and why, and
 * which generation the whole thing belongs to.
 *
 * Two rules the types carry:
 *
 * - **Every effective value keeps its provenance.** A value with no source is
 *   not representable, so inspection can always answer "where did this come
 *   from" without the composer having to remember to record it.
 * - **A rejected source never carries content.** A parse failure reports a
 *   position and a code; an unreadable file reports which failure it was. The
 *   bytes of a file that failed to parse are exactly the bytes most likely to
 *   contain a credential someone typed into the wrong place.
 */

import type {
  ConfigurationIssue,
  ConfigurationKeyPath,
  ConfigurationScope,
  ConfigurationSourceKind,
  ConfigurationValue,
  ConfigurationValues,
} from "./configuration.ts";
import type { ConfigurationApplicationClass } from "./event.ts";
import type { LocalPath } from "./filesystem.ts";
import type { ConfigurationGeneration } from "./identity.ts";

/**
 * The declared precedence, lowest first.
 *
 * Order is data rather than a sequence of calls, so precedence can be asserted
 * directly instead of inferred from the order a composer happens to run in.
 */
export const CONFIGURATION_LAYER_ORDER: readonly ConfigurationSourceKind[] = [
  "built-in-default",
  "user-file",
  "project-file",
  "profile",
  "environment",
  "cli-override",
];

/** Where a layer's values came from. */
export type ConfigurationSource = {
  readonly kind: ConfigurationSourceKind;
  /** The file this layer read, or `null` for defaults, environment, and CLI. */
  readonly file: LocalPath | null;
  /** Which profile a profile layer selected, or `null`. */
  readonly profile: string | null;
};

/** Why a discovered source contributed nothing. */
export const SOURCE_OUTCOMES = [
  "loaded",
  "absent",
  "empty",
  "unreadable",
  "oversized",
  "malformed-encoding",
  "malformed-syntax",
  "rejected",
] as const;

export type SourceOutcome = (typeof SOURCE_OUTCOMES)[number];

/**
 * What happened to one source.
 *
 * `absent` is not a failure — most configuration files do not exist — but it is
 * still reported, because "the file you edited was never found" is the single
 * most common configuration confusion there is.
 */
export type SourceReport = {
  readonly source: ConfigurationSource;
  readonly outcome: SourceOutcome;
  /** Issues this source produced. Structural only, never file content. */
  readonly issues: readonly ConfigurationIssue[];
  /** Keys this source set, before precedence decided which of them won. */
  readonly declaredKeys: readonly ConfigurationKeyPath[];
  /**
   * Where a syntax error was found, or `null`.
   *
   * A line and a column and nothing else. It is what makes a malformed file
   * actionable without the diagnostic quoting the text at that position — which
   * is precisely the text most likely to be the reason the file was malformed.
   */
  readonly position: SourcePosition | null;
};

/**
 * The outcomes that mean a document exists and Falryn did not read it.
 *
 * `absent` and `empty` are deliberately not here. A file that is not there says
 * nothing, and an empty file is what `> falryn.jsonc` leaves — neither means the
 * configuration in effect differs from the one its author wrote. Each outcome
 * below does: a document exists at a path the user chose, the load carried on
 * without it, and the settings now in effect are not the settings on disk.
 *
 * `malformed-syntax` and `rejected` are absent for the opposite reason. Those
 * sources *were* read, and they already refuse the whole load.
 */
export const UNREAD_SOURCE_OUTCOMES: readonly SourceOutcome[] = [
  "unreadable",
  "oversized",
  "malformed-encoding",
];

/** Whether one source report describes a document that exists and was skipped. */
export function isUnreadSource(report: SourceReport): boolean {
  return UNREAD_SOURCE_OUTCOMES.includes(report.outcome);
}

/** A parse failure's location. Line and column only, never the text there. */
export type SourcePosition = {
  readonly line: number;
  readonly column: number;
};

export type ParseFailure = {
  readonly kind: "configuration-parse";
  readonly code: string;
  readonly position: SourcePosition;
};

/**
 * Where one effective value came from.
 *
 * `redactedOriginal` is what the winning source literally said, already passed
 * through the runtime redactor. It exists so inspection can show a value that
 * was overridden or coerced without re-reading the file — and it is redacted at
 * construction rather than at display, because a projection that redacts on the
 * way out is one forgotten call site away from leaking.
 */
export type ValueProvenance = {
  readonly path: ConfigurationKeyPath;
  readonly source: ConfigurationSource;
  /** `null` for a layer that has no scope, which is only the defaults layer. */
  readonly scope: ConfigurationScope | null;
  /** Index into {@link CONFIGURATION_LAYER_ORDER}, so precedence is comparable. */
  readonly layerIndex: number;
  readonly schemaVersion: number;
  readonly redactedOriginal: ConfigurationValue;
};

/** A value a later layer replaced, kept so inspection can show what lost. */
export type OverriddenValue = {
  readonly path: ConfigurationKeyPath;
  readonly source: ConfigurationSource;
  readonly redactedOriginal: ConfigurationValue;
};

/** One composed, cross-validated configuration. */
export type ConfigurationGenerationRecord = {
  readonly generation: ConfigurationGeneration;
  readonly values: ConfigurationValues;
  readonly provenance: readonly ValueProvenance[];
  readonly overridden: readonly OverriddenValue[];
  readonly sources: readonly SourceReport[];
  /** Warnings that did not prevent the generation from being published. */
  readonly issues: readonly ConfigurationIssue[];
};

/** One key that differs between two generations. */
export type ConfigurationChange = {
  readonly path: ConfigurationKeyPath;
  readonly applicationClass: ConfigurationApplicationClass;
  /** Both sides redacted, so a diff is as safe to log as a diagnostic. */
  readonly redactedBefore: ConfigurationValue;
  readonly redactedAfter: ConfigurationValue;
};

/**
 * What a load or refresh produced.
 *
 * `unchanged` is a distinct outcome rather than a `published` with an empty
 * change list: no generation is allocated and no event is appended, and a
 * caller that treated the two the same would publish a generation per poll.
 */
export type ConfigurationLoadOutcome =
  | {
      readonly kind: "published";
      readonly record: ConfigurationGenerationRecord;
      readonly changes: readonly ConfigurationChange[];
      /** The strongest class among the changes, which is what a caller acts on. */
      readonly applicationClass: ConfigurationApplicationClass;
    }
  | { readonly kind: "unchanged"; readonly record: ConfigurationGenerationRecord }
  /**
   * Composition failed and the previous generation is still in effect.
   *
   * `retained` is `null` only on the very first load, where there is nothing to
   * fall back to and the caller has no configuration at all.
   */
  | {
      readonly kind: "rejected";
      readonly issues: readonly ConfigurationIssue[];
      readonly sources: readonly SourceReport[];
      readonly retained: ConfigurationGenerationRecord | null;
    }
  /**
   * Composition succeeded and publication did not.
   *
   * Distinct from `rejected`, which means the configuration itself was refused.
   * Here the values are valid but no consumer was told about them, so the
   * previous generation stays in effect rather than a new one taking hold
   * silently.
   */
  | {
      readonly kind: "publish-failed";
      readonly code: string;
      readonly retained: ConfigurationGenerationRecord | null;
    }
  | { readonly kind: "cancelled" };

/** One key as inspection shows it. */
export type InspectedValue = {
  readonly path: ConfigurationKeyPath;
  /** Rendered through the key's declared sensitivity. Never raw bytes. */
  readonly value: ConfigurationValue;
  readonly source: ConfigurationSource;
  readonly scope: ConfigurationScope | null;
  readonly overriddenBy: readonly OverriddenValue[];
};

/**
 * The whole configuration as a caller may display it.
 *
 * A data structure, not text. Rendering it for humans or machines belongs to
 * the surfaces, which is why nothing here formats anything.
 */
export type ConfigurationInspection = {
  readonly generation: ConfigurationGeneration;
  readonly values: readonly InspectedValue[];
  readonly sources: readonly SourceReport[];
  readonly issues: readonly ConfigurationIssue[];
};
