import {
  type CommandRegistry,
  createCommandRegistry,
  describeCommandRegistryDiagnostics,
  searchCommands as searchRegistry,
} from "../../domain/commands/index.ts";
import { APPLICATION_COMMANDS } from "./application.ts";
import { COMPOSER_COMMANDS } from "./composer.ts";
import {
  type BindingConflict,
  type CommandContext,
  RESERVED_COMMANDS,
  type ShellCommand,
} from "./contracts.ts";
import { NAVIGATION_COMMANDS } from "./navigation.ts";
import { PLANNED_COMMANDS } from "./planned.ts";
import { TRANSCRIPT_COMMANDS } from "./transcript.ts";

/** Ordered registry used by help, palette search, slash text, and keymap planning. */
export const SHELL_COMMANDS: readonly ShellCommand[] = [
  ...APPLICATION_COMMANDS,
  ...TRANSCRIPT_COMMANDS,
  ...COMPOSER_COMMANDS,
  ...NAVIGATION_COMMANDS,
  ...PLANNED_COMMANDS,
];

/**
 * The built-in registry generation (#790).
 *
 * Built once, at load. A built-in entry that fails validation is a defect in
 * this tree, not a runtime condition, so it stops the program with every
 * diagnostic rather than shipping a command surface that drifts from its rules.
 */
export const SHELL_REGISTRY: CommandRegistry<ShellCommand> = buildShellRegistry(SHELL_COMMANDS);

export function buildShellRegistry(
  commands: readonly ShellCommand[],
): CommandRegistry<ShellCommand> {
  const built = createCommandRegistry(commands);
  if (!built.ok) {
    throw new Error(
      `The built-in command registry is invalid:\n${describeCommandRegistryDiagnostics(built.error)}`,
    );
  }
  return built.value;
}

export function commandById(id: string): ShellCommand | undefined {
  return SHELL_REGISTRY.entry(id);
}

/** Commands matching a palette query, best match first (see the domain ranking). */
export function searchCommands(query: string): readonly ShellCommand[] {
  return searchRegistry(SHELL_REGISTRY, query);
}

export function bindingConflicts(
  commands: readonly ShellCommand[] = SHELL_COMMANDS,
): readonly BindingConflict[] {
  const seen = new Map<CommandContext, Map<string, string[]>>();
  for (const command of commands) {
    if (command.defaultBinding === null) {
      continue;
    }
    const inContext = seen.get(command.context) ?? new Map<string, string[]>();
    inContext.set(command.defaultBinding, [
      ...(inContext.get(command.defaultBinding) ?? []),
      command.id,
    ]);
    seen.set(command.context, inContext);
  }

  const conflicts: BindingConflict[] = [];
  for (const [context, bindings] of seen) {
    for (const [binding, ids] of bindings) {
      if (ids.length >= 2) {
        conflicts.push({ context, binding, commands: [...ids].sort() });
      }
    }
  }
  return conflicts;
}

export function missingReservedCommands(
  commands: readonly ShellCommand[] = SHELL_COMMANDS,
): readonly string[] {
  return RESERVED_COMMANDS.filter(
    (id) => !commands.some((command) => command.id === id && command.defaultBinding !== null),
  );
}
