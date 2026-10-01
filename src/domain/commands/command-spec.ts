/**
 * The command registry entry contract (#790).
 *
 * One entry names one application action: its stable identity, the slash forms
 * that spell it, the argument it accepts, when it may take effect during an
 * active turn, and who may call it. Slash text, the palette, key bindings, help
 * and the generated reference all read these entries; none keeps its own list.
 *
 * Pure data. Presentation hosts add their own fields (key context, binding,
 * live availability) beside these rather than redefining them.
 */

export const COMMAND_REGISTRY_SCHEMA_VERSION = 1 as const;

/**
 * When an invocation may take effect while a turn is active.
 *
 * `immediate` inspects or navigates without waiting. `safe-point` changes state
 * the active turn must not observe halfway. `queued` starts work that runs after
 * the current turn settles. Until the mid-turn owner (#954) wires its boundary
 * and queue, the last two are refused during a turn rather than run early.
 */
export const COMMAND_TIMINGS = ["immediate", "safe-point", "queued"] as const;
export type CommandTiming = (typeof COMMAND_TIMINGS)[number];

/** Effect classes, as the tool pipeline names them. */
export const COMMAND_EFFECTS = ["observation", "interactive", "mutation", "external"] as const;
export type CommandEffect = (typeof COMMAND_EFFECTS)[number];

/** Who may invoke an entry. A caller outside this list receives a typed refusal. */
export const COMMAND_CALLERS = ["interactive", "headless", "model"] as const;
export type CommandCaller = (typeof COMMAND_CALLERS)[number];

/** Whether a selection runs the action or only places its text in the draft. */
export const COMMAND_BEHAVIORS = ["execute", "insert"] as const;
export type CommandBehavior = (typeof COMMAND_BEHAVIORS)[number];

/** A value that follows an option word, such as the id in `/profile use <id>`. */
export type CommandOperand = {
  readonly hint: string;
  readonly required: boolean;
};

export type CommandOption = {
  /** Lowercase word the user types. */
  readonly value: string;
  readonly operand: CommandOperand | null;
  /** Overrides the entry's argument timing for this option. */
  readonly timing?: CommandTiming;
};

export type CommandArgument =
  | { readonly kind: "none" }
  | {
      /** The first word picks one declared option; an option may take one operand. */
      readonly kind: "options";
      readonly hint: string;
      readonly options: readonly CommandOption[];
    }
  | {
      /** The rest of the line, unquoted, bounded in UTF-8 bytes. */
      readonly kind: "text";
      readonly hint: string;
      readonly maxBytes: number;
      readonly required: boolean;
      /** Timing of an invocation that carries text; the entry timing covers a bare one. */
      readonly timing?: CommandTiming;
    };

/**
 * A slash spelling. The first form of an entry is canonical; the others are
 * aliases. A fixed argument makes a direct alias such as `/plan` mean
 * `/mode plan`.
 */
export type SlashForm = {
  readonly form: string;
  readonly fixedArgument?: string;
};

export type CommandStatus =
  | { readonly kind: "shipped" }
  /** Discoverable, never executable, until its owning issue delivers the action. */
  | { readonly kind: "planned"; readonly owner: string; readonly reason: string };

export type CommandSpec = {
  /** Stable action identity, such as `mode.select`. */
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly keywords: readonly string[];
  readonly slash: readonly SlashForm[];
  readonly argument: CommandArgument;
  /** Timing of a bare invocation, and of an argument unless the argument declares its own. */
  readonly timing: CommandTiming;
  readonly effect: CommandEffect;
  /** `focused` actions ask through their owner's confirmation before any effect. */
  readonly confirmation: "none" | "focused";
  readonly behavior: CommandBehavior;
  readonly callers: readonly CommandCaller[];
  readonly status: CommandStatus;
};

/** Bounds that keep every projection of the registry small. */
export const COMMAND_REGISTRY_LIMITS = Object.freeze({
  entries: 512,
  formsPerEntry: 16,
  optionsPerEntry: 32,
  titleCharacters: 80,
  descriptionCharacters: 400,
  hintCharacters: 80,
  /** Largest text argument any entry may declare. */
  textArgumentBytes: 65_536,
  /** Rows one search returns. */
  searchResults: 50,
  /** Characters of a search query that are considered. */
  queryCharacters: 128,
});

/** Shorthand for a shipped entry. */
export const SHIPPED: CommandStatus = { kind: "shipped" };

/** Shorthand for an entry its owning issue has not delivered yet. */
export function planned(owner: string, reason: string): CommandStatus {
  return { kind: "planned", owner, reason };
}

export const NO_ARGUMENT: CommandArgument = { kind: "none" };
