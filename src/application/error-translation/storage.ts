/** SQLite and renderer boundary translations. */

import {
  type FalrynError,
  MAX_CAUSE_DETAIL_LENGTH,
  type RecoveryAction,
  type RendererFailure,
  recoveryForEffect,
  type SqliteFailure,
  type SqliteStoreError,
} from "../../domain/index.ts";
import { redactText } from "../redaction.ts";
import { build, type ErrorContext } from "./shared.ts";

export function fromSqliteStoreError(
  error: SqliteStoreError,
  context: ErrorContext = {},
): FalrynError {
  const cancelled = error.code === "cancelled";
  return build({
    code: cancelled ? "cancellation.sqlite.cancelled" : `data.sqlite.${error.code}`,
    category: cancelled ? "cancellation" : "data",
    message: sqliteStoreMessage(error),
    retryable: error.code === "busy",
    effect: error.effect,
    recovery: sqliteRecovery(error),
    cause: {
      source: "sqlite",
      code: error.code,
      detail: sqliteStoreDetail(error),
    },
    ...context,
  });
}

/**
 * Recovery for the failures whose normal answer is not the effect's default.
 *
 * A refused migration set, a mismatched checksum, and a database from a newer
 * build are all `none` effect, whose default recovery is "retry" — and retrying
 * any of them repeats the same refusal. They need a person to look.
 */
function sqliteRecovery(error: SqliteStoreError): readonly RecoveryAction[] {
  switch (error.code) {
    case "invalid-migration-set":
    case "checksum-mismatch":
    case "schema-too-new":
    case "integrity-check-failed":
    case "statement-rejected":
    case "migration-failed":
    case "migration-interrupted":
      return ["inspect-state"];
    default:
      return recoveryForEffect(error.effect);
  }
}

function sqliteStoreMessage(error: SqliteStoreError): string {
  switch (error.code) {
    case "unavailable":
      return "The local database could not be opened or used.";
    case "busy":
      return "Another process is using the local database.";
    case "disk-full":
      return "There is not enough disk space to write to the local database.";
    case "integrity-check-failed":
      return "The local database failed its integrity check and was not modified.";
    case "schema-too-new":
      return "The local database was written by a newer version of Falryn.";
    case "checksum-mismatch":
      return "An applied database migration does not match this build.";
    case "invalid-migration-set":
      return "This build declares a database migration set it cannot apply.";
    case "migration-failed":
      return "A database migration failed and was rolled back.";
    case "migration-interrupted":
      return "A database migration stopped part-way and left a diagnosable state.";
    case "statement-rejected":
      return "The local database rejected a statement.";
    case "cancelled":
      return "The database operation was cancelled before it committed.";
    case "closed":
      return "The local database is already closed.";
  }
}

/**
 * The facts a developer needs, structural first.
 *
 * Only the driver's message is redacted; a version number, a checksum, and a
 * migration name are Falryn's own and mean nothing without them.
 */
function sqliteStoreDetail(error: SqliteStoreError): string | null {
  switch (error.code) {
    case "unavailable":
    case "busy":
    case "disk-full":
    case "statement-rejected":
      return causeDetail(error.operation, error.cause);
    case "integrity-check-failed":
      return redactText(`problems=${error.problems.join("; ")}`, MAX_CAUSE_DETAIL_LENGTH);
    case "schema-too-new":
      return `recorded=${error.recordedVersion} application=${error.applicationVersion}`;
    case "checksum-mismatch":
      return `version=${error.version} recorded=${error.recordedChecksum} declared=${error.declaredChecksum}`;
    case "invalid-migration-set":
      return error.issues
        .map((issue) => `${issue.code}@${issue.version ?? "?"}`)
        .join(" ")
        .slice(0, MAX_CAUSE_DETAIL_LENGTH);
    case "migration-failed":
      return redactText(
        `version=${error.version} recorded=${error.recordedVersion} applied=${error.appliedVersions.join("|")} backup=${error.backupPath === null ? "none" : "taken"} ${causeDetail("transaction", error.cause) ?? ""}`,
        MAX_CAUSE_DETAIL_LENGTH,
      );
    case "migration-interrupted":
      return `recorded=${error.recordedVersion} applied=${error.appliedVersions.join("|")} backup=${error.backupPath === null ? "none" : "taken"}`;
    case "cancelled":
    case "closed":
      return `operation=${error.operation}`;
  }
}

function causeDetail(operation: string, cause: SqliteFailure): string | null {
  const facts = `operation=${operation} driver=${cause.driverCode ?? "none"}`;
  return cause.detail === null
    ? facts
    : redactText(`${facts} ${cause.detail}`, MAX_CAUSE_DETAIL_LENGTH);
}

/**
 * A terminal renderer that could not start, or that went away.
 *
 * Split across two categories on purpose, because the two failures ask
 * different things of the reader. A renderer that failed to initialize or was
 * lost is an *integration* failure — the platform's native library, the host
 * streams, or the terminal itself did not provide what this run needed — and it
 * exits as an unavailable dependency, which is a true statement about a machine
 * that may simply not have a terminal today. A second renderer being opened is
 * not that: nothing was unavailable, Falryn asked for two owners of one
 * terminal, and calling that an unavailable dependency would send someone to
 * check their environment for a defect in this program.
 *
 * The effect is `none` in both cases, and that is the load-bearing claim: a
 * renderer draws. It changes nothing outside Falryn, so a caller reading this
 * may retry without inspecting anything first.
 */
export function fromRendererFailure(
  failure: RendererFailure,
  context: ErrorContext = {},
): FalrynError {
  const detail =
    failure.detail === null ? null : redactText(failure.detail, MAX_CAUSE_DETAIL_LENGTH);

  if (failure.code === "already-open") {
    return build({
      code: "internal.renderer-already-open",
      category: "internal",
      message: "A terminal renderer is already open in this process.",
      retryable: false,
      effect: "none",
      cause: { source: "renderer", code: failure.code, detail },
      ...context,
    });
  }

  return build({
    code: `integration.renderer.${failure.code}`,
    category: "integration",
    message:
      failure.code === "initialization-failed"
        ? "The terminal interface could not be started."
        : "The terminal interface stopped unexpectedly.",
    retryable: true,
    effect: "none",
    cause: { source: "renderer", code: failure.code, detail },
    ...context,
  });
}

/** A locally planned removal that could not be applied as requested. */
/**
 * Folds an export-pipeline failure into the runtime contract.
 *
 * Nested store, package, and blob failures keep their existing translators.
 * Selection and bound failures never carry record text or secret values: the
 * bound name and the counts are enough to refuse without describing contents.
 */
