/**
 * Session export, import, and recovery interactions (#263).
 *
 * Composes export selection, verified import, named backup, inspect, restore,
 * and local diagnostics into one typed interaction plan. List, resume, rewind,
 * replay, and isolation stay in their own modules. Nothing here writes bytes,
 * opens files, or restores a live store without an exact confirmation.
 */

import { z } from "zod";

import { type BackupName, backupName } from "./backup.ts";
import type { ExportSelection } from "./export.ts";
import { exportName } from "./export.ts";
import { type SessionId, sessionId } from "./identity.ts";
import type { ExportName } from "./package.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import { MAX_SESSION_CATALOG } from "./session-catalog.ts";

export const SESSION_RECOVERY_VERSION = "session-recovery.v1";
export const SESSION_RECOVERY_SOURCE = "deterministic-recovery-interaction";

export const SESSION_RECOVERY_KINDS = [
  "export",
  "import",
  "backup",
  "inspect-backup",
  "restore-backup",
  "diagnostics",
] as const;

export type SessionRecoveryKind = (typeof SESSION_RECOVERY_KINDS)[number];

export type SessionRecoveryErrorCode =
  | "cancelled"
  | "confirmation-mismatch"
  | "empty"
  | "live-store-open"
  | "malformed"
  | "not-found"
  | "not-verified"
  | "oversized"
  | "unconfirmed";

export type SessionRecoveryError = {
  readonly kind: "session-recovery";
  readonly code: SessionRecoveryErrorCode;
  readonly field: string | null;
};

export type SessionRecoveryProvenance = {
  readonly version: typeof SESSION_RECOVERY_VERSION;
  readonly source: typeof SESSION_RECOVERY_SOURCE;
  readonly model: null;
};

export type SessionRecoveryConfirmationRequest = {
  readonly confirmationId: string;
  readonly kind: "restore-backup";
  readonly name: BackupName;
  readonly intentFingerprint: string;
};

export type SessionRecoveryConfirmation = {
  readonly confirmationId: string;
};

export type SessionRecoveryExportPlan = {
  readonly kind: "export";
  readonly selection: ExportSelection;
  readonly sessionIds: readonly SessionId[];
  readonly intentFingerprint: string;
  readonly provenance: SessionRecoveryProvenance;
};

export type SessionRecoveryImportPlan = {
  readonly kind: "import";
  readonly packageName: ExportName;
  readonly verified: true;
  readonly intentFingerprint: string;
  readonly provenance: SessionRecoveryProvenance;
};

export type SessionRecoveryBackupPlan = {
  readonly kind: "backup";
  readonly name: BackupName;
  readonly intentFingerprint: string;
  readonly provenance: SessionRecoveryProvenance;
};

export type SessionRecoveryInspectBackupPlan = {
  readonly kind: "inspect-backup";
  readonly name: BackupName;
  readonly intentFingerprint: string;
  readonly provenance: SessionRecoveryProvenance;
};

export type SessionRecoveryRestorePlan = {
  readonly kind: "restore-backup";
  readonly name: BackupName;
  readonly liveStoreClosed: true;
  readonly confirmation: SessionRecoveryConfirmation;
  readonly intentFingerprint: string;
  readonly provenance: SessionRecoveryProvenance;
};

export type SessionRecoveryDiagnosticsPlan = {
  readonly kind: "diagnostics";
  readonly intentFingerprint: string;
  readonly provenance: SessionRecoveryProvenance;
};

export type SessionRecoveryPlan =
  | SessionRecoveryExportPlan
  | SessionRecoveryImportPlan
  | SessionRecoveryBackupPlan
  | SessionRecoveryInspectBackupPlan
  | SessionRecoveryRestorePlan
  | SessionRecoveryDiagnosticsPlan;

export type SessionRecoveryInput = {
  readonly kind: unknown;
  readonly sessionIds?: unknown;
  readonly includeSensitive?: unknown;
  readonly packageName?: unknown;
  readonly verified?: unknown;
  readonly name?: unknown;
  readonly liveStoreClosed?: unknown;
  readonly confirmation?: unknown;
};

const confirmationSchema = z.object({ confirmationId: z.string().min(1) }).strict();

function recoveryError(code: SessionRecoveryErrorCode, field: string | null): SessionRecoveryError {
  return { kind: "session-recovery", code, field };
}

function provenance(): SessionRecoveryProvenance {
  return {
    version: SESSION_RECOVERY_VERSION,
    source: SESSION_RECOVERY_SOURCE,
    model: null,
  };
}

export function describeSessionRecoveryError(error: SessionRecoveryError): string {
  const field = error.field === null ? "recovery" : error.field;
  switch (error.code) {
    case "cancelled":
      return `cancelled ${field}`;
    case "confirmation-mismatch":
      return `confirmation mismatch ${field}`;
    case "empty":
      return `empty ${field}`;
    case "live-store-open":
      return `live store open ${field}`;
    case "malformed":
      return `malformed ${field}`;
    case "not-found":
      return `not found ${field}`;
    case "not-verified":
      return `not verified ${field}`;
    case "oversized":
      return `oversized ${field}`;
    case "unconfirmed":
      return `unconfirmed ${field}`;
    default:
      return assertNever(error.code, "unhandled session-recovery error");
  }
}

export function sessionRecoveryConfirmationRequest(
  name: BackupName,
): SessionRecoveryConfirmationRequest {
  const intentFingerprint = `restore-backup:${name}`;
  return {
    confirmationId: intentFingerprint,
    kind: "restore-backup",
    name,
    intentFingerprint,
  };
}

