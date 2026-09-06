/** Public contracts for this capability. Internal modules import their exact dependencies. */

export type { DiagnosticsCollector, EmitOutcome, EmitRequest } from "./diagnostics-collector.ts";
export { createDiagnosticsCollector, DIAGNOSTICS_OWNERSHIP } from "./diagnostics-collector.ts";
export type { ErrorContext } from "./error-translation.ts";
export {
  adoptForeignError,
  aggregate,
  fromArtifactCatalogError,
  fromArtifactError,
  fromArtifactReadError,
  fromBackupError,
  fromCodecError,
  fromConfigurationIssue,
  fromConfigurationIssues,
  fromCredentialFailure,
  fromEventStoreError,
  fromExportError,
  fromIdentityError,
  fromImportError,
  fromParticipantReports,
  fromRecordError,
  fromRemovalRefusal,
  fromRendererFailure,
  fromSequenceError,
  fromSessionCatalogError,
  fromSessionIsolationError,
  fromSqliteStoreError,
  fromTimestampError,
  fromUnknown,
  fromUnreadConfigurationSource,
  fromUnreadConfigurationSources,
  withContext,
} from "./error-translation.ts";
export type { DebugWindow, DebugWindowOptions } from "./redaction.ts";
export {
  containsRedactableSecret,
  createRuntimeRedactor,
  isSecretName,
  openDebugWindow,
  REDACTED,
  redactMetadata,
  redactText,
} from "./redaction.ts";
