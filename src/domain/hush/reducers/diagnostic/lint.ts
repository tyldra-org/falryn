/** Complete lint, format, and diagnostic projection with exact fallback. */

import { shortestText } from "../../text-format.ts";
import { formatCommandDiagnostics } from "./commands.ts";
import { formatEcosystemDiagnostics } from "./ecosystems.ts";
import { formatJavascriptDiagnostics } from "./javascript.ts";
import { formatLanguageDiagnostics } from "./languages.ts";

export function formatLintDiagnostics(
  text: string,
  commandTokens: readonly string[],
): string | null {
  const formatted =
    formatJavascriptDiagnostics(text, commandTokens) ??
    formatLanguageDiagnostics(text, commandTokens) ??
    formatEcosystemDiagnostics(text, commandTokens) ??
    formatCommandDiagnostics(text, commandTokens);
  return formatted === null ? null : shortestText(text, formatted);
}
