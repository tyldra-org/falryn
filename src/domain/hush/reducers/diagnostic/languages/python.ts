/** Python diagnostic output reduction. */

import {
  type DiagnosticFact,
  diagnosticSummary,
  formatFacts,
  integer,
  normalizedSeverity,
  sameCount,
  sourceLines,
} from "../shared.ts";

export function formatPythonDiagnostics(
  text: string,
  executable: "mypy" | "ruff",
  operation?: string,
): string | null {
  if (executable === "mypy") return formatMypy(text);
  return operation === "format" ? formatRuffFormat(text) : formatRuffCheck(text);
}

function formatMypy(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  let reportedErrors: number | undefined;
  let checkedFiles: number | undefined;
  for (const line of sourceLines(text)) {
    const diagnostic =
      /^(.+):(\d+)(?::(\d+))?:\s+(error|warning|note):\s+(.+?)(?:\s+\[([^\]]+)\])?$/u.exec(line);
    if (diagnostic !== null) {
      facts.push({
        path: diagnostic[1] ?? "",
        line: diagnostic[2],
        column: diagnostic[3],
        severity: normalizedSeverity(diagnostic[4]),
        message: diagnostic[5] ?? "",
        code: diagnostic[6],
      });
      continue;
    }
    const summary = /^Found (\d+) errors? in \d+ files? \(checked (\d+) source files?\)$/u.exec(
      line,
    );
    if (summary !== null) {
      reportedErrors = integer(summary[1]);
      checkedFiles = integer(summary[2]);
      continue;
    }
    if (/^Success: no issues found in \d+ source files?$/u.test(line)) {
      const checked = /in (\d+) source files?$/u.exec(line);
      return `ok ${checked?.[1] ?? "0"} files`;
    }
    return null;
  }
  const errors = facts.filter((fact) => fact.severity === "error").length;
  if (facts.length === 0 || !sameCount(reportedErrors, errors)) return null;
  const suffix = checkedFiles === undefined ? undefined : `checked ${checkedFiles} files`;
  return formatFacts(facts, diagnosticSummary(facts, suffix));
}

function formatRuffCheck(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  let reported: number | undefined;
  let fixable: number | undefined;
  for (const line of sourceLines(text)) {
    const diagnostic = /^(.+):(\d+):(\d+):\s+([A-Z]+\d+)\s+(?:\[\*\]\s+)?(.+)$/u.exec(line);
    if (diagnostic !== null) {
      facts.push({
        path: diagnostic[1] ?? "",
        line: diagnostic[2],
        column: diagnostic[3],
        severity: "error",
        code: diagnostic[4],
        message: diagnostic[5] ?? "",
      });
      continue;
    }
    const summary = /^Found (\d+) errors?\.?$/u.exec(line);
    if (summary !== null) {
      reported = integer(summary[1]);
      continue;
    }
    const fixes = /^\[\*\] (\d+) fixable with .+$/u.exec(line);
    if (fixes !== null) {
      fixable = integer(fixes[1]);
      continue;
    }
    if (line === "All checks passed!") return "ok";
    return null;
  }
  if (facts.length === 0 || !sameCount(reported, facts.length)) return null;
  const suffix = fixable === undefined ? undefined : `${fixable} fixable`;
  return formatFacts(facts, diagnosticSummary(facts, suffix));
}

function formatRuffFormat(text: string): string | null {
  const paths: string[] = [];
  let reported: number | undefined;
  for (const line of sourceLines(text)) {
    const path = /^Would reformat:\s+(.+)$/u.exec(line);
    if (path !== null) {
      paths.push(path[1] ?? "");
      continue;
    }
    const summary = /^(\d+) files? would be reformatted$/u.exec(line);
    if (summary !== null) {
      reported = integer(summary[1]);
      continue;
    }
    if (/^\d+ files? already formatted$/u.test(line) && paths.length === 0) return "ok";
    return null;
  }
  if (paths.length === 0 || !sameCount(reported, paths.length)) return null;
  return [`${paths.length} files need formatting`, ...paths].join("\n");
}
