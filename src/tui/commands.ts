/**
 * Stable public command-registry boundary.
 *
 * Command contracts, command families, and registry operations live in focused
 * modules under commands/. Callers keep importing this facade.
 */

export {
  AVAILABLE,
  type BindingConflict,
  COMMAND_CONTEXTS,
  CONTEXT_PRIORITY,
  type CommandAvailability,
  type CommandContext,
  type CommandState,
  EMPTY_COMMAND_STATE,
  RESERVED_COMMANDS,
  type ShellCommand,
} from "./commands/contracts.ts";
export {
  bindingConflicts,
  commandById,
  missingReservedCommands,
  SHELL_COMMANDS,
  searchCommands,
} from "./commands/registry.ts";
