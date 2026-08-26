/** Graphite CLI command shapes used by conservative terminal projections. */

export const HUSH_GRAPHITE_COMMANDS = [
  "log",
  "submit",
  "sync",
  "restack",
  "create",
  "branch",
] as const;
export type HushGraphiteCommand = (typeof HUSH_GRAPHITE_COMMANDS)[number];

export function graphiteCommand(tokens: readonly string[]): HushGraphiteCommand | null {
  if (tokens[0] !== "gt") {
    return null;
  }
  const command = tokens[1];
  return HUSH_GRAPHITE_COMMANDS.find((candidate) => candidate === command) ?? null;
}

export function graphiteCommandArguments(tokens: readonly string[]): readonly string[] {
  return graphiteCommand(tokens) === null ? [] : tokens.slice(2);
}

export function hasGraphiteOutputOverride(
  command: HushGraphiteCommand,
  args: readonly string[],
): boolean {
  if (args.some((argument) => ["--help", "-h"].includes(argument.split("=", 1)[0] ?? argument))) {
    return true;
  }
  return command === "log" && args.some((argument) => argument === "short" || argument === "long");
}
