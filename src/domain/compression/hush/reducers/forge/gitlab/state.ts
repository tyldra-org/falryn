import { stateWord } from "../github/json.ts";

export function visibleGitlabState(
  state: string,
  args: readonly string[],
  kind: "issue" | "merge-request",
): string {
  const actual = stateWord(state === "opened" ? "open" : state);
  const requested = requestedState(args, kind);
  return requested !== "all" && actual === requested ? "" : `${actual} `;
}

function requestedState(args: readonly string[], kind: "issue" | "merge-request"): string {
  if (hasFlag(args, "--all", "-A")) {
    return "all";
  }
  if (hasFlag(args, "--closed", "-c")) {
    return "closed";
  }
  if (kind === "merge-request" && hasFlag(args, "--merged", "-M")) {
    return "merged";
  }
  return "open";
}

function hasFlag(args: readonly string[], long: string, short: string): boolean {
  return args.some((argument) => {
    const name = argument.split("=", 1)[0] ?? argument;
    return name === long || name === short;
  });
}
