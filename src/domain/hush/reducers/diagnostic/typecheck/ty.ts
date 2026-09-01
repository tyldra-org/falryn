/** Astral ty diagnostic parsing. */

import {
  countsBySeverity,
  formatFlatDiagnostic,
  integer,
  location,
  plural,
  severity,
  type TypecheckDiagnostic,
} from "./shared.ts";

const DIAGNOSTIC = /^(error|warning|information)\[([^\]]+)\]:\s+(.+)$/u;
const LOCATION = /^\s*-->\s+(.+):(\d+):(\d+)$/u;
const SUMMARY = /^Found (\d+) errors?, (\d+) warnings?$/u;

export function formatTyDiagnostics(lines: readonly string[]): string | null {
  if (
    lines.every((line) =>
      /^(?:ty \d+\.\d+(?:\.\d+)?|Checking \d+ files?|All checks passed!)$/u.test(line),
    )
  ) {
    return lines.includes("All checks passed!") ? "All checks passed!" : null;
  }

  const diagnostics: TypecheckDiagnostic[] = [];
  let reported: readonly [number, number] | null = null;
  for (const line of lines) {
    if (/^(?:ty \d+\.\d+(?:\.\d+)?|Checking \d+ files?)$/u.test(line)) continue;
    const summary = SUMMARY.exec(line);
    if (summary !== null) {
      reported = [integer(summary[1]), integer(summary[2])];
      continue;
    }
    const match = DIAGNOSTIC.exec(line);
    if (match !== null) {
      diagnostics.push({
        location: { path: "", line: 0, column: 0 },
        severity: severity(match[1]),
        code: match[2] ?? "",
        message: match[3] ?? "",
        context: [],
      });
      continue;
    }
    const previous = diagnostics.at(-1);
    if (previous === undefined) return null;
    const located = LOCATION.exec(line);
    if (located !== null && previous.location.path.length === 0) {
      diagnostics[diagnostics.length - 1] = {
        ...previous,
        location: location(located[1], located[2], located[3]),
      };
      continue;
    }
    if (/^\s*\|\s*$/u.test(line)) continue;
    diagnostics[diagnostics.length - 1] = {
      ...previous,
      context: [...previous.context, line.trimEnd()],
    };
  }
  if (diagnostics.length === 0 || diagnostics.some((entry) => entry.location.path.length === 0)) {
    return null;
  }
  const actual = countsBySeverity(diagnostics);
  if (reported !== null && (reported[0] !== actual.error || reported[1] !== actual.warning)) {
    return null;
  }
  return [
    `${actual.error} ${plural(actual.error, "error")}, ${actual.warning} ${plural(actual.warning, "warning")}`,
    ...diagnostics.flatMap(formatFlatDiagnostic),
  ].join("\n");
}
