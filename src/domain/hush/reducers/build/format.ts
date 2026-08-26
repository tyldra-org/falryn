/** Command-aware build formatting with the shortest complete representation. */

import { shortestText } from "../shared/text.ts";
import { formatJavascriptBuild } from "./javascript.ts";
import { formatLanguageBuild } from "./languages.ts";
import { formatToolBuild } from "./tools.ts";

export function formatBuildOutput(text: string, commandTokens: readonly string[]): string | null {
  const formatted =
    formatJavascriptBuild(text, commandTokens) ??
    formatLanguageBuild(text, commandTokens) ??
    formatToolBuild(text, commandTokens);
  return formatted === null ? null : shortestText(text, formatted);
}
