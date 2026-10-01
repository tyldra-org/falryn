/** Public contracts for this capability. Internal modules import their exact dependencies. */

export {
  admitCommand,
  type CommandAdmission,
  type CommandRefusal,
} from "./command-admission.ts";
export {
  invocationTiming,
  parseSlashCommand,
  resolveCommandArgument,
  type SlashErrorCode,
  type SlashInvocation,
  type SlashParse,
} from "./command-parser.ts";
export {
  argumentHint,
  type CommandReference,
  type CommandReferenceEntry,
  commandReference,
  commandUsage,
  formatCommandReference,
} from "./command-reference.ts";
export {
  type CommandRegistry,
  type CommandRegistryDiagnostic,
  type CommandRegistryDiagnosticCode,
  createCommandRegistry,
  describeCommandRegistryDiagnostics,
  type RegisteredSlashForm,
} from "./command-registry.ts";
export {
  COMMAND_MATCH_TIERS,
  type CommandSearchOptions,
  matchTier,
  searchCommands,
} from "./command-search.ts";
export {
  COMMAND_BEHAVIORS,
  COMMAND_CALLERS,
  COMMAND_EFFECTS,
  COMMAND_REGISTRY_LIMITS,
  COMMAND_REGISTRY_SCHEMA_VERSION,
  COMMAND_TIMINGS,
  type CommandArgument,
  type CommandBehavior,
  type CommandCaller,
  type CommandEffect,
  type CommandOperand,
  type CommandOption,
  type CommandSpec,
  type CommandStatus,
  type CommandTiming,
  NO_ARGUMENT,
  planned,
  SHIPPED,
  type SlashForm,
} from "./command-spec.ts";
