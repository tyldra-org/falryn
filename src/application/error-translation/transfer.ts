/** Export, import, backup, and record translations. */

import {
  assertNever,
  type BackupError,
  type ExportError,
  type FalrynError,
  type ImportError,
  type RecordError,
} from "../../domain/index.ts";
import { fromArtifactError } from "./catalog.ts";
import { fromEventStoreError, fromIdentityError } from "./core.ts";
import { build, type ErrorContext } from "./shared.ts";
import { fromSqliteStoreError } from "./storage.ts";

export function fromExportError(error: ExportError, context: ErrorContext = {}): FalrynError {
  switch (error.code) {
    case "storage":
      return fromSqliteStoreError(error.error, context);
    case "package": {
      const cancelled = error.error.code === "cancelled";
      return build({
        code: cancelled
          ? "cancellation.export.package.cancelled"
          : `data.export.package.${error.error.code}`,
        category: cancelled ? "cancellation" : "data",
        message: cancelled
          ? "The export package operation was cancelled."
          : `The export package could not be written (${error.error.code}).`,
        retryable: cancelled,
        effect: "none",
        cause: {
          source: "export",
          code: error.error.code,
          detail: error.error.operation,
        },
        ...context,
      });
    }
    case "bytes": {
      const cancelled = error.error.code === "cancelled";
      return build({
        code: cancelled
          ? "cancellation.export.bytes.cancelled"
          : `data.export.bytes.${error.error.code}`,
        category: cancelled ? "cancellation" : "data",
        message: cancelled
          ? "Reading artifact bytes for export was cancelled."
          : `Export could not read artifact bytes (${error.error.code}).`,
        retryable: cancelled,
        effect: "none",
        cause: {
          source: "export",
          code: error.error.code,
          detail: error.error.operation,
        },
        ...context,
      });
    }
    case "not-found":
      return build({
        code: "data.export.not-found",
        category: "data",
        message: "A selected session was not found.",
        retryable: false,
        effect: "none",
        cause: { source: "export", code: error.code, detail: null },
        ...context,
      });
    case "empty-selection":
      return build({
        code: "data.export.empty-selection",
        category: "data",
        message: "The export selection matched no sessions.",
        retryable: false,
        effect: "none",
        cause: { source: "export", code: error.code, detail: null },
        ...context,
      });
    case "oversize":
      return build({
        code: "data.export.oversize",
        category: "data",
        message: `The export selection exceeds the ${error.bound} bound.`,
        retryable: false,
        effect: "none",
        cause: {
          source: "export",
          code: error.code,
          detail: `${error.bound}:${error.requested}:${error.maximum}`,
        },
        ...context,
      });
    case "digest-mismatch":
      return build({
        code: "data.export.digest-mismatch",
        category: "data",
        message: "An artifact's bytes changed between inventory and write.",
        retryable: true,
        effect: "none",
        cause: { source: "export", code: error.code, detail: null },
        ...context,
      });
    case "insufficient-space":
      return build({
        code: "data.export.insufficient-space",
        category: "data",
        message: "There is not enough free space to write the export package.",
        retryable: true,
        effect: "none",
        cause: {
          source: "export",
          code: error.code,
          detail: `${error.requiredBytes}:${error.availableBytes}`,
        },
        ...context,
      });
    case "malformed-manifest":
      return build({
        code: "data.export.malformed-manifest",
        category: "data",
        message: "The export manifest could not be encoded.",
        retryable: false,
        effect: "none",
        cause: {
          source: "export",
          code: error.code,
          detail: error.issues.map((issue) => `${issue.path || "<root>"}:${issue.code}`).join(", "),
        },
        ...context,
      });
    case "incompatible-version":
      return build({
        code: "data.export.incompatible-version",
        category: "data",
        message: "The export package schema is not compatible with this build.",
        retryable: false,
        effect: "none",
        cause: {
          source: "export",
          code: error.code,
          detail: `${error.packageSchemaVersion}:${error.packageRequiresAtLeast}:${error.readerSchemaVersion}`,
        },
        ...context,
      });
    case "truncated-package":
      return build({
        code: "data.export.truncated-package",
        category: "data",
        message: "The export package is shorter than its declared length.",
        retryable: false,
        effect: "none",
        cause: {
          source: "export",
          code: error.code,
          detail: `${error.expectedBytes}:${error.observedBytes}`,
        },
        ...context,
      });
    case "cancelled":
      return build({
        code: "cancellation.export.cancelled",
        category: "cancellation",
        message: "The export was cancelled before it finished.",
        retryable: true,
        effect: "none",
        cause: { source: "export", code: error.code, detail: null },
        ...context,
      });
    default:
      return assertNever(error, "unhandled export error");
  }
}

/**
 * Folds an import or effect-free replay failure into the runtime contract.
 *
 * Verification and manifest failures fail closed before any partial apply.
 * Nested export, record, artifact, and event failures keep their translators.
 */
