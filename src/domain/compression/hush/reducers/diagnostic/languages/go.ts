/** Go diagnostic output reduction. */

import {
  type DiagnosticFact,
  formatCompactFacts,
  integer,
  sameCount,
  sourceLines,
} from "../shared.ts";

export function formatGoDiagnostics(text: string, golangci: boolean): string | null {
  return golangci ? formatGolangci(text) : formatGoVet(text);
}

function formatGoVet(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  for (const line of sourceLines(text)) {
    if (/^#\s+\S/u.test(line)) continue;
    const diagnostic = /^(.+):(\d+):(\d+):\s+(.+)$/u.exec(line);
    if (diagnostic === null) return null;
    facts.push({
      path: diagnostic[1] ?? "",
      line: diagnostic[2],
      column: diagnostic[3],
      severity: "error",
      message: diagnostic[4] ?? "",
    });
  }
  return formatCompactFacts(facts);
}

function formatGolangci(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  let reported: number | undefined;
  for (const line of sourceLines(text)) {
    const diagnostic = /^(.+):(\d+):(\d+):\s+(.+?)\s+\(([^)]+)\)$/u.exec(line);
    if (diagnostic !== null) {
      facts.push({
        path: diagnostic[1] ?? "",
        line: diagnostic[2],
        column: diagnostic[3],
        severity: "error",
        code: diagnostic[5],
        message: diagnostic[4] ?? "",
      });
      continue;
    }
    const summary = /^(\d+) issues?:$/u.exec(line);
    if (summary !== null) {
      reported = integer(summary[1]);
      continue;
    }
    if (/^\*\s+\S+:\s+\d+$/u.test(line)) continue;
    return null;
  }
  if (facts.length === 0 || !sameCount(reported, facts.length)) return null;
  return formatCompactFacts(facts);
}
