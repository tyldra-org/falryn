/**
 * The run record, and what recovering from an earlier one produced.
 *
 * A *run* is one execution of the Falryn process. It writes its row at startup
 * and stamps a clean end during shutdown, so a row with no end time is a run
 * that did not close — killed, crashed, or still going. That single durable
 * fact is what makes "abandoned" distinguishable from "in flight somewhere
 * else", and without it a recovery pass can only choose between refusing to act
 * on anything and racing a second live Falryn.
 *
 * Four rules the types carry rather than document:
 *
 * - **Recovery never invents a completion.** Work that was interrupted becomes
 *   `uncertain` with `uncertain` effect, which is the vocabulary the runtime
 *   already uses for "nobody looked". It never becomes `failed`, because
 *   failure is an observation and this is the absence of one.
 * - **An unended run is presumed live.** With no liveness probe in v0.1, the
 *   only rule that cannot destroy a concurrent process's work is to leave its
 *   bytes alone. Ending a run is something a run does for itself.
 * - **A report carries counts, never content.** No path, digest, or byte
 *   appears in one, the same constraint every other report in this area holds.
 * - **Deleted, repaired, left, and failed stay separate facts**, so a pass that
 *   reached a bound is never presented as one that found nothing.
 */

import { z } from "zod";

import { brandedInteger, brandedString, timestampSchema } from "./branded-schema.ts";
import type { CodecIssue } from "./codec-error.ts";
import { configurationGeneration, type RunId, runId } from "./identity.ts";
import type { MeasurementCompleteness } from "./local-data.ts";
import type { EffectCertainty } from "./outcome.ts";
import { err, ok, type Result } from "./result.ts";
import type { SqliteStoreError } from "./sqlite.ts";
import type { Timestamp } from "./time.ts";

/**
 * One execution of the process.
 *
 * `endedAt` is the whole point of the row: it is written by the shutdown
 * sequence, so its absence is the durable trace of a run that did not get
 * there. `schemaVersion` records what the run opened at, so a recovery pass can
 * say which schema wrote the rows it is looking at.
 */
export type RunRecord = {
  readonly runId: RunId;
  readonly startedAt: Timestamp;
  /** When the run reached its shutdown sequence, or `null` if it never did. */
  readonly endedAt: Timestamp | null;
  readonly schemaVersion: number;
};

/**
 * What a pre-open probe found beside the database.
 *
 * SQLite's write-ahead log and shared-memory files are removed by Falryn's
 * close sequence, so finding one is the crashed-run signal
 * `reference/LOCAL-DATA.md` already describes. It has to be probed *before* the
 * database is opened, because opening it creates both.
 */
export type CrashSignals = {
  readonly writeAheadLogPresent: boolean;
  readonly sharedMemoryPresent: boolean;
};

export const NO_CRASH_SIGNALS: CrashSignals = {
  writeAheadLogPresent: false,
  sharedMemoryPresent: false,
};

/** What recovery concluded about one artifact left in the reserved state. */
export const ARTIFACT_RECOVERY_OUTCOMES = [
  /** The bytes were there and verified. The record is now readable. */
  "available",
  /** The bytes were there and did not verify. Set aside, never deleted. */
  "quarantined",
  /** The record describes bytes that are not present. Inferred here, nowhere else. */
  "missing",
  /** Its run may still be writing it, or a bound stopped the pass. */
  "left-for-inspection",
] as const;

export type ArtifactRecoveryOutcome = (typeof ARTIFACT_RECOVERY_OUTCOMES)[number];

/** What recovery did with one in-flight blob left behind. */
export const TEMPORARY_BLOB_OUTCOMES = [
  /** Its run ended without finalizing it, so nothing can still want it. */
  "discarded",
  /** Its run never ended, or nothing attributes it. Left exactly as found. */
  "left-for-inspection",
  /** A device refused the removal. Counted, never hidden. */
  "failed",
] as const;

