import { stateWord } from "./json.ts";

/**
 * A list's state is already carried by the command when gh applies one state
 * filter. Repeat it per row only for `--state all` or an unexpected record.
 */
export function visibleState(state: string, args: readonly string[]): string {
  const actual = stateWord(state);
  const requested = requestedState(args);
  return requested !== "all" && actual === requested ? "" : `${actual} `;
}

function requestedState(args: readonly string[]): string {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (argument === "--state" || argument === "-s") {
      return (args[index + 1] ?? "open").toLowerCase();
    }
    const inline = /^(?:--state|-s)=(.+)$/u.exec(argument)?.[1];
    if (inline !== undefined) {
      return inline.toLowerCase();
    }
  }
  return "open";
}
