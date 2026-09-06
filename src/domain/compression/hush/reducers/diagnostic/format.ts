/** Dispatch complete type-checker output to its owning parser. */

import { formatPyrightDiagnostics } from "./typecheck/pyright.ts";
import { formatTyDiagnostics } from "./typecheck/ty.ts";
import { formatTypescriptDiagnostics } from "./typecheck/typescript.ts";

export function formatTypecheckDiagnostics(
  text: string,
  commandTokens: readonly string[],
): string | null {
  const lines = meaningfulLines(text, commandTokens);
  if (lines.length === 0) {
    return isBunTypecheck(commandTokens) && /^\s*\$\s+\S[^\n]*(?:\n|$)\s*$/u.test(text) ? "" : null;
  }
  return (
    formatTypescriptDiagnostics(lines) ??
    formatPyrightDiagnostics(lines) ??
    formatTyDiagnostics(lines)
  );
}

function meaningfulLines(text: string, commandTokens: readonly string[]): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/u, ""))
    .filter((line) => line.trim().length > 0)
    .filter((line) => !(isBunTypecheck(commandTokens) && /^\$\s+\S/u.test(line)));
}

function isBunTypecheck(commandTokens: readonly string[]): boolean {
  return (
    commandTokens[0] === "bun" && commandTokens[1] === "run" && commandTokens[2] === "typecheck"
  );
}
