import { APPLICATION_COMMANDS } from "./application.ts";
import { COMPOSER_COMMANDS } from "./composer.ts";
import {
  type BindingConflict,
  type CommandContext,
  RESERVED_COMMANDS,
  type ShellCommand,
} from "./contracts.ts";
import { NAVIGATION_COMMANDS } from "./navigation.ts";
import { TRANSCRIPT_COMMANDS } from "./transcript.ts";

/** Ordered registry used by help, palette search, and keymap planning. */
export const SHELL_COMMANDS: readonly ShellCommand[] = [
  ...APPLICATION_COMMANDS,
  ...TRANSCRIPT_COMMANDS,
  ...COMPOSER_COMMANDS,
  ...NAVIGATION_COMMANDS,
];

export function commandById(id: string): ShellCommand | undefined {
  return SHELL_COMMANDS.find((command) => command.id === id);
}

export function searchCommands(query: string): readonly ShellCommand[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return SHELL_COMMANDS;
  }
  return SHELL_COMMANDS.filter((command) =>
    [command.id, command.title, command.description, ...command.keywords].some((field) =>
      field.toLowerCase().includes(needle),
    ),
  );
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
