/**
 * The one slash-command grammar (#790).
 *
 *     invocation := "/" name { space word } [ space argument ]
 *     argument   := option [ space operand ]     (options)
 *                 | [ "--" space ] text          (text)
 *     text       := quoted | unquoted rest of line
 *
 * Words are separated by any Unicode whitespace and matched case-insensitively
 * against registered forms, longest first. Quoted text uses `"` or `'` around
 * the whole value with `\` escaping the quote or itself; `--` takes the rest
 * literally. Nothing here evaluates shell syntax: an argument is data handed to
 * the action's owner, never a command line.
 */

import type { CommandRegistry, RegisteredSlashForm } from "./command-registry.ts";
import type { CommandOption, CommandSpec, CommandTiming } from "./command-spec.ts";

export type SlashErrorCode =
  | "form-incomplete"
  | "argument-unexpected"
  | "argument-missing"
  | "argument-invalid"
  | "argument-too-large"
  | "quote-unterminated";

export type SlashInvocation<T extends CommandSpec = CommandSpec> = {
  readonly kind: "command";
  readonly entry: T;
  /** The form that matched, as registered. */
  readonly form: string;
  /**
   * The normalized argument: an option word and its operand separated by one
   * space, unquoted text, or `null` for a bare invocation.
   */
  readonly argument: string | null;
  readonly option: CommandOption | null;
  /** When this invocation may take effect during an active turn. */
  readonly timing: CommandTiming;
};

export type SlashParse<T extends CommandSpec = CommandSpec> =
  /** Text that does not start with `/` belongs to its caller. */
  | { readonly kind: "not-slash" }
  /** A slash word no entry claims; the caller's next owner (skills, templates) may. */
  | { readonly kind: "unknown"; readonly name: string }
  | {
      readonly kind: "invalid";
      readonly entry: T | null;
      readonly form: string;
      readonly code: SlashErrorCode;
      readonly message: string;
    }
  | SlashInvocation<T>;

const WORD = /\S+/gu;

/** Resolve slash text against one registry generation. */
export function parseSlashCommand<T extends CommandSpec>(
  registry: CommandRegistry<T>,
  input: string,
): SlashParse<T> {
  const text = input.trim();
  if (!text.startsWith("/")) return { kind: "not-slash" };

  const words = [...text.matchAll(WORD)];
  const lowered = words.map((match) => match[0].toLowerCase());
  const first = lowered[0] ?? "/";

  const matched = registry.forms.find(
    (candidate) =>
      candidate.words.length <= lowered.length &&
      candidate.words.every((word, index) => word === lowered[index]),
  );

  if (matched === undefined) {
    const family = registry.forms
      .filter((candidate) => candidate.words[0] === first && candidate.words.length > 1)
      .sort((a, b) => a.order - b.order);
    if (family.length === 0) return { kind: "unknown", name: first };
    const subforms = unique(family.map((candidate) => candidate.words.slice(1).join(" ")));
    return {
      kind: "invalid",
      entry: null,
      form: first,
      code: "form-incomplete",
      message: `${first} expects ${listOf(subforms, "or")}.`,
    };
  }

  const lastWord = words[matched.words.length - 1];
  const end = lastWord === undefined ? text.length : (lastWord.index ?? 0) + lastWord[0].length;
  const rest = text.slice(end).trim();
  return resolveArgument(registry, matched, rest);
}

/** Timing of an invocation with the given option, or of a bare one. */
export function invocationTiming(
  spec: CommandSpec,
  argument: string | null,
  option: CommandOption | null,
): CommandTiming {
  if (argument === null) return spec.timing;
  if (option !== null) return option.timing ?? spec.timing;
  return spec.argument.kind === "text" ? (spec.argument.timing ?? spec.timing) : spec.timing;
}

/**
 * Validate an argument supplied directly (palette, key, model) against an entry,
 * producing the same normalized argument the slash grammar would.
 */
export function resolveCommandArgument<T extends CommandSpec>(
  entry: T,
  argument: string | null,
): SlashInvocation<T> | Extract<SlashParse<T>, { kind: "invalid" }> {
  const canonical = entry.slash[0]?.form ?? entry.id;
  return resolveAgainst(entry, canonical, null, (argument ?? "").trim(), []);
}

function resolveArgument<T extends CommandSpec>(
  registry: CommandRegistry<T>,
  matched: RegisteredSlashForm<T>,
  rest: string,
): SlashParse<T> {
  // Longer forms that extend the one typed, such as `/model routes` for `/model`.
  const siblings = registry.forms
    .filter(
      (candidate) =>
        candidate.words.length > matched.words.length &&
        matched.words.every((word, index) => candidate.words[index] === word),
    )
    .sort((a, b) => a.order - b.order)
    .map((candidate) => candidate.form);
  return resolveAgainst(matched.entry, matched.form, matched.fixedArgument, rest, siblings);
}

