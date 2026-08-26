/** Normalized Docker, Podman, and Skopeo subcommand identity. */

export function containerSubcommand(tokens: readonly string[]): string {
  return tokens[1] === "compose" ? (tokens[2] ?? "") : (tokens[1] ?? "");
}
