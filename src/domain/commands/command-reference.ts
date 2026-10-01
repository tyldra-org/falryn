/**
 * The generated command reference (#790).
 *
 * Help, `falryn commands` and the published reference read this projection of
 * one registry generation. It names no renderer type, so a headless caller can
 * produce it without loading the terminal UI.
 */

import type { CommandRegistry } from "./command-registry.ts";
import {
  COMMAND_REGISTRY_SCHEMA_VERSION,
  type CommandArgument,
  type CommandBehavior,
  type CommandCaller,
  type CommandEffect,
  type CommandSpec,
  type CommandStatus,
  type CommandTiming,
} from "./command-spec.ts";

export type CommandReferenceEntry = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Canonical usage first, then each alias as typed. */
  readonly usage: readonly string[];
  readonly argument: CommandArgument;
  readonly timing: CommandTiming;
  /** Distinct timings an argument can carry, when they differ from `timing`. */
  readonly argumentTimings: readonly CommandTiming[];
  readonly effect: CommandEffect;
  readonly confirmation: "none" | "focused";
  readonly behavior: CommandBehavior;
  readonly callers: readonly CommandCaller[];
  readonly status: CommandStatus;
  /** Default key, when the host binds one. */
  readonly binding: string | null;
};

export type CommandReference = {
  readonly schemaVersion: typeof COMMAND_REGISTRY_SCHEMA_VERSION;
  readonly generation: string;
  readonly commands: readonly CommandReferenceEntry[];
};

export function commandReference<T extends CommandSpec>(
  registry: CommandRegistry<T>,
  binding: (entry: T) => string | null = () => null,
): CommandReference {
  return {
    schemaVersion: COMMAND_REGISTRY_SCHEMA_VERSION,
    generation: registry.generation,
    commands: registry.entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      description: entry.description,
      usage: commandUsage(entry),
      argument: entry.argument,
      timing: entry.timing,
      argumentTimings: argumentTimings(entry),
      effect: entry.effect,
      confirmation: entry.confirmation,
      behavior: entry.behavior,
      callers: entry.callers,
      status: entry.status,
      binding: binding(entry),
    })),
  };
}

/** How each slash form is typed: the canonical form with its argument, then aliases. */
export function commandUsage(spec: CommandSpec): readonly string[] {
  return spec.slash.map((slash, index) =>
    index === 0 && slash.fixedArgument === undefined
      ? withArgument(slash.form, spec.argument)
      : slash.form,
  );
}

/** A short hint for the argument, such as `[ask|plan|debug|agent]`, or `""`. */
export function argumentHint(argument: CommandArgument): string {
  switch (argument.kind) {
    case "none":
      return "";
    case "options":
      return `[${argument.options
        .map((option) =>
          option.operand === null
            ? option.value
            : `${option.value} ${option.operand.required ? `<${option.operand.hint}>` : `[${option.operand.hint}]`}`,
        )
        .join("|")}]`;
    case "text":
      return argument.required ? `<${argument.hint}>` : `[${argument.hint}]`;
    default: {
      const unknown: never = argument;
      return String(unknown);
    }
  }
}

/** Plain text, one block per command, for headless help and terminals without the shell. */
export function formatCommandReference(reference: CommandReference): readonly string[] {
  const lines: string[] = [
    `Falryn shell commands (registry ${reference.generation}, ${reference.commands.length} entries)`,
  ];
  for (const command of reference.commands) {
    lines.push("", `${command.title} (${command.id})`);
    if (command.usage.length > 0) {
      const [canonical, ...aliases] = command.usage;
      lines.push(`  ${canonical}${aliases.length === 0 ? "" : `; also ${aliases.join(", ")}`}`);
    }
    lines.push(`  ${command.description}`);
    const facts = [
      command.binding === null ? null : `key ${command.binding}`,
      `timing ${[command.timing, ...command.argumentTimings.map((t) => `${t} with an argument`)].join(", ")}`,
      `effect ${command.effect}`,
      command.confirmation === "focused" ? "asks for confirmation" : null,
      command.behavior === "insert" ? "inserts into the draft" : null,
    ].filter((fact): fact is string => fact !== null);
    lines.push(`  ${facts.join(" · ")}`);
    if (command.status.kind === "planned") {
      lines.push(`  Not available yet: ${command.status.reason} (${command.status.owner})`);
    }
  }
  return lines;
}

function withArgument(form: string, argument: CommandArgument): string {
  const hint = argumentHint(argument);
  return hint === "" ? form : `${form} ${hint}`;
}

function argumentTimings(spec: CommandSpec): readonly CommandTiming[] {
  const argument = spec.argument;
  let timings: readonly CommandTiming[] = [];
  if (argument.kind === "options") {
    timings = argument.options.map((option) => option.timing ?? spec.timing);
  } else if (argument.kind === "text") {
    timings = [argument.timing ?? spec.timing];
  }
  return [...new Set(timings)].filter((timing) => timing !== spec.timing);
}
