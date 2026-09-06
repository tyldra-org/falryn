/** Complete curl response-header projection with an exact body. */

import { compactDuplicateRuns, compactJsonWhitespace, shortestText } from "../shared/text.ts";

const STATUS_LINE = /^HTTP\/(?:1\.[01]|2|3)\s+\d{3}(?:\s+.*)?$/u;
const HEADER_LINE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+:\s*.*$/u;

export function formatCurlResponse(text: string): string | null {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();
  if (!STATUS_LINE.test(lines[0] ?? "")) return null;

  const output: string[] = [];
  let cursor = 0;
  while (cursor < lines.length && STATUS_LINE.test(lines[cursor] ?? "")) {
    output.push((lines[cursor] ?? "").trim());
    cursor += 1;
    while (cursor < lines.length && (lines[cursor] ?? "").length > 0) {
      const header = lines[cursor] ?? "";
      if (!HEADER_LINE.test(header)) return null;
      output.push(header.replace(/^([^:]+):\s*/u, "$1:"));
      cursor += 1;
    }
    if (cursor < lines.length && (lines[cursor] ?? "").length === 0) cursor += 1;
  }

  const body = lines.slice(cursor).join("\n");
  if (body.length > 0) {
    const json = compactJsonWhitespace(body);
    output.push(shortestText(body, compactDuplicateRuns(body), ...(json === null ? [] : [json])));
  }
  return shortestText(text, output.join("\n"));
}
