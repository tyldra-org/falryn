/** Shared command and capture helpers for container projections. */

export const CONTAINER_EXECUTABLES = new Set(["docker", "podman", "skopeo"]);

export function containerExecutable(commandTokens: readonly string[]): string {
  return commandTokens[0]?.split(/[\\/]/u).at(-1) ?? "";
}

export function containerSubcommand(commandTokens: readonly string[]): string {
  return commandTokens[1] === "compose" ? (commandTokens[2] ?? "") : (commandTokens[1] ?? "");
}

export function containerLines(text: string): readonly string[] {
  const lines = text.split("\n").map((line) => line.replace(/\r$/u, "").trimEnd());
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function hasCallerPresentation(commandTokens: readonly string[]): boolean {
  return commandTokens.some(
    (token) => token === "--format" || token.startsWith("--format=") || token === "-f",
  );
}
