/** Complete projections for Rust, Python, and Go diagnostics. */

import {
  type DiagnosticFact,
  diagnosticSummary,
  formatCompactFacts,
  formatFacts,
  integer,
  normalizedSeverity,
  sameCount,
  sourceLines,
} from "./shared.ts";

export function formatLanguageDiagnostics(
  text: string,
  commandTokens: readonly string[],
): string | null {
  switch (commandTokens[0] ?? "") {
    case "cargo":
      return commandTokens[1] === "fmt" ? formatRustfmt(text) : formatRust(text);
    case "clippy":
      return formatRust(text);
    case "mypy":
      return formatMypy(text);
    case "ruff":
      return commandTokens[1] === "format" ? formatRuffFormat(text) : formatRuffCheck(text);
    case "go":
      return commandTokens[1] === "vet" ? formatGoVet(text) : null;
    case "golangci":
    case "golangci-lint":
      return formatGolangci(text);
    default:
      return null;
  }
}

function formatRust(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  let current:
    | Readonly<{
        severity: "error" | "warning";
        code?: string | undefined;
        message: string;
        path?: string | undefined;
        line?: string | undefined;
        column?: string | undefined;
        context: readonly string[];
      }>
    | undefined;
  let reportedErrors: number | undefined;
  let reportedWarnings: number | undefined;

  const flush = (): boolean => {
    if (current === undefined) return true;
    if (current.path === undefined || current.line === undefined || current.column === undefined) {
      return false;
    }
    facts.push({
      path: current.path,
      line: current.line,
      column: current.column,
      severity: current.severity,
      code: current.code,
      message: current.message,
      context: current.context,
    });
    current = undefined;
    return true;
  };

  for (const line of sourceLines(text)) {
    if (/^\s*(?:Checking|Finished)\b/u.test(line)) continue;
    const generated = /^warning: .+ generated (\d+) warnings?/u.exec(line);
    if (generated !== null) {
      if (!flush()) return null;
      reportedWarnings = integer(generated[1]);
      continue;
    }
    const failed = /^error: could not compile .+ due to (\d+) previous errors?/u.exec(line);
    if (failed !== null) {
      if (!flush()) return null;
      reportedErrors = integer(failed[1]);
      continue;
    }
    const header = /^(error|warning)(?:\[([^\]]+)\])?:\s+(.+?)(?:\s+\[([^\]]+)\])?$/u.exec(line);
    if (header !== null) {
      if (!flush()) return null;
      current = {
        severity: header[1] === "warning" ? "warning" : "error",
        code: header[2] ?? header[4],
        message: header[3] ?? "",
        context: [],
      };
      continue;
    }
    const location = /^\s*-->\s+(.+):(\d+):(\d+)$/u.exec(line);
    if (location !== null && current !== undefined && current.path === undefined) {
      current = {
        ...current,
        path: location[1],
        line: location[2],
        column: location[3],
      };
      continue;
    }
    if (current !== undefined) {
      if (/^\s*\|\s*$/u.test(line)) continue;
      const context = line.trim().replace(/^=\s*/u, "");
      current = { ...current, context: [...current.context, context] };
      continue;
    }
    return null;
  }
  if (!flush() || facts.length === 0) return null;
  const errors = facts.filter((fact) => fact.severity === "error").length;
  const warnings = facts.length - errors;
  if (!sameCount(reportedErrors, errors) || !sameCount(reportedWarnings, warnings)) return null;
  return formatCompactFacts(facts);
}

function formatRustfmt(text: string): string | null {
  let recognized = false;
  const formatted = text
    .split("\n")
    .map((line) => {
      const header = /^Diff in (.+):$/u.exec(line.replace(/\r$/u, ""));
      if (header === null) return line;
      recognized = true;
      return `${header[1] ?? ""}:`;
    })
    .join("\n")
    .trimEnd();
  return recognized ? formatted : null;
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
