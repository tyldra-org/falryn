/** Shared Git command parsing for rule matching and reduction. */

const GIT_GLOBAL_VALUE_OPTIONS = new Set(["-c", "-C", "--git-dir", "--work-tree"]);
const GIT_GLOBAL_FLAGS = new Set([
  "--bare",
  "--literal-pathspecs",
  "--no-optional-locks",
  "--no-pager",
]);

export function gitSubcommand(tokens: readonly string[]): string {
  const index = gitSubcommandIndex(tokens);
  return index === null ? "" : (tokens[index] ?? "").toLowerCase();
}

export function gitSubcommandArguments(tokens: readonly string[]): readonly string[] {
  const index = gitSubcommandIndex(tokens);
  return index === null ? [] : tokens.slice(index + 1);
}

function gitSubcommandIndex(tokens: readonly string[]): number | null {
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    const normalized = token.split("=", 1)[0] ?? token;
    if (GIT_GLOBAL_VALUE_OPTIONS.has(normalized)) {
      index += token.includes("=") ? 1 : 2;
      continue;
    }
    if (GIT_GLOBAL_FLAGS.has(token)) {
      index += 1;
      continue;
    }
    return index;
  }
  return null;
}
