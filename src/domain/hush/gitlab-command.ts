/** GitLab CLI command shapes shared by capture planning and Hush projection. */

export const HUSH_GITLAB_COMMANDS = [
  "mr-list",
  "issue-list",
  "ci-status",
  "pipeline-list",
  "api",
  "release-list",
] as const;
export type HushGitlabCommand = (typeof HUSH_GITLAB_COMMANDS)[number];

const COMMON_OUTPUT_FLAGS = new Set(["--help", "-h", "--jq"]);

export function gitlabCommand(tokens: readonly string[]): HushGitlabCommand | null {
  if (tokens[0] !== "glab") {
    return null;
  }
  const group = tokens[1];
  const action = tokens[2];
  if (group === "mr" && action === "list") {
    return "mr-list";
  }
  if (group === "issue" && action === "list") {
    return "issue-list";
  }
  if ((group === "ci" || group === "pipeline" || group === "pipe") && action === "status") {
    return "ci-status";
  }
  if ((group === "ci" || group === "pipeline" || group === "pipe") && action === "list") {
    return "pipeline-list";
  }
  if (group === "api") {
    return "api";
  }
  return group === "release" && action === "list" ? "release-list" : null;
}

export function gitlabCommandArguments(tokens: readonly string[]): readonly string[] {
  const command = gitlabCommand(tokens);
  return command === null ? [] : tokens.slice(command === "api" ? 2 : 3);
}

export function hasGitlabOutputOverride(
  command: HushGitlabCommand,
  args: readonly string[],
): boolean {
  if (command === "api") {
    return true;
  }
  return args.some((argument) => {
    const name = argument.split("=", 1)[0] ?? argument;
    if (COMMON_OUTPUT_FLAGS.has(name)) {
      return true;
    }
    if (command === "issue-list") {
      return ["--output", "-O", "--output-format", "-F"].includes(name);
    }
    if (["--output", "-F"].includes(name)) {
      return true;
    }
    return (
      command === "ci-status" && ["--live", "-l", "--wait", "-w", "--compact", "-c"].includes(name)
    );
  });
}