export type TemporaryBlobOutcome = (typeof TEMPORARY_BLOB_OUTCOMES)[number];

export type RecoveryCount<Outcome extends string> = {
  readonly outcome: Outcome;
  readonly count: number;
};

/**
 * What one startup recovery pass established.
 *
 * Counts and separated facts, in the same shape as `ArtifactSweepReport` and
 * `RemovalOutcome`, rather than a third vocabulary for the same idea.
 */
export type RecoveryReport = {
  readonly runId: RunId;
  readonly crashSignals: CrashSignals;
  /** Records from an earlier run that had no completion, now `uncertain`. */
  readonly markedUncertain: number;
  readonly artifactsExamined: number;
  readonly artifacts: readonly RecoveryCount<ArtifactRecoveryOutcome>[];
  readonly temporaryBlobsExamined: number;
  readonly temporaryBlobs: readonly RecoveryCount<TemporaryBlobOutcome>[];
  /** Operations that could not be carried out. Never folded into a total. */
  readonly failed: number;
  /** Whether the pass reached everything, or stopped at a bound or a cancellation. */
  readonly completeness: MeasurementCompleteness;
  readonly effect: EffectCertainty;
};

export type RecoveryError =
  | { readonly kind: "recovery"; readonly code: "storage"; readonly error: SqliteStoreError }
  | {
      readonly kind: "recovery";
      readonly code: "malformed-row";
      readonly issues: readonly CodecIssue[];
    }
  /** A run identity this database already holds. Two runs cannot share one. */
  | { readonly kind: "recovery"; readonly code: "already-exists"; readonly runId: RunId }
  | { readonly kind: "recovery"; readonly code: "cancelled" };

/** Records one pass will complete before it reports that it saw only part. */
export const MAX_RECOVERED_RECORDS = 10_000;

/** Reserved artifacts one pass will resolve before reporting `partial`. */
export const MAX_RECOVERED_ARTIFACTS = 10_000;

/** In-flight blobs one pass will examine before reporting `partial`. */
export const MAX_RECOVERED_BLOBS = 10_000;

/**
 * Bytes one pass will re-read to verify artifacts, in total.
 *
 * A bound on the whole pass rather than per artifact: startup has to finish,
 * and a machine holding a hundred interrupted captures must not spend a minute
 * hashing them before the first prompt.
 */
export const MAX_RECOVERY_VERIFIED_BYTES = 64 * 1_024 * 1_024;

/** Shortest and longest recovery window a machine may configure. */
export const MIN_RECOVERY_WINDOW_MS = 1_000;
export const MAX_RECOVERY_WINDOW_MS = 60 * 60_000;

/**
 * How long an unattributable in-flight blob is left alone.
 *
 * It covers exactly one race: a second process that has inserted its run row
 * and has not yet allocated the bytes it is about to write. Long enough that
 * the gap between those two steps cannot span it, short enough that leftover
 * bytes are not kept for a session.
 */
export const DEFAULT_RECOVERY_WINDOW_MS = 5 * 60_000;

const runSchema = z.object({
  runId: brandedString(runId),
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
  // Reuses the generation codec's rule — a non-negative safe integer — because
  // a schema version is exactly that and a second parser would be a second
  // answer.
  schemaVersion: brandedInteger(configurationGeneration),
});

export function parseRunRecord(value: unknown): Result<RunRecord, readonly CodecIssue[]> {
  const parsed = runSchema.safeParse(value);
  if (!parsed.success) {
    return err(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join("."),
        code: issue.code,
      })),
    );
  }
  return ok(parsed.data);
}

/**
 * Whether a run may still be writing.
 *
 * A run with no end time is presumed live. Nothing in v0.1 probes liveness, and
 * the alternative — treating an unended run as abandoned once it is old enough
 * — deletes the in-flight bytes of any session that outlives the window.
 */
export function isPresumedLive(record: RunRecord, thisRun: RunId): boolean {
  return record.endedAt === null && record.runId !== thisRun;
}
