/**
 * The application command-action dispatcher (#948).
 *
 * Slash text, the palette, a headless run and a model caller all reach a
 * registered action through this one path. The registry (#790) resolves the
 * action and normalizes its argument, admission applies the entry's declared
 * callers and timing, and the action's handler runs once. A caller never keeps
 * its own copy of the action: the shell renders the lines, a headless run
 * reports them, and the model route returns them as its tool result.
 *
 * Slash text here is data parsed by the registry grammar. It is never a shell
 * command line and is never placed in the user's composer.
 */

import {
  admitCommand,
  type CommandCaller,
  type CommandEffect,
  type CommandRegistry,
  type CommandSpec,
  type CommandTiming,
  parseSlashCommand,
  resolveCommandArgument,
  type SlashInvocation,
} from "../../domain/commands/index.ts";

/** What a caller names: a canonical action with its argument, or literal slash text. */
export type CommandActionTarget =
  | { readonly kind: "action"; readonly id: string; readonly argument: string | null }
  | { readonly kind: "slash"; readonly text: string };

export type CommandActionRequest = {
  readonly caller: CommandCaller;
  readonly target: CommandActionTarget;
  /** A turn is running or a submission is in flight. A model caller is always mid-turn. */
  readonly turnActive: boolean;
  /** The registry generation the caller resolved against; omitted means the current one. */
  readonly generation?: string;
  readonly signal: AbortSignal;
};

/** The normalized identity every caller of the same action shares. */
export type CommandActionInvocation = {
  readonly commandId: string;
  /** The slash form that matched, or the canonical form for an action-ID call. */
  readonly form: string;
  /** The registry's normalized argument, or null for a bare invocation. */
  readonly argument: string | null;
  readonly timing: CommandTiming;
  readonly effect: CommandEffect;
  readonly caller: CommandCaller;
  readonly generation: string;
};

export const COMMAND_ACTION_REFUSALS = [
  "not-a-command",
  "unknown-action",
  "invalid-argument",
  "stale-generation",
  "command-planned",
  "caller-unsupported",
  "interactive-only",
  "unavailable-while-turn-active",
] as const;

export type CommandActionRefusalCode = (typeof COMMAND_ACTION_REFUSALS)[number];

export type CommandActionOutcome =
  | {
      readonly kind: "completed";
      readonly invocation: CommandActionInvocation;
      readonly lines: readonly string[];
    }
  /** The action ran and reported that its owner is not available in this session. */
  | {
      readonly kind: "unavailable";
      readonly invocation: CommandActionInvocation;
      readonly message: string;
    }
  | {
      readonly kind: "refused";
      readonly code: CommandActionRefusalCode;
      readonly commandId: string | null;
      readonly message: string;
    }
  | { readonly kind: "cancelled"; readonly invocation: CommandActionInvocation }
  | {
      readonly kind: "failed";
      readonly invocation: CommandActionInvocation;
      readonly message: string;
    };

export type CommandActionHandlerResult =
  | { readonly kind: "completed"; readonly lines: readonly string[] }
  | { readonly kind: "unavailable"; readonly message: string };

/** One action's application owner. It receives only the normalized invocation. */
export type CommandActionHandler = (
  invocation: CommandActionInvocation,
  signal: AbortSignal,
) => Promise<CommandActionHandlerResult>;

export type CommandActionHandlers = Readonly<Record<string, CommandActionHandler>>;

/** A bounded, model-facing description of one callable action. */
export type CommandActionCard = {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Every slash spelling, canonical first; each resolves to this one action. */
  readonly forms: readonly string[];
  readonly argument:
    | { readonly kind: "none" }
    | { readonly kind: "options"; readonly hint: string; readonly options: readonly string[] }
    | {
        readonly kind: "text";
        readonly hint: string;
        readonly required: boolean;
        readonly maxBytes: number;
      };
  readonly effect: CommandEffect;
  readonly timing: CommandTiming;
  readonly confirmation: "none" | "focused";
  readonly source: "builtin";
};

export const COMMAND_ACTION_LIMITS = Object.freeze({
  cards: 32,
  descriptionCharacters: 240,
  queryCharacters: 128,
  slashBytes: 66_000,
});

export type CommandActionDispatcher = {
  /** The registry generation; a caller passes it back to bind its request. */
  readonly generation: string;
  /** Resolve without running, for effect classification; never calls a handler. */
  resolve(target: CommandActionTarget): CommandSpec | null;
  /**
   * The effect a request would have: its action's declared effect when the caller
   * would be admitted, otherwise observation, because a refused request runs nothing.
   */
  effect(target: CommandActionTarget, caller: CommandCaller, turnActive: boolean): CommandEffect;
  /** Actions the caller may invoke, matching a query, in registry order. */
  cards(caller: CommandCaller, query?: string): readonly CommandActionCard[];
  invoke(request: CommandActionRequest): Promise<CommandActionOutcome>;
};

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function card(entry: CommandSpec): CommandActionCard {
  const argument = entry.argument;
  return {
    id: entry.id,
    title: entry.title,
    description: bounded(entry.description, COMMAND_ACTION_LIMITS.descriptionCharacters),
    forms: entry.slash.map((slash) =>
      slash.fixedArgument === undefined ? slash.form : `${slash.form} (= ${slash.fixedArgument})`,
    ),
    argument:
      argument.kind === "none"
        ? { kind: "none" }
        : argument.kind === "options"
          ? {
              kind: "options",
              hint: argument.hint,
              options: argument.options.map((option) =>
                option.operand === null ? option.value : `${option.value} <${option.operand.hint}>`,
              ),
            }
          : {
              kind: "text",
              hint: argument.hint,
              required: argument.required,
              maxBytes: argument.maxBytes,
            },
    effect: entry.effect,
    timing: entry.timing,
    confirmation: entry.confirmation,
    source: "builtin",
  };
}

