/**
 * The CLI area's public entrypoint.
 *
 * It owns the process boundary: the numeric exit table, and which handle
 * carries what. It depends on `src/domain`, `src/application`, and
 * `src/integrations`, and nothing depends on it except the composition root and
 * the command surface built on top of it.
 *
 * It owns no command, no option, and no output format. Parsing is #17's and
 * rendering is #18's and #19's; this area moves bytes and picks a number.
 */

export type { Invocation, RunnableCommand } from "./command-tree.ts";
export { helpText, parseInvocation, SCRIPT_NAME } from "./command-tree.ts";
export type {
  ConfigPathPayload,
  ConfigShowPayload,
  ConfigValidatePayload,
  DoctorPayload,
  ExportCommandPayload,
  RunCommandResult,
  SessionListPayload,
  SessionShowPayload,
  WorkspaceListPayload,
  WorkspaceSavePayload,
  WorkspaceSetPayload,
} from "./commands.ts";
export {
  runConfigPath,
  runConfigShow,
  runConfigValidate,
  runDoctor,
  runExport,
  runSessionList,
  runSessionShow,
  runWorkspaceList,
  runWorkspaceLoad,
  runWorkspaceSave,
  runWorkspaceShow,
  stoppedResult,
} from "./commands.ts";
export type { DispatchOptions } from "./dispatch.ts";
export { dispatch } from "./dispatch.ts";
export type { ColorChoice, GlobalOptions, OutputFormat } from "./options.ts";
export {
  allowsColor,
  COLOR_CHOICES,
  configurationOverridesFor,
  DIAGNOSTIC_LEVEL_KEY,
  MAX_TIMEOUT_MS,
  OUTPUT_FORMATS,
  resolveColor,
} from "./options.ts";
export type { ExitCode, ExitResolution } from "./output/exit.ts";
export {
  DECLARED_EXIT_CODES,
  EMITTABLE_EXIT_CODES,
  EXIT_CODES,
  exitCodeForError,
  resolveExitCode,
  SHELL_RESERVED_EXIT_CODES,
  UNEMITTABLE_EXIT_CODES,
} from "./output/exit.ts";
export { createOverBoundArtifactWriter } from "./output/refusal-artifact.ts";
export type { HumanRenderRequest, RenderedText } from "./output/render-human.ts";
export {
  DEFAULT_DISPLAY_COLUMNS,
  MIN_DISPLAY_COLUMNS,
  renderHuman,
  renderPlainText,
  renderQuiet,
} from "./output/render-human.ts";
export type {
  MachineRenderRequest,
  OverBoundArtifactWriter,
  RenderedRecords,
} from "./output/render-json.ts";
export { renderJson } from "./output/render-json.ts";
export type { JsonlRenderRequest } from "./output/render-jsonl.ts";
export { renderJsonl } from "./output/render-jsonl.ts";
export type {
  CommandEffect,
  CommandId,
  CommandOmission,
  CommandResult,
  CommandResultOf,
  CommandTruncation,
  CommandWarning,
} from "./output/result.ts";
export {
  COMMAND_IDS,
  COMMAND_RESULT_SCHEMA_FAMILY,
  COMMAND_RESULT_SCHEMA_VERSION,
  isCommandId,
  isComplete,
  MAX_NOTICE_LENGTH,
  MAX_WARNINGS,
  READ_ONLY_EFFECT,
  succeeded,
} from "./output/result.ts";
export type {
  CliArtifactErrorCode,
  CliArtifactHandle,
  CliEncodeError,
  CliEncodeErrorCode,
  CliEncodeResult,
  CliEventRecord,
  CliReadRefusal,
  CliReadVerdict,
  CliRecord,
  CliRecordEnvelope,
  CliRecordKind,
  CliRefusalArtifact,
  CliRefusalRecord,
  CliResultBody,
  CliResultRecord,
  CliStreamReading,
} from "./output/schema.ts";
export {
  CLI_ARTIFACT_ERROR_CODES,
  CLI_ENCODE_ERROR_CODES,
  CLI_MINIMUM_SCHEMA_VERSION,
  CLI_RECORD_KINDS,
  CLI_SCHEMA_FAMILY,
  CLI_SCHEMA_VERSION,
  cliEventRecord,
  cliRefusalRecord,
  cliResultRecord,
  encodeCliRecord,
  isTerminalCliRecordKind,
  MAX_CLI_RECORD_BYTES,
  readCliRecord,
  readCliStream,
  TERMINAL_CLI_RECORD_KINDS,
} from "./output/schema.ts";
export type {
  CliStreams,
  CliStreamsParts,
  HostCliStreamsOptions,
  RecordedCliStreams,
  RecordingCliStreamsOptions,
  StreamsFlushReport,
} from "./output/streams.ts";
export {
  createCliStreams,
  createHostCliStreams,
  createRecordingCliStreams,
  DETACHED_CAPABILITIES,
  outcomeAfterFlush,
  writeDiagnosticLine,
  writeResultLine,
} from "./output/streams.ts";
export type {
  GovernedRun,
  HostGovernance,
  InvocationGovernance,
} from "./runtime/invocation-scope.ts";
export {
  createHostGovernance,
  createInvocationGovernance,
  openInvocationScope,
  runUnderScope,
  untilScopeStops,
} from "./runtime/invocation-scope.ts";
export type {
  MidTurnClassifyArguments,
  MidTurnClassifyPayload,
  MidTurnClassifyResult,
} from "./runtime/mid-turn.ts";
export {
  classifyAndRenderJsonl,
  createHeadlessMidTurnService,
  MID_TURN_CLASSIFY_COMMAND,
  projectMidTurnEventsToJsonl,
  resolveMidTurnIntent,
  runMidTurnClassify,
} from "./runtime/mid-turn.ts";
export { composeProductCredentials } from "./runtime/product-credentials.ts";
export type {
  ProductProviderConnectionHandoff,
  ProductProviderConnectionOptions,
  ProductProviderConnections,
} from "./runtime/product-provider-connections.ts";
export { composeProductProviderConnections } from "./runtime/product-provider-connections.ts";
export {
  DEFAULT_PROVIDER_CONNECTION_STATE,
  PROVIDER_CONNECTION_KEYS,
  PROVIDER_CONNECTIONS_CONFIGURATION_KEY,
} from "./runtime/provider-configuration.ts";
export type { HostServiceOptions, ServiceProvider, Services } from "./runtime/services.ts";
export { CLI_EVENT_STREAM, createServiceProvider } from "./runtime/services.ts";
export type { BuildIdentity, RunMode } from "./version.ts";
export { buildIdentity, FALRYN_VERSION, RUN_MODES, runModeFor, versionText } from "./version.ts";
