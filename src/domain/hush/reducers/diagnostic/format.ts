/** Complete, uncapped projections for supported type-checker diagnostics. */

import { shortestText } from "../../text-format.ts";

type DiagnosticSeverity = "error" | "information" | "warning";

type Location = Readonly<{
  path: string;
  line: number;
  column: number;
}>;

type Diagnostic = Readonly<{
  location: Location;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  context: readonly string[];
}>;

const TSC_DIAGNOSTIC = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/u;
const TSC_SUMMARY =
  /^Found\s+(\d+)\s+errors?(?:\s+in\s+(\d+)\s+files?)?\.?(?:\s+Watching for file changes\.)?$/u;
const BASEDPYRIGHT_DIAGNOSTIC = /^\s*(.+):(\d+):(\d+)\s+-\s+(error|warning|information):\s+(.+)$/u;
const BASEDPYRIGHT_SUMMARY = /^(\d+) errors?, (\d+) warnings?, (\d+) informations?$/u;
const TY_DIAGNOSTIC = /^(error|warning|information)\[([^\]]+)\]:\s+(.+)$/u;
const TY_LOCATION = /^\s*-->\s+(.+):(\d+):(\d+)$/u;
const TY_SUMMARY = /^Found (\d+) errors?, (\d+) warnings?$/u;

export function formatTypecheckDiagnostics(
  text: string,
  commandTokens: readonly string[],
): string | null {
  const lines = meaningfulLines(text, commandTokens);
  if (lines.length === 0) {
    return isBunTypecheck(commandTokens) && /^\s*\$\s+\S[^\n]*(?:\n|$)\s*$/u.test(text) ? "" : null;
  }
  return formatTsc(lines) ?? formatBasedpyright(lines) ?? formatTy(lines);
}

