/** Rust diagnostic output reduction. */

import {
  type DiagnosticFact,
  formatCompactFacts,
  integer,
  sameCount,
  sourceLines,
} from "../shared.ts";

export function formatRustDiagnostics(text: string, rustfmt: boolean): string | null {
  return rustfmt ? formatRustfmt(text) : formatRust(text);
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
      current = { ...current, path: location[1], line: location[2], column: location[3] };
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
