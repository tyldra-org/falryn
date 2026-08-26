/** Conservative shell command segmentation for Hush classification. */

export const HUSH_SHELL_OPERATORS = [
  "pipe",
  "stderr-pipe",
  "and",
  "or",
  "sequence",
  "background",
] as const;

export type HushShellOperator = (typeof HUSH_SHELL_OPERATORS)[number];

export type ParsedShellCommand = {
  readonly commands: readonly (readonly string[])[];
  readonly operators: readonly HushShellOperator[];
  readonly opaque: boolean;
};

export function parseShellCommand(source: string): ParsedShellCommand {
  const commands: string[][] = [];
  const operators: HushShellOperator[] = [];
  let tokens: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let opaque = false;
  let index = 0;

  const pushToken = (): void => {
    if (current.length > 0) {
      tokens.push(current);
      current = "";
    }
  };
  const pushCommand = (): boolean => {
    pushToken();
    if (tokens.length === 0) {
      return false;
    }
    commands.push(tokens);
    tokens = [];
    return true;
  };
  const pushOperator = (operator: HushShellOperator, width: number): void => {
    if (!pushCommand()) {
      opaque = true;
    } else {
      operators.push(operator);
    }
    index += width;
  };

  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1];

    if (character === "\\" && quote !== "single") {
      if (next === "\n" || next === "\r") {
        index += next === "\r" && source[index + 2] === "\n" ? 3 : 2;
        continue;
      }
      if (next !== undefined) {
        current += next;
        index += 2;
        continue;
      }
      opaque = true;
      index += 1;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
      index += 1;
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
      index += 1;
      continue;
    }
    if (quote !== null) {
      current += character;
      index += 1;
      continue;
    }

    if ((character === "$" && next === "(") || character === "`") {
      opaque = true;
    }
    if (["(", ")", "{", "}"].includes(character)) {
      opaque = true;
    }
    if (character === "#" && current.length === 0) {
      while (index < source.length && !["\n", "\r"].includes(source[index] ?? "")) {
        index += 1;
      }
      continue;
    }
    if (character === "&" && next === "&") {
      pushOperator("and", 2);
      continue;
    }
    if (character === "|" && next === "|") {
      pushOperator("or", 2);
      continue;
    }
    if (character === "|" && next === "&") {
      pushOperator("stderr-pipe", 2);
      continue;
    }
    if (character === "|") {
      pushOperator("pipe", 1);
      continue;
    }
    if (character === ";") {
      pushOperator("sequence", 1);
      continue;
    }
    if (character === "&") {
      pushOperator("background", 1);
      continue;
    }
    if (character === "\n" || character === "\r") {
      const width = character === "\r" && next === "\n" ? 2 : 1;
      if (tokens.length > 0 || current.length > 0) {
        pushOperator("sequence", width);
      } else {
        index += width;
      }
      continue;
    }
    if (character === ">" || character === "<") {
      if (/^\d+$/u.test(current)) {
        current = "";
      } else {
        pushToken();
      }
      const skipped = skipRedirection(source, index);
      opaque ||= skipped.opaque;
      index = skipped.nextIndex;
      continue;
    }
    if (/\s/u.test(character)) {
      pushToken();
      index += 1;
      continue;
    }

    current += character;
    index += 1;
  }

  if (quote !== null) {
    opaque = true;
  }
  pushCommand();
  if (operators.length >= commands.length) {
    const trailingOperator = operators.at(-1);
    if (trailingOperator !== "background" && trailingOperator !== "sequence") {
      opaque = true;
    }
    if (trailingOperator !== "background") {
      operators.splice(Math.max(0, commands.length - 1));
    }
  }
  return { commands, operators, opaque };
}

function skipRedirection(
  source: string,
  start: number,
): { readonly nextIndex: number; readonly opaque: boolean } {
  const redirect = source[start] ?? "";
  let index = start + 1;
  let opaque = redirect === "<" && source[index] === "<";
  if (source[index] === redirect) {
    index += 1;
  }
  if (source[index] === "&" || source[index] === "|") {
    index += 1;
  }
  while (index < source.length && /[ \t]/u.test(source[index] ?? "")) {
    index += 1;
  }

  let quote: "single" | "double" | null = null;
  while (index < source.length) {
    const character = source[index] ?? "";
    const next = source[index + 1];
    if (character === "\\" && quote !== "single" && next !== undefined) {
      index += 2;
      continue;
    }
    if (character === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
      index += 1;
      continue;
    }
    if (character === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
      index += 1;
      continue;
    }
    if (
      quote === null &&
      ((character === "$" && next === "(") ||
        character === "`" ||
        ["(", ")", "{", "}"].includes(character))
    ) {
      opaque = true;
    }
    if (quote === null && /\s/u.test(character)) {
      break;
    }
    if (quote === null && ["|", "&", ";"].includes(character)) {
      break;
    }
    index += 1;
  }
  opaque ||= quote !== null;
  return { nextIndex: index, opaque };
}
