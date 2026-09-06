/** Dispatch complete test output to an ecosystem-specific projection. */

import { shortestText } from "../shared/text.ts";
import { formatJavascriptTests } from "./javascript.ts";
import { formatLanguageTests } from "./languages.ts";
import { formatPhpRubyTests } from "./php-ruby.ts";
import { executable, keep, projectTestLines, replace } from "./shared.ts";

export function formatTestOutput(text: string, commandTokens: readonly string[]): string | null {
  const formatted =
    formatJavascriptTests(text, commandTokens) ??
    formatLanguageTests(text, commandTokens) ??
    formatPhpRubyTests(text, commandTokens) ??
    formatGenericTest(text, commandTokens);
  return formatted === null ? null : shortestText(text, formatted);
}

function formatGenericTest(text: string, commandTokens: readonly string[]): string | null {
  if (executable(commandTokens) !== "test") return null;
  return projectTestLines(text, (line) => {
    const summary = /^Tests:\s+(.+)$/u.exec(line);
    return summary === null ? keep() : replace(summary[1] ?? "");
  });
}
