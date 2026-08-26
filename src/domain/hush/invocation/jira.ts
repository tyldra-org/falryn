/** Jira CLI command shapes used by conservative forge projections. */

export const HUSH_JIRA_COMMANDS = ["issue-list", "issue-view"] as const;
export type HushJiraCommand = (typeof HUSH_JIRA_COMMANDS)[number];

const OUTPUT_FLAGS = new Set([
  "--columns",
  "--csv",
  "--delimiter",
  "--help",
  "--no-headers",
  "--no-truncate",
  "--plain",
  "--raw",
  "-h",
]);

export function jiraCommand(tokens: readonly string[]): HushJiraCommand | null {
  if (tokens[0] !== "jira" || tokens[1] !== "issue") {
    return null;
  }
  switch (tokens[2]) {
    case "list":
      return "issue-list";
    case "view":
      return "issue-view";
    default:
      return null;
  }
}

export function jiraCommandArguments(tokens: readonly string[]): readonly string[] {
  return jiraCommand(tokens) === null ? [] : tokens.slice(3);
}

export function hasJiraOutputOverride(args: readonly string[]): boolean {
  return args.some((argument) => OUTPUT_FLAGS.has(argument.split("=", 1)[0] ?? argument));
}