function resolveAgainst<T extends CommandSpec>(
  entry: T,
  form: string,
  fixedArgument: string | null,
  rest: string,
  siblings: readonly string[],
): SlashInvocation<T> | Extract<SlashParse<T>, { kind: "invalid" }> {
  const invalid = (code: SlashErrorCode, message: string) =>
    ({ kind: "invalid", entry, form, code, message }) as const;
  const invocation = (argument: string | null, option: CommandOption | null) =>
    ({
      kind: "command",
      entry,
      form,
      argument,
      option,
      timing: invocationTiming(entry, argument, option),
    }) as const;

  if (fixedArgument !== null) {
    if (rest !== "") return invalid("argument-unexpected", `${form} takes no argument.`);
    const option =
      entry.argument.kind === "options"
        ? (entry.argument.options.find((candidate) => candidate.value === fixedArgument) ?? null)
        : null;
    return invocation(fixedArgument, option);
  }

  const argument = entry.argument;
  switch (argument.kind) {
    case "none": {
      if (rest === "") return invocation(null, null);
      const others = unique(siblings).filter((sibling) => sibling !== form);
      return invalid(
        "argument-unexpected",
        others.length === 0
          ? `${form} takes no argument.`
          : `${form} takes no argument. Use ${listOf(unique([form, ...others]), "or")}.`,
      );
    }
    case "options": {
      if (rest === "") return invocation(null, null);
      const usage = `Use ${form} ${argument.options.map((option) => option.value).join("|")}.`;
      const head = rest.split(/\s+/u)[0] ?? "";
      const option = argument.options.find((candidate) => candidate.value === head.toLowerCase());
      if (option === undefined) {
        return invalid("argument-invalid", `Unsupported value “${head}” for ${form}. ${usage}`);
      }
      const operandText = rest.slice(head.length).trim();
      if (option.operand === null) {
        return operandText === ""
          ? invocation(option.value, option)
          : invalid("argument-unexpected", `${form} ${option.value} takes no value.`);
      }
      if (operandText === "") {
        return option.operand.required
          ? invalid("argument-missing", `${form} ${option.value} needs ${option.operand.hint}.`)
          : invocation(option.value, option);
      }
      const operand = unquote(operandText);
      if (operand.kind === "unterminated") {
        return invalid("quote-unterminated", `${form} ${option.value}: a quote is not closed.`);
      }
      if (operand.kind === "trailing" || /\s/u.test(operand.value) || operand.value === "") {
        return invalid(
          "argument-invalid",
          `${form} ${option.value} takes one ${option.operand.hint}.`,
        );
      }
      return invocation(`${option.value} ${operand.value}`, option);
    }
    case "text": {
      if (rest === "") {
        return argument.required
          ? invalid("argument-missing", `${form} needs ${argument.hint}.`)
          : invocation(null, null);
      }
      // `--` ends option parsing: what follows is taken exactly, quotes included.
      const literal = rest === "--" || /^--\s/u.test(rest);
      const value: Unquoted = literal
        ? { kind: "value", value: rest.slice(2).trim() }
        : unquote(rest);
      if (value.kind === "unterminated") {
        return invalid("quote-unterminated", `${form}: a quote is not closed.`);
      }
      if (value.kind === "trailing") {
        return invalid("argument-invalid", `${form}: quote the whole value or none of it.`);
      }
      const text = value.value;
      if (text === "") {
        return argument.required
          ? invalid("argument-missing", `${form} needs ${argument.hint}.`)
          : invocation(null, null);
      }
      if (Buffer.byteLength(text, "utf8") > argument.maxBytes) {
        return invalid(
          "argument-too-large",
          `${form} accepts at most ${formatBytes(argument.maxBytes)}.`,
        );
      }
      return invocation(text, null);
    }
    default: {
      const unknown: never = argument;
      return invalid("argument-invalid", `${form} has an unknown argument ${String(unknown)}.`);
    }
  }
}

type Unquoted =
  | { readonly kind: "value"; readonly value: string }
  | { readonly kind: "unterminated" }
  | { readonly kind: "trailing" };

/** Unquote a value wrapped whole in `"` or `'`; anything else is taken as written. */
function unquote(raw: string): Unquoted {
  const quote = raw[0];
  if (quote !== '"' && quote !== "'") return { kind: "value", value: raw };
  let value = "";
  for (let index = 1; index < raw.length; index += 1) {
    const character = raw[index];
    if (character === "\\" && (raw[index + 1] === quote || raw[index + 1] === "\\")) {
      value += raw[index + 1];
      index += 1;
      continue;
    }
    if (character === quote) {
      return raw.slice(index + 1).trim() === "" ? { kind: "value", value } : { kind: "trailing" };
    }
    value += character;
  }
  return { kind: "unterminated" };
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function listOf(values: readonly string[], conjunction: "and" | "or"): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} ${conjunction} ${values.at(-1)}`;
}

function formatBytes(bytes: number): string {
  return bytes % 1024 === 0 ? `${bytes / 1024} KiB` : `${bytes} bytes`;
}
