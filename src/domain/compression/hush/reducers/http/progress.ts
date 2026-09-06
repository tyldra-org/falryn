import { matchesPattern } from "../stream.ts";

const CURL_PROGRESS = [
  /^\s*%\s+Total\s+%\s+Received\s+%\s+Xferd/iu,
  /^\s*Dload\s+Upload\s+Total\s+Spent\s+Left\s+Speed\s*$/iu,
  /^\s*\d{1,3}\s+\d+\s+\d{1,3}\s+\d+\s+\d{1,3}\s+\d+/u,
] as const;

const WGET_PROGRESS = [
  /^\s*\d+[KMG]?\s+(?:[. ]+|[=>-]+)\s*\d{1,3}%\s+/u,
  /^\s*\S+\s+\d{1,3}%\[[=>. -]+\]\s+\S+/u,
] as const;

export function stripCurlProgress(text: string, patterns: readonly string[]): string {
  return stripLines(text, patterns, CURL_PROGRESS);
}

export function stripWgetProgress(text: string, patterns: readonly string[]): string {
  return stripLines(text, patterns, WGET_PROGRESS);
}

function stripLines(text: string, patterns: readonly string[], noise: readonly RegExp[]): string {
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  const retained = lines.filter(
    (line) => matchesPattern(line, patterns) || !noise.some((matcher) => matcher.test(line)),
  );
  const result = retained.join("\n");
  return trailingNewline && result.length > 0 ? `${result}\n` : result;
}