function formatTsc(lines: readonly string[]): string | null {
  const diagnostics: Diagnostic[] = [];
  let reportedErrors: number | null = null;
  let reportedFiles: number | null = null;
  for (const line of lines) {
    const match = TSC_DIAGNOSTIC.exec(line);
    if (match !== null) {
      diagnostics.push({
        location: location(match[1], match[2], match[3]),
        severity: severity(match[4]),
        code: match[5] ?? "",
        message: match[6] ?? "",
        context: [],
      });
      continue;
    }
    const summary = TSC_SUMMARY.exec(line);
    if (summary !== null) {
      reportedErrors = integer(summary[1]);
      reportedFiles = summary[2] === undefined ? null : integer(summary[2]);
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
    return reportedErrors === 0 ? "0 errors" : null;
  }
  const errorCount = diagnostics.filter((entry) => entry.severity === "error").length;
  const fileCount = new Set(diagnostics.map((entry) => entry.location.path)).size;
  if (
    (reportedErrors !== null && reportedErrors !== errorCount) ||
    (reportedFiles !== null && reportedFiles !== fileCount)
  ) {
    return null;
  }
  const warningCount = diagnostics.length - errorCount;
  const summary = typecheckSummary(errorCount, warningCount, fileCount);
  const flat = [summary, ...diagnostics.flatMap(formatFlatDiagnostic)].join("\n");
  const grouped = [summary, ...formatGroupedDiagnostics(diagnostics)].join("\n");
  return shortestText(flat, grouped);
}

function formatBasedpyright(lines: readonly string[]): string | null {
  const diagnostics: Diagnostic[] = [];
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
    const summary = BASEDPYRIGHT_SUMMARY.exec(line);
    if (summary !== null) {
      reported = [integer(summary[1]), integer(summary[2]), integer(summary[3])];
      continue;
    }
    const match = BASEDPYRIGHT_DIAGNOSTIC.exec(line);
    if (match !== null) {
      const parsedLocation = location(match[1], match[2], match[3]);
      if (heading !== null && heading !== parsedLocation.path) {
        return null;
      }
      const split = splitBasedpyrightRule(match[5] ?? "");
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

function formatTy(lines: readonly string[]): string | null {
  if (
    lines.every((line) =>
      /^(?:ty \d+\.\d+(?:\.\d+)?|Checking \d+ files?|All checks passed!)$/u.test(line),
    )
  ) {
    return lines.includes("All checks passed!") ? "All checks passed!" : null;
  }

  const diagnostics: Diagnostic[] = [];
  let reported: readonly [number, number] | null = null;
  for (const line of lines) {
    if (/^(?:ty \d+\.\d+(?:\.\d+)?|Checking \d+ files?)$/u.test(line)) {
      continue;
    }
    const summary = TY_SUMMARY.exec(line);
    if (summary !== null) {
      reported = [integer(summary[1]), integer(summary[2])];
      continue;
    }
    const match = TY_DIAGNOSTIC.exec(line);
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
    if (previous === undefined) {
      return null;
    }
    const located = TY_LOCATION.exec(line);
    if (located !== null && previous.location.path.length === 0) {
      diagnostics[diagnostics.length - 1] = {
        ...previous,
        location: location(located[1], located[2], located[3]),
      };
      continue;
    }
    if (/^\s*\|\s*$/u.test(line)) {
      continue;
    }
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

function meaningfulLines(text: string, commandTokens: readonly string[]): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/u, ""))
    .filter((line) => line.trim().length > 0)
    .filter((line) => !(isBunTypecheck(commandTokens) && /^\$\s+\S/u.test(line)));
}

function isBunTypecheck(commandTokens: readonly string[]): boolean {
  return (
    commandTokens[0] === "bun" && commandTokens[1] === "run" && commandTokens[2] === "typecheck"
  );
}

function formatFlatDiagnostic(diagnostic: Diagnostic): readonly string[] {
  const rule = diagnostic.code.length > 0 ? `[${diagnostic.code}]` : "";
  return [
    `${diagnostic.location.path}:${diagnostic.location.line}:${diagnostic.location.column} ${diagnostic.severity}${rule}: ${diagnostic.message}`,
    ...diagnostic.context.map((line) => `  ${line}`),
  ];
}

function formatGroupedDiagnostics(diagnostics: readonly Diagnostic[]): readonly string[] {
  const grouped = new Map<string, Diagnostic[]>();
  for (const diagnostic of diagnostics) {
    const entries = grouped.get(diagnostic.location.path) ?? [];
    entries.push(diagnostic);
    grouped.set(diagnostic.location.path, entries);
  }
  return [...grouped].flatMap(([path, entries]) => [
    path,
    ...entries.flatMap((entry) => {
      const rule = entry.code.length > 0 ? `[${entry.code}]` : "";
      return [
        `  ${entry.location.line}:${entry.location.column} ${entry.severity}${rule}: ${entry.message}`,
        ...entry.context.map((line) => `    ${line}`),
      ];
    }),
  ]);
}

function splitBasedpyrightRule(value: string): Readonly<{ message: string; rule: string }> {
  const match = /^(.*)\s+\((report[^()\s]+)\)$/u.exec(value);
  return match === null
    ? { message: value, rule: "" }
    : { message: match[1] ?? "", rule: match[2] ?? "" };
}

function countsBySeverity(
  diagnostics: readonly Diagnostic[],
): Readonly<Record<DiagnosticSeverity, number>> {
  const counts = { error: 0, information: 0, warning: 0 };
  for (const diagnostic of diagnostics) {
    counts[diagnostic.severity] += 1;
  }
  return counts;
}

function typecheckSummary(errors: number, warnings: number, files: number): string {
  const warning = warnings === 0 ? "" : `, ${warnings} ${plural(warnings, "warning")}`;
  return `${errors} ${plural(errors, "error")}${warning} in ${files} ${plural(files, "file")}`;
}

function looksLikePythonPath(line: string): boolean {
  return !/^\s/u.test(line) && /(?:^|[\\/])[^\\/]+\.pyi?$/u.test(line);
}

function location(
  path: string | undefined,
  line: string | undefined,
  column: string | undefined,
): Location {
  return {
    path: path ?? "",
    line: integer(line),
    column: integer(column),
  };
}

function severity(value: string | undefined): DiagnosticSeverity {
  if (value === "warning" || value === "information") {
    return value;
  }
  return "error";
}

function integer(value: string | undefined): number {
  return Number.parseInt(value ?? "0", 10);
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
