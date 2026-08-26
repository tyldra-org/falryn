/** Dispatch diagnostics to the owning language parser. */

import { formatGoDiagnostics } from "./languages/go.ts";
import { formatPythonDiagnostics } from "./languages/python.ts";
import { formatRustDiagnostics } from "./languages/rust.ts";

export function formatLanguageDiagnostics(
  text: string,
  commandTokens: readonly string[],
): string | null {
  switch (commandTokens[0] ?? "") {
    case "cargo":
      return formatRustDiagnostics(text, commandTokens[1] === "fmt");
    case "clippy":
      return formatRustDiagnostics(text, false);
    case "mypy":
      return formatPythonDiagnostics(text, "mypy");
    case "ruff":
      return formatPythonDiagnostics(text, "ruff", commandTokens[1]);
    case "go":
      return commandTokens[1] === "vet" ? formatGoDiagnostics(text, false) : null;
    case "golangci":
    case "golangci-lint":
      return formatGoDiagnostics(text, true);
    default:
      return null;
  }
}