export function fromImportError(error: ImportError, context: ErrorContext = {}): FalrynError {
  switch (error.code) {
    case "unverified-package":
      return build({
        code: "data.import.unverified-package",
        category: "data",
        message: "The export package failed verification and was not imported.",
        retryable: false,
        effect: "none",
        cause: { source: "import", code: error.code, detail: null },
        ...context,
      });
    case "malformed-record":
      return build({
        code: "data.import.malformed-record",
        category: "data",
        message: "The export records member could not be parsed.",
        retryable: false,
        effect: "none",
        cause: {
          source: "import",
          code: error.code,
          detail: error.issues.map((issue) => `${issue.path || "<root>"}:${issue.code}`).join(", "),
        },
        ...context,
      });
    case "identity-collision":
      return build({
        code: "data.import.identity-collision",
        category: "data",
        message: "The export package declares an identity that already exists locally.",
        retryable: false,
        effect: "none",
        cause: {
          source: "import",
          code: error.code,
          detail: `${error.entity}:${error.identity}`,
        },
        ...context,
      });
    case "empty-package":
      return build({
        code: "data.import.empty-package",
        category: "data",
        message: "The export package contains no importable sessions.",
        retryable: false,
        effect: "none",
        cause: { source: "import", code: error.code, detail: null },
        ...context,
      });
    case "cancelled":
      return build({
        code: "cancellation.import.cancelled",
        category: "cancellation",
        message: "The import was cancelled before it finished.",
        retryable: true,
        effect: "none",
        cause: { source: "import", code: error.code, detail: null },
        ...context,
      });
    case "export":
      return fromExportError(error.error, context);
    case "record":
      return fromRecordError(error.error, context);
    case "artifact":
      return fromArtifactError(error.error, context);
    case "events":
      return fromEventStoreError(error.error, context);
    default:
      return assertNever(error, "unhandled import error");
  }
}

/** A user backup, inspect, restore, or local diagnostics refusal. */
export function fromBackupError(error: BackupError, context: ErrorContext = {}): FalrynError {
  switch (error.code) {
    case "cancelled":
      return build({
        code: "cancellation.data.backup.cancelled",
        category: "cancellation",
        message: "The backup operation was cancelled.",
        retryable: true,
        effect: "none",
        cause: { source: "backup", code: error.code, detail: null },
        ...context,
      });
    case "store":
      return fromSqliteStoreError(error.error, context);
    case "identity":
      return fromIdentityError(error.error, context);
    case "filesystem":
      return build({
        code: `data.backup.filesystem.${error.error.code}`,
        category: "data",
        message: "The backup could not access local storage.",
        retryable: false,
        effect: "none",
        cause: { source: "filesystem", code: error.error.code, detail: null },
        ...context,
      });
    case "path":
      return build({
        code: `data.backup.path.${error.error.code}`,
        category: "data",
        message: "A backup path could not be resolved safely.",
        retryable: false,
        effect: "none",
        cause: { source: "local-path", code: error.error.code, detail: null },
        ...context,
      });
    case "live-store-open":
      return build({
        code: "data.backup.live-store-open",
        category: "data",
        message: "Restore requires the live database to be closed.",
        retryable: false,
        effect: "none",
        cause: { source: "backup", code: error.code, detail: null },
        ...context,
      });
    case "not-found":
      return build({
        code: "data.backup.not-found",
        category: "data",
        message: "The named backup was not found.",
        retryable: false,
        effect: "none",
        cause: { source: "backup", code: error.code, detail: null },
        ...context,
      });
    default:
      return assertNever(error, "unhandled backup error");
  }
}

/** A typed record repository refusal. */
export function fromRecordError(error: RecordError, context: ErrorContext = {}): FalrynError {
  switch (error.code) {
    case "storage":
      return fromSqliteStoreError(error.error, context);
    case "malformed-row":
      return build({
        code: "data.record.malformed-row",
        category: "data",
        message: "A stored session record could not be read.",
        retryable: false,
        effect: "none",
        recovery: ["inspect-state"],
        cause: {
          source: "record",
          code: error.code,
          detail: `${error.entity} ${error.issues.map((issue) => `${issue.path || "<root>"}:${issue.code}`).join(",")}`,
        },
        ...context,
      });
    case "not-found":
      return build({
        code: "data.record.not-found",
        category: "data",
        message: "The requested session was not found.",
        retryable: false,
        effect: "none",
        cause: { source: "record", code: error.code, detail: error.identity },
        ...context,
      });
    case "already-exists":
      return build({
        code: "data.record.already-exists",
        category: "data",
        message: "A session with that identity already exists.",
        retryable: false,
        effect: "none",
        cause: { source: "record", code: error.code, detail: error.identity },
        ...context,
      });
    case "invalid-list-limit":
      return build({
        code: "data.record.invalid-list-limit",
        category: "data",
        message: "The session list requested more rows than this build will return.",
        retryable: false,
        effect: "none",
        cause: {
          source: "record",
          code: error.code,
          detail: `requested=${error.requestedLimit} maximum=${error.maximumLimit}`,
        },
        ...context,
      });
    default:
      return assertNever(error, "unhandled record error");
  }
}

/** A session catalog refusal. */
