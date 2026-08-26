/** Basedpyright and Pyright diagnostic parsing. */

import {
  countsBySeverity,
  formatFlatDiagnostic,
  integer,
  location,
  looksLikePythonPath,
  plural,
  severity,
  type TypecheckDiagnostic,
} from "./shared.ts";

const DIAGNOSTIC = /^\s*(.+):(\d+):(\d+)\s+-\s+(error|warning|information):\s+(.+)$/u;
const SUMMARY = /^(\d+) errors?, (\d+) warnings?, (\d+) informations?$/u;

export function formatPyrightDiagnostics(lines: readonly string[]): string | null {
  const diagnostics: TypecheckDiagnostic[] = [];
  let heading: string | null = null;
  let reported: readonly [number, number, number] | null = null;
  for (const line of lines) {
    if (
      /^(?:basedpyright|Pyright) \d+\.\d+(?:\.\d+)?/u.test(line) ||
      /^Searching for source files/u.test(line) ||
      /^Found \d+ source files?/u.test(line)
    ) {
      continue;
    }
    const summary = SUMMARY.exec(line);
    if (summary !== null) {
      reported = [integer(summary[1]), integer(summary[2]), integer(summary[3])];
      continue;
    }
    const match = DIAGNOSTIC.exec(line);
    if (match !== null) {
      const parsedLocation = location(match[1], match[2], match[3]);
      if (heading !== null && heading !== parsedLocation.path) return null;
      const split = splitRule(match[5] ?? "");
      diagnostics.push({
        location: parsedLocation,
        severity: severity(match[4]),
        code: split.rule,
        message: split.message,
        context: [],
      });
      continue;
    }
    if (looksLikePythonPath(line)) {
      heading = line;
      continue;
    }
    const previous = diagnostics.at(-1);
    if (previous !== undefined && /^(?:\t|\s{2,})/u.test(line)) {
      diagnostics[diagnostics.length - 1] = {
        ...previous,
        context: [...previous.context, line.trim()],
      };
      continue;
    }
    return null;
  }
  if (diagnostics.length === 0) {
    return reported?.every((count) => count === 0) ? "0 errors, 0 warnings, 0 informations" : null;
  }
  const actual = countsBySeverity(diagnostics);
  if (
    reported !== null &&
    (reported[0] !== actual.error ||
      reported[1] !== actual.warning ||
      reported[2] !== actual.information)
  ) {
    return null;
  }
  return [
    `${actual.error} ${plural(actual.error, "error")}, ${actual.warning} ${plural(actual.warning, "warning")}, ${actual.information} ${plural(actual.information, "information")}`,
    ...diagnostics.flatMap(formatFlatDiagnostic),
  ].join("\n");
}

function splitRule(value: string): Readonly<{ message: string; rule: string }> {
  const match = /^(.*)\s+\((report[^()\s]+)\)$/u.exec(value);
  return match === null
    ? { message: value, rule: "" }
    : { message: match[1] ?? "", rule: match[2] ?? "" };
}