function parseBackup(value: unknown, field: string): Result<BackupName, SessionRecoveryError> {
  const parsed = backupName.parse(value);
  return parsed.ok ? ok(parsed.value) : err(recoveryError("malformed", field));
}

function parsePackage(value: unknown, field: string): Result<ExportName, SessionRecoveryError> {
  const parsed = exportName.parse(value);
  return parsed.ok ? ok(parsed.value) : err(recoveryError("malformed", field));
}

function planExport(
  input: SessionRecoveryInput,
): Result<SessionRecoveryExportPlan, SessionRecoveryError> {
  if (!Array.isArray(input.sessionIds)) {
    return err(recoveryError("malformed", "sessionIds"));
  }
  if (input.sessionIds.length === 0) {
    return err(recoveryError("empty", "sessionIds"));
  }
  if (input.sessionIds.length > MAX_SESSION_CATALOG) {
    return err(recoveryError("oversized", "sessionIds"));
  }
  const includeSensitive = input.includeSensitive === true;
  if (input.includeSensitive !== undefined && typeof input.includeSensitive !== "boolean") {
    return err(recoveryError("malformed", "includeSensitive"));
  }
  const sessionIds: SessionId[] = [];
  for (const [index, item] of input.sessionIds.entries()) {
    const parsed = sessionId.parse(item);
    if (!parsed.ok) {
      return err(recoveryError("malformed", `sessionIds.${index}`));
    }
    sessionIds.push(parsed.value);
  }
  const selection: ExportSelection = {
    kind: "sessions",
    sessionIds,
    includeSensitive,
  };
  const intentFingerprint = `export:${sessionIds.join(",")}`;
  return ok({
    kind: "export",
    selection,
    sessionIds,
    intentFingerprint,
    provenance: provenance(),
  });
}

function planImport(
  input: SessionRecoveryInput,
): Result<SessionRecoveryImportPlan, SessionRecoveryError> {
  const packageName = parsePackage(input.packageName, "packageName");
  if (!packageName.ok) {
    return packageName;
  }
  if (input.verified !== true) {
    return err(recoveryError("not-verified", "verified"));
  }
  const intentFingerprint = `import:${packageName.value}`;
  return ok({
    kind: "import",
    packageName: packageName.value,
    verified: true,
    intentFingerprint,
    provenance: provenance(),
  });
}

function planBackup(
  input: SessionRecoveryInput,
): Result<SessionRecoveryBackupPlan, SessionRecoveryError> {
  const name = parseBackup(input.name, "name");
  if (!name.ok) {
    return name;
  }
  const intentFingerprint = `backup:${name.value}`;
  return ok({
    kind: "backup",
    name: name.value,
    intentFingerprint,
    provenance: provenance(),
  });
}

function planInspectBackup(
  input: SessionRecoveryInput,
): Result<SessionRecoveryInspectBackupPlan, SessionRecoveryError> {
  const name = parseBackup(input.name, "name");
  if (!name.ok) {
    return name;
  }
  const intentFingerprint = `inspect-backup:${name.value}`;
  return ok({
    kind: "inspect-backup",
    name: name.value,
    intentFingerprint,
    provenance: provenance(),
  });
}

function planRestore(
  input: SessionRecoveryInput,
): Result<SessionRecoveryRestorePlan, SessionRecoveryError> {
  const name = parseBackup(input.name, "name");
  if (!name.ok) {
    return name;
  }
  if (input.liveStoreClosed !== true) {
    return err(recoveryError("live-store-open", "liveStoreClosed"));
  }
  const request = sessionRecoveryConfirmationRequest(name.value);
  const confirmation = confirmationSchema.safeParse(input.confirmation);
  if (!confirmation.success) {
    return err(recoveryError("unconfirmed", "confirmation"));
  }
  if (confirmation.data.confirmationId !== request.confirmationId) {
    return err(recoveryError("confirmation-mismatch", "confirmation.confirmationId"));
  }
  return ok({
    kind: "restore-backup",
    name: name.value,
    liveStoreClosed: true,
    confirmation: confirmation.data,
    intentFingerprint: request.intentFingerprint,
    provenance: provenance(),
  });
}

function planDiagnostics(): Result<SessionRecoveryDiagnosticsPlan, SessionRecoveryError> {
  return ok({
    kind: "diagnostics",
    intentFingerprint: "diagnostics",
    provenance: provenance(),
  });
}

/**
 * Plans one export, import, backup, inspect, restore, or diagnostics interaction.
 * Restore requires an exact confirmation bound to the backup name.
 */
export function planSessionRecovery(
  input: SessionRecoveryInput,
  signal?: AbortSignal,
): Result<SessionRecoveryPlan, SessionRecoveryError> {
  if (signal?.aborted) {
    return err(recoveryError("cancelled", "signal"));
  }
  if (
    typeof input.kind !== "string" ||
    !SESSION_RECOVERY_KINDS.includes(input.kind as SessionRecoveryKind)
  ) {
    return err(recoveryError("malformed", "kind"));
  }
  switch (input.kind as SessionRecoveryKind) {
    case "export":
      return planExport(input);
    case "import":
      return planImport(input);
    case "backup":
      return planBackup(input);
    case "inspect-backup":
      return planInspectBackup(input);
    case "restore-backup":
      return planRestore(input);
    case "diagnostics":
      return planDiagnostics();
    default:
      return assertNever(input.kind as never, "unhandled session-recovery kind");
  }
}
