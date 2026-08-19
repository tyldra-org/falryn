/**
 * Explicit user backup, inspect, and restore of the local database.
 *
 * Migration already takes a `VACUUM INTO` copy before a destructive step.
 * This module is the user-facing sibling: a named copy that is never the
 * live file, never overwritten, and never upgraded by inspecting it.
 *
 * Support bundles and remote upload stay out of this contract. Local
 * diagnostics are facts about this machine; they are not a package to send.
 */

import type { ArtifactSweepReport } from "./artifact.ts";
import type { FileSystemError, LocalPathError } from "./filesystem.ts";
import type { Brand, IdentifierCodec, IdentityError } from "./identity.ts";
import { err, ok, type Result } from "./result.ts";
import type { CrashSignals } from "./run.ts";
import type { SqliteStoreError } from "./sqlite.ts";

export type BackupName = Brand<string, "BackupName">;

export const MAX_BACKUP_NAME_LENGTH = 64;
const LEGAL_BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const backupName: IdentifierCodec<BackupName> = {
  identity: "backupName",
  parse(value: unknown): Result<BackupName, IdentityError> {
    if (typeof value !== "string") {
      return err({ kind: "identity", code: "identifier-not-a-string", identity: "backupName" });
    }
    if (value.length === 0) {
      return err({ kind: "identity", code: "identifier-empty", identity: "backupName" });
    }
    if (value.length > MAX_BACKUP_NAME_LENGTH) {
      return err({ kind: "identity", code: "identifier-too-long", identity: "backupName" });
    }
    if (!LEGAL_BACKUP_NAME.test(value)) {
      return err({
        kind: "identity",
        code: "identifier-illegal-character",
        identity: "backupName",
      });
    }
    return ok(value as BackupName);
  },
  from(value: string): BackupName {
    const parsed = backupName.parse(value);
    if (!parsed.ok) {
      throw new Error(`invalid backupName: ${parsed.error.code}`);
    }
    return parsed.value;
  },
};

export type BackupError =
  | { readonly kind: "backup"; readonly code: "cancelled" }
  | { readonly kind: "backup"; readonly code: "store"; readonly error: SqliteStoreError }
  | { readonly kind: "backup"; readonly code: "identity"; readonly error: IdentityError }
  | { readonly kind: "backup"; readonly code: "filesystem"; readonly error: FileSystemError }
  | { readonly kind: "backup"; readonly code: "path"; readonly error: LocalPathError }
  | { readonly kind: "backup"; readonly code: "live-store-open" }
  | { readonly kind: "backup"; readonly code: "not-found" };

export type UserBackup = {
  readonly name: BackupName;
  readonly schemaVersion: number;
};

export type BackupInspection = {
  readonly name: BackupName;
  readonly schemaVersion: number;
  readonly byteLength: number;
};

export type LocalDiagnostics = {
  readonly schemaVersion: number;
  readonly crashSignals: CrashSignals;
  readonly sweep: ArtifactSweepReport | null;
};

export type RestoreResult = {
  readonly name: BackupName;
  readonly schemaVersion: number;
};

export function userBackupFileName(name: BackupName): string {
  return `falryn-user-backup-${name}.sqlite`;
}
