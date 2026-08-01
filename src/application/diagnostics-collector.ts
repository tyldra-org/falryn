/**
 * The runtime diagnostics collector.
 *
 * Bounded in three directions at once: how many events are retained, how many
 * distinct series exist, and how much metadata one event may carry. An
 * unbounded label space is the usual way a diagnostics pipeline becomes a
 * memory leak, so a new series past the cardinality bound is refused and
 * counted rather than admitted.
 *
 * Everything that goes in is redacted first. The collector is the last place a
 * value could escape into a log, so it does not trust its callers.
 */

import type { OwnershipRegistration } from "../domain/index.ts";
import {
  type ClockPort,
  type CorrelationIds,
  type DiagnosticEvent,
  type DiagnosticLevel,
  type DiagnosticSubsystem,
  type DiagnosticsReport,
  type DiagnosticValue,
  type DurationMs,
  MAX_DIAGNOSTIC_CARDINALITY,
  MAX_DIAGNOSTIC_METADATA_KEYS,
  MAX_RETAINED_DIAGNOSTICS,
  NO_CORRELATION,
} from "../domain/index.ts";
import { redactMetadata, redactText } from "./redaction.ts";

/** Events discarded per trim, so trimming is amortized rather than per-event. */
const TRIM_CHUNK = 256;

/**
 * This subsystem's claim on the log ownership class.
 *
 * Declared beside the collector because an owner registers its own class. Logs
 * rotate and are cleaned by retention, so they are safe to remove on a scoped
 * reset — unlike the user-authored classes beside them.
 */
export const DIAGNOSTICS_OWNERSHIP: OwnershipRegistration = {
  ownershipClass: "logs",
  owner: "diagnostics",
  durability: "rotating",
  removalPosture: "retention-cleanup",
  roots: ["logs"],
  external: false,
};

export type EmitRequest = {
  readonly level: DiagnosticLevel;
  readonly subsystem: DiagnosticSubsystem;
  readonly code: string;
  readonly correlation?: CorrelationIds;
  readonly stage?: string | null;
  readonly durationMs?: DurationMs | null;
  readonly limits?: Readonly<Record<string, number>> | null;
  readonly metadata?: Readonly<Record<string, DiagnosticValue>>;
};

export type EmitOutcome =
  | { readonly kind: "recorded"; readonly event: DiagnosticEvent }
  /** A new series past the cardinality bound. Counted, never silently dropped. */
  | { readonly kind: "refused"; readonly reason: "cardinality-exceeded"; readonly maximum: number };

export type DiagnosticsCollector = {
  emit(request: EmitRequest): EmitOutcome;
  events(): readonly DiagnosticEvent[];
  report(): DiagnosticsReport;
  clear(): void;
};

export function createDiagnosticsCollector(options: {
  readonly clock: ClockPort;
}): DiagnosticsCollector {
  const { clock } = options;
  const events: DiagnosticEvent[] = [];
  const series = new Set<string>();
  let dropped = 0;
  let refusedForCardinality = 0;

  return {
    emit(request: EmitRequest): EmitOutcome {
      const code = redactText(request.code, 120);
      const key = `${request.subsystem}:${code}`;
      if (!series.has(key) && series.size >= MAX_DIAGNOSTIC_CARDINALITY) {
        refusedForCardinality += 1;
        return {
          kind: "refused",
          reason: "cardinality-exceeded",
          maximum: MAX_DIAGNOSTIC_CARDINALITY,
        };
      }
      series.add(key);

      // Metadata is bounded by key count before redaction, so a caller cannot
      // spend the redaction budget on keys that were going to be dropped.
      const trimmedMetadata = Object.fromEntries(
        Object.entries(request.metadata ?? {}).slice(0, MAX_DIAGNOSTIC_METADATA_KEYS),
      );

      const event: DiagnosticEvent = {
        at: clock.now(),
        level: request.level,
        subsystem: request.subsystem,
        code,
        correlation: request.correlation ?? NO_CORRELATION,
        stage:
          request.stage === undefined || request.stage === null
            ? null
            : redactText(request.stage, 120),
        durationMs: request.durationMs ?? null,
        limits: request.limits ?? null,
        metadata: redactMetadata(trimmedMetadata),
      };

      events.push(event);
      if (events.length > MAX_RETAINED_DIAGNOSTICS) {
        dropped += events.splice(0, TRIM_CHUNK).length;
      }
      return { kind: "recorded", event };
    },

    events(): readonly DiagnosticEvent[] {
      return [...events];
    },

    report(): DiagnosticsReport {
      return {
        retained: events.length,
        dropped,
        refusedForCardinality,
        distinctSeries: series.size,
      };
    },

    clear(): void {
      events.length = 0;
      dropped = 0;
    },
  };
}
