/**
 * Stable application facade for translating boundary failures.
 *
 * Each boundary family owns its mapping while shared construction keeps codes,
 * correlation, recovery, redaction, and related-error bounds consistent.
 */

export {
  fromArtifactCatalogError,
  fromArtifactError,
  fromArtifactReadError,
  fromRemovalRefusal,
  fromSessionCatalogError,
  fromSessionIsolationError,
} from "./error-translation/catalog.ts";
export {
  fromConfigurationIssue,
  fromConfigurationIssues,
  fromCredentialFailure,
  fromUnreadConfigurationSource,
  fromUnreadConfigurationSources,
} from "./error-translation/configuration.ts";
export {
  fromCodecError,
  fromEventStoreError,
  fromIdentityError,
  fromSequenceError,
  fromTimestampError,
} from "./error-translation/core.ts";
export {
  adoptForeignError,
  aggregate,
  type ErrorContext,
  withContext,
} from "./error-translation/shared.ts";
export {
  fromRendererFailure,
  fromSqliteStoreError,
} from "./error-translation/storage.ts";
export {
  fromBackupError,
  fromExportError,
  fromImportError,
  fromRecordError,
} from "./error-translation/transfer.ts";
export {
  fromParticipantReports,
  fromUnknown,
} from "./error-translation/unknown.ts";
