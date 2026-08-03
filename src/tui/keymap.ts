/**
 * The keymap: bindings built from the registry, checked before they are used.
 *
 * `@opentui/keymap` owns key normalization, layer resolution, sequences, and
 * dispatch. This module owns three things it does not: that a binding comes from
 * a registered command rather than a string somewhere in a view, that conflicts
 * are refused rather than resolved by registration order, and that the two
 * commands which are the only way out of a full-screen interface cannot be
 * dropped.
 *
 * The check runs at construction and returns its verdict rather than throwing.
 * A shell whose keymap is invalid is a defect worth reporting, and a throw
 * during a React render is a defect that takes the renderer down with it — which
 * would leave the user in raw mode, which is the failure the reserved commands
 * exist to prevent.
 *
 * Layers are derived from `CONTEXT_PRIORITY` rather than declared per binding,
 * so "more specific wins" is a property of the context a command is in and not
 * something each binding restates.
 */

import {
  type BindingConflict,
  bindingConflicts,
  CONTEXT_PRIORITY,
  type CommandContext,
  type CommandState,
  missingReservedCommands,
  SHELL_COMMANDS,
  type ShellCommand,
} from "./commands.ts";
import type { CommandEntry } from "./view-model.ts";

/** A binding ready to hand to the keymap: one key, one command id, one layer. */
export type PreparedBinding = {
  readonly key: string;
  readonly command: string;
  readonly context: CommandContext;
  readonly priority: number;
};

export type KeymapPlan = {
  readonly bindings: readonly PreparedBinding[];
  /** Commands with no default key. Reachable from the palette, listed in help. */
  readonly unbound: readonly string[];
};

export type KeymapRefusal =
  | { readonly kind: "conflict"; readonly conflicts: readonly BindingConflict[] }
  | { readonly kind: "reserved-removed"; readonly commands: readonly string[] };

export type KeymapVerdict =
  | { readonly ok: true; readonly plan: KeymapPlan }
  | { readonly ok: false; readonly refusals: readonly KeymapRefusal[] };

/**
 * Turns a command set into bindings, or says why it will not.
 *
 * Both refusals are reported together rather than the first one found. A set
 * that has a conflict *and* dropped a reserved command has two problems, and
 * fixing them one round-trip at a time is how a validation message becomes
 * something people stop reading.
 */
export function planKeymap(commands: readonly ShellCommand[] = SHELL_COMMANDS): KeymapVerdict {
  const refusals: KeymapRefusal[] = [];

  const conflicts = bindingConflicts(commands);
  if (conflicts.length > 0) {
    refusals.push({ kind: "conflict", conflicts });
  }

  const missing = missingReservedCommands(commands);
  if (missing.length > 0) {
    refusals.push({ kind: "reserved-removed", commands: missing });
  }

  if (refusals.length > 0) {
    return { ok: false, refusals };
  }

  const bindings: PreparedBinding[] = [];
  const unbound: string[] = [];
  for (const command of commands) {
    if (command.defaultBinding === null) {
      unbound.push(command.id);
      continue;
    }
    bindings.push({
      key: command.defaultBinding,
      command: command.id,
      context: command.context,
      priority: CONTEXT_PRIORITY[command.context],
    });
  }

  return { ok: true, plan: { bindings, unbound } };
}

/**
 * One sentence naming what is wrong.
 *
 * Both command IDs for a conflict, because "there is a conflict on escape" tells
 * whoever reads it nothing about which two things to look at.
 */
export function describeRefusal(refusal: KeymapRefusal): string {
  if (refusal.kind === "reserved-removed") {
    return `these commands may not be unbound: ${refusal.commands.join(", ")}`;
  }
  return refusal.conflicts
    .map(
      (conflict) =>
        `${conflict.binding} is bound twice in ${conflict.context}: ${conflict.commands.join(" and ")}`,
    )
    .join("; ");
}

/**
 * The bindings that belong to one layer.
 *
 * Grouped rather than filtered at the call site so a caller registering layers
 * cannot accidentally put a composer binding in the global one — which would
 * make it win everywhere and be almost impossible to notice.
 */
export function bindingsForContext(
  plan: KeymapPlan,
  context: CommandContext,
): readonly PreparedBinding[] {
  return plan.bindings.filter((binding) => binding.context === context);
}

/**
 * Whether a context's bindings should be live right now.
 *
 * Separate from availability. A context is active when its *surface* exists —
 * an overlay is open, a composer is mounted — and a command inside it may still
 * be unavailable for its own reasons. Collapsing the two would make a key in an
 * inactive context fall through to a broader layer, which is how `escape` in a
 * composer would quietly exit the shell.
 */
export function isContextActive(context: CommandContext, state: CommandState): boolean {
  switch (context) {
    case "global":
      return true;
    case "overlay":
      return state.overlayOpen;
    case "scrollable":
      return state.hasScrollableContent;
    case "transcript":
      return state.hasTranscript;
    case "composer":
      return state.hasComposer;
    case "confirmation":
      return state.hasConfirmation;
  }
}

/**
 * The command a key runs, given what is active.
 *
 * The resolution `@opentui/keymap` performs, expressed here so it can be tested
 * without a host and so the help overlay can answer "what does this key do right
 * now" from the same rule the dispatcher uses. Highest priority active context
 * wins; an inactive context is not consulted at all.
 */
export function resolveBinding(
  plan: KeymapPlan,
  key: string,
  state: CommandState,
): PreparedBinding | null {
  let best: PreparedBinding | null = null;
  for (const binding of plan.bindings) {
    if (binding.key !== key || !isContextActive(binding.context, state)) {
      continue;
    }
    if (best === null || binding.priority > best.priority) {
      best = binding;
    }
  }
  return best;
}

/** Every key that currently resolves to something, for help and the status line. */
export function activeBindings(plan: KeymapPlan, state: CommandState): readonly PreparedBinding[] {
  const keys = new Set(plan.bindings.map((binding) => binding.key));
  const active: PreparedBinding[] = [];
  for (const key of keys) {
    const resolved = resolveBinding(plan, key, state);
    if (resolved !== null) {
      active.push(resolved);
    }
  }
  return active.sort((left, right) => left.command.localeCompare(right.command));
}

/**
 * Every command as a row for help and the palette.
 *
 * Derived from the registry and the plan rather than maintained beside them, so
 * a command cannot be listed with a key it does not have or omitted because
 * somebody forgot a table. The binding shown is the one that would run *now* —
 * resolved through the active contexts — which is why help can answer "what does
 * this key do here" rather than "what is this key usually".
 */
export function commandRows(
  plan: KeymapPlan,
  state: CommandState,
  commands: readonly ShellCommand[] = SHELL_COMMANDS,
): readonly CommandEntry[] {
  return commands.map((command) => {
    const availability = command.availability(state);
    const bound =
      command.defaultBinding === null
        ? null
        : resolveBinding(plan, command.defaultBinding, state)?.command === command.id
          ? command.defaultBinding
          : null;
    return {
      id: command.id,
      title: command.title,
      description: command.description,
      // `null` when the command has no default *and* when its key currently
      // resolves to something else — a shadowed binding is not this command's
      // binding, and showing it would tell the user to press a key that does
      // something different.
      binding: bound,
      unavailableReason: availability.kind === "unavailable" ? availability.reason : null,
    };
  });
}
