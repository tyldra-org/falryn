/** GitHub CLI command shapes shared by capture planning and Hush projection. */

export const HUSH_GITHUB_COMMANDS = [
  "pr-list",
  "pr-view",
  "issue-list",
  "run-list",
  "repo-view",
  "api",
  "release-list",
] as const;
export type HushGithubCommand = (typeof HUSH_GITHUB_COMMANDS)[number];

const OUTPUT_FLAGS = new Set(["--help", "-h", "--json", "--jq", "-q", "--template", "-t"]);

export function githubCommand(tokens: readonly string[]): HushGithubCommand | null {
  if (tokens[0] !== "gh") {
    return null;
  }
  const group = tokens[1];
  const action = tokens[2];
  if (group === "pr" && action === "list") {
    return "pr-list";
  }
  if (group === "pr" && action === "view") {
    return "pr-view";
  }
  if (group === "issue" && action === "list") {
    return "issue-list";
  }
  if (group === "run" && action === "list") {
    return "run-list";
  }
  if (group === "repo" && action === "view") {
    return "repo-view";
  }
  if (group === "api") {
    return "api";
  }
  return group === "release" && action === "list" ? "release-list" : null;
}

export function githubCommandArguments(tokens: readonly string[]): readonly string[] {
  const command = githubCommand(tokens);
  return command === null ? [] : tokens.slice(command === "api" ? 2 : 3);
}

export function hasGithubOutputOverride(
  command: HushGithubCommand,
  args: readonly string[],
): boolean {
  if (command === "api") {
    return true;
  }
  return args.some((arg) => {
    const name = arg.split("=", 1)[0] ?? arg;
    return (
      OUTPUT_FLAGS.has(name) ||
      arg === "--web" ||
      (command === "pr-view" && arg === "--comments") ||
      (command === "repo-view" && (name === "--branch" || name === "-b"))
    );
  });
}
