/**
 * Structured diagnostics.
 *
 * A diagnostic describes *that* something happened and how long it took. It
 * never carries payload content: the whole point of a separate diagnostic shape
 * is that it can be logged, exported, and put in front of a support engineer
 * without carrying what the user was working on.
 *
 * Metadata values are constrained to primitives, so a caller cannot attach an
 * object graph that happens to contain a request body.
 */

import type { DurationMs, Instant } from "./clock.ts";
import type { CorrelationIds } from "./error.ts";

export const DIAGNOSTIC_LEVELS = ["debug", "info", "warn", "error"] as const;

export type DiagnosticLevel = (typeof DIAGNOSTIC_LEVELS)[number];

/**
 * What the v0.1 runtime can actually describe.
 *
 * Each corresponds to something a sibling already produces. A subsystem is not
 * added here until it emits.
 */
export const DIAGNOSTIC_SUBSYSTEMS = [
  "scope",
  "scheduler",
  "shutdown",
  "codec",
  "credentials",
] as const;

export type DiagnosticSubsystem = (typeof DIAGNOSTIC_SUBSYSTEMS)[number];

export function isDiagnosticSubsystem(value: unknown): value is DiagnosticSubsystem {
  return typeof value === "string" && (DIAGNOSTIC_SUBSYSTEMS as readonly string[]).includes(value);
}

/** Primitives only — an object would let a payload in through the back door. */
export type DiagnosticValue = string | number | boolean;

export type DiagnosticEvent = {
  readonly at: Instant;
  readonly level: DiagnosticLevel;
  readonly subsystem: DiagnosticSubsystem;
  readonly code: string;
  readonly correlation: CorrelationIds;
  /** Which stage of the operation this describes, when the operation has stages. */
  readonly stage: string | null;
  readonly durationMs: DurationMs | null;
  /** Declared bounds relevant to this event, such as a queue maximum. */
  readonly limits: Readonly<Record<string, number>> | null;
  readonly metadata: Readonly<Record<string, DiagnosticValue>>;
};

/** Diagnostics retained by a collector before the oldest are dropped and counted. */
export const MAX_RETAINED_DIAGNOSTICS = 2_000;

/**
 * Distinct `subsystem:code` pairs a collector will accept.
 *
 * Cardinality is bounded because an unbounded label space is how a diagnostics
 * pipeline turns into a memory leak with a metrics bill attached.
 */
export const MAX_DIAGNOSTIC_CARDINALITY = 256;

/** Metadata keys allowed on one event. */
export const MAX_DIAGNOSTIC_METADATA_KEYS = 16;

/** Longest metadata string value before truncation. */
export const MAX_DIAGNOSTIC_VALUE_LENGTH = 120;

/**
 * Bounds on a debug window.
 *
 * They live beside the other declared diagnostic bounds rather than with the
 * redactor that enforces them, because configuration declares keys against
 * them and configuration depends on the domain only.
 */

/** Longest a debug window may stay open, regardless of what was requested. */
export const MAX_DEBUG_WINDOW_MS = 15 * 60 * 1_000;

/** Most previews one window will produce. */
export const MAX_DEBUG_PREVIEWS = 100;

/** Longest a debug preview may be. */
export const MAX_DEBUG_PREVIEW_LENGTH = 512;

export type DiagnosticsReport = {
  readonly retained: number;
  readonly dropped: number;
  /** Events refused because the cardinality bound was already reached. */
  readonly refusedForCardinality: number;
  readonly distinctSeries: number;
};
