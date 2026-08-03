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
  RunCommandResult,
} from "./commands.ts";
export { runConfigPath, runConfigShow, runConfigValidate, runDoctor } from "./commands.ts";
export type { DispatchOptions } from "./dispatch.ts";
export { dispatch } from "./dispatch.ts";
export type { ExitCode, ExitResolution } from "./exit.ts";
export {
  DECLARED_EXIT_CODES,
  EMITTABLE_EXIT_CODES,
  EXIT_CODES,
  exitCodeForError,
  resolveExitCode,
  SHELL_RESERVED_EXIT_CODES,
  UNEMITTABLE_EXIT_CODES,
} from "./exit.ts";
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
export type { HumanRenderRequest, RenderedText } from "./render-human.ts";
export {
  DEFAULT_DISPLAY_COLUMNS,
  MIN_DISPLAY_COLUMNS,
  renderHuman,
  renderPlainText,
  renderQuiet,
} from "./render-human.ts";
export type {
  CommandEffect,
  CommandId,
  CommandOmission,
  CommandResult,
  CommandResultOf,
  CommandTruncation,
  CommandWarning,
} from "./result.ts";
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
} from "./result.ts";
export type { HostServiceOptions, ServiceProvider, Services } from "./services.ts";
export { createServiceProvider } from "./services.ts";
export type {
  CliStreams,
  CliStreamsParts,
  HostCliStreamsOptions,
  RecordedCliStreams,
  RecordingCliStreamsOptions,
  StreamsFlushReport,
} from "./streams.ts";
export {
  createCliStreams,
  createHostCliStreams,
  createRecordingCliStreams,
  DETACHED_CAPABILITIES,
  outcomeAfterFlush,
  writeDiagnosticLine,
  writeResultLine,
} from "./streams.ts";
export type { BuildIdentity, RunMode } from "./version.ts";
export { buildIdentity, FALRYN_VERSION, RUN_MODES, runModeFor, versionText } from "./version.ts";