/**
 * Bind one registry generation to its action owners. Every entry that declares a
 * headless or model caller must have a handler: a declared caller without an
 * owner is a defect in the registry, not a runtime condition.
 */
export function createCommandActionDispatcher<T extends CommandSpec>(
  registry: CommandRegistry<T>,
  handlers: CommandActionHandlers,
): CommandActionDispatcher {
  for (const entry of registry.entries) {
    const nonInteractive = entry.callers.some((caller) => caller !== "interactive");
    if (nonInteractive && entry.status.kind === "shipped" && handlers[entry.id] === undefined)
      throw new Error(
        `command action ${entry.id} declares a non-interactive caller without an owner`,
      );
  }

  const parse = (
    target: CommandActionTarget,
  ):
    | SlashInvocation<T>
    | {
        readonly refused: CommandActionRefusalCode;
        readonly entry: T | null;
        readonly message: string;
      } => {
    if (target.kind === "action") {
      const entry = registry.entry(target.id);
      if (entry === undefined)
        return {
          refused: "unknown-action",
          entry: null,
          message: `No registered action has the id ${JSON.stringify(target.id)}.`,
        };
      const resolved = resolveCommandArgument(entry, target.argument);
      return resolved.kind === "invalid"
        ? { refused: "invalid-argument", entry, message: resolved.message }
        : resolved;
    }
    if (new TextEncoder().encode(target.text).byteLength > COMMAND_ACTION_LIMITS.slashBytes)
      return { refused: "invalid-argument", entry: null, message: "The slash text is too large." };
    const parsed = parseSlashCommand(registry, target.text);
    switch (parsed.kind) {
      case "command":
        return parsed;
      case "invalid":
        return { refused: "invalid-argument", entry: parsed.entry, message: parsed.message };
      case "unknown":
        return {
          refused: "unknown-action",
          entry: null,
          message: `/${parsed.name} is not a registered action.`,
        };
      case "not-slash":
        return {
          refused: "not-a-command",
          entry: null,
          message: "Slash text must start with / and name a registered action.",
        };
    }
  };

  return {
    generation: registry.generation,
    resolve(target) {
      const parsed = parse(target);
      return parsed.entry;
    },
    effect(target, caller, turnActive) {
      const parsed = parse(target);
      if ("refused" in parsed || handlers[parsed.entry.id] === undefined) return "observation";
      return admitCommand(parsed.entry, { caller, timing: parsed.timing, turnActive }).ok
        ? parsed.entry.effect
        : "observation";
    },
    cards(caller, query = "") {
      const terms = query
        .slice(0, COMMAND_ACTION_LIMITS.queryCharacters)
        .toLocaleLowerCase()
        .split(/\s+/u)
        .filter((term) => term.length > 0);
      return registry.entries
        .filter((entry) => entry.status.kind === "shipped" && entry.callers.includes(caller))
        .filter((entry) => {
          if (terms.length === 0) return true;
          const text = [
            entry.id,
            entry.title,
            entry.description,
            ...entry.keywords,
            ...entry.slash.map((slash) => slash.form),
          ]
            .join(" ")
            .toLocaleLowerCase();
          return terms.some((term) => text.includes(term));
        })
        .slice(0, COMMAND_ACTION_LIMITS.cards)
        .map(card);
    },
    async invoke(request) {
      if (request.generation !== undefined && request.generation !== registry.generation)
        return {
          kind: "refused",
          code: "stale-generation",
          commandId: null,
          message: "The action registry changed since it was listed; list the actions again.",
        };
      const parsed = parse(request.target);
      if ("refused" in parsed)
        return {
          kind: "refused",
          code: parsed.refused,
          commandId: parsed.entry?.id ?? null,
          message: parsed.message,
        };
      const entry = parsed.entry;
      const admission = admitCommand(entry, {
        caller: request.caller,
        timing: parsed.timing,
        turnActive: request.turnActive,
      });
      if (!admission.ok) {
        const interactiveOnly =
          admission.code === "caller-unsupported" &&
          entry.callers.length === 1 &&
          entry.callers[0] === "interactive";
        return {
          kind: "refused",
          code: interactiveOnly ? "interactive-only" : admission.code,
          commandId: entry.id,
          message: interactiveOnly
            ? `${parsed.form} needs the interactive shell's presenter; it is not run for the ${request.caller} caller.`
            : admission.message,
        };
      }
      const handler = handlers[entry.id];
      const invocation: CommandActionInvocation = {
        commandId: entry.id,
        form: parsed.form,
        argument: parsed.argument,
        timing: parsed.timing,
        effect: entry.effect,
        caller: request.caller,
        generation: registry.generation,
      };
      if (handler === undefined)
        return {
          kind: "refused",
          code: "caller-unsupported",
          commandId: entry.id,
          message: `${parsed.form} has no application owner for the ${request.caller} caller.`,
        };
      if (request.signal.aborted) return { kind: "cancelled", invocation };
      try {
        const result = await handler(invocation, request.signal);
        if (request.signal.aborted) return { kind: "cancelled", invocation };
        return result.kind === "completed"
          ? { kind: "completed", invocation, lines: result.lines }
          : { kind: "unavailable", invocation, message: result.message };
      } catch (error) {
        if (request.signal.aborted) return { kind: "cancelled", invocation };
        return {
          kind: "failed",
          invocation,
          message: error instanceof Error ? error.message : "The action failed.",
        };
      }
    },
  };
}
