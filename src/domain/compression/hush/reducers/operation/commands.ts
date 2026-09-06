/** Complete projections for err, PHP, and selected operational CLIs. */

import { buildLines } from "../build/shared.ts";
import { formatLintDiagnostics } from "../diagnostic/lint.ts";

export function formatOperationCommand(
  text: string,
  commandTokens: readonly string[],
): string | null {
  switch (commandTokens[0] ?? "") {
    case "err":
      return formatLintDiagnostics(text, ["lint"]);
    case "php":
      return formatPhp(text, commandTokens);
    case "shopify":
      return formatShopify(text, commandTokens);
    case "ollama":
    case "java":
      return null;
    default:
      return null;
  }
}

function formatPhp(text: string, commandTokens: readonly string[]): string | null {
  if (commandTokens[1] === "-l") {
    const match = /^No syntax errors detected in (.+)$/u.exec(buildLines(text).join(" "));
    return match === null ? null : `ok ${match[1]}`;
  }
  if (commandTokens[1] === "artisan") {
    const lines = buildLines(text);
    if (lines.length !== 2 || lines[0] !== "INFO") return null;
    const success = /^(.+?) successfully\.$/u.exec(lines[1] ?? "");
    return success === null ? null : `ok artisan ${success[1]}`;
  }
  return null;
}

function formatShopify(text: string, commandTokens: readonly string[]): string | null {
  const action = commandTokens[2] ?? commandTokens[1] ?? "operation";
  let theme: string | undefined;
  let store: string | undefined;
  let url: string | undefined;
  let files: string | undefined;
  for (const line of buildLines(text)) {
    if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u.test(line)) continue;
    const complete = /^Theme (\S+) (?:pushed to|pulled from) (\S+) \((\d+) files?\)$/u.exec(line);
    if (complete !== null) {
      theme = complete[1];
      store = complete[2];
      files = complete[3];
      continue;
    }
    const preview = /^Preview URL:\s+(.+)$/u.exec(line);
    if (preview !== null) {
      url = preview[1];
      continue;
    }
    return null;
  }
  return theme === undefined || store === undefined || files === undefined || url === undefined
    ? null
    : `ok shopify ${action} ${theme} ${store} ${files} files ${url}`;
}
