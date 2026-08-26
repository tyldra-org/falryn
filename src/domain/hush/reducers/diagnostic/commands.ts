/** Complete projections for generic, pre-commit, and standalone diagnostic commands. */

import {
  type DiagnosticFact,
  diagnosticSummary,
  formatCompactFacts,
  formatFacts,
  integer,
  normalizedSeverity,
  sourceLines,
} from "./shared.ts";

export function formatCommandDiagnostics(
  text: string,
  commandTokens: readonly string[],
): string | null {
  switch (commandTokens[0] ?? "") {
    case "format":
      return formatGenericFormat(text);
    case "lint":
      return formatGenericLint(text);
    case "pre-commit":
      return formatPrecommit(text);
    case "hadolint":
      return formatHadolint(text);
    case "markdownlint":
      return formatMarkdownlint(text);
    case "shellcheck":
      return formatShellcheck(text);
    case "yamllint":
      return formatYamllint(text);
    default:
      return null;
  }
}

function formatGenericFormat(text: string): string | null {
  const match = /^Formatting complete:\s+(\d+) files? checked,\s+(\d+) unchanged\.?$/u.exec(
    sourceLines(text).join(" "),
  );
  if (match === null || match[1] !== match[2]) return null;
  return `ok ${match[1]} files unchanged`;
}

function formatGenericLint(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  let reported: readonly [number, number, number] | null = null;
  for (const line of sourceLines(text)) {
    const diagnostic = /^(.+):(\d+):(\d+):\s+(error|warning|info)\s+([^:]+):\s+(.+)$/u.exec(line);
    if (diagnostic !== null) {
      facts.push({
        path: diagnostic[1] ?? "",
        line: diagnostic[2],
        column: diagnostic[3],
        severity: normalizedSeverity(diagnostic[4]),
        code: diagnostic[5],
        message: diagnostic[6] ?? "",
      });
      continue;
    }
    const summary = /^(\d+) issues? \((\d+) errors?, (\d+) warnings?\)$/u.exec(line);
    if (summary !== null) {
      reported = [integer(summary[1]), integer(summary[2]), integer(summary[3])];
      continue;
    }
    return null;
  }
  if (facts.length === 0) return null;
  const errors = facts.filter((fact) => fact.severity === "error").length;
  const warnings = facts.filter((fact) => fact.severity === "warning").length;
  if (
    reported !== null &&
    (reported[0] !== facts.length || reported[1] !== errors || reported[2] !== warnings)
  ) {
    return null;
  }
  return formatFacts(facts, diagnosticSummary(facts));
}

function formatPrecommit(text: string): string | null {
  const hooks: Array<{
    name: string;
    status: "failed" | "passed";
    id?: string | undefined;
    exitCode?: string | undefined;
    details: string[];
  }> = [];
  for (const line of sourceLines(text)) {
    const heading = /^(.+?)\.{3,}(Passed|Failed)$/u.exec(line);
    if (heading !== null) {
      hooks.push({
        name: heading[1]?.trim() ?? "",
        status: heading[2] === "Passed" ? "passed" : "failed",
        details: [],
      });
      continue;
    }
    const current = hooks.at(-1);
    if (current === undefined || !/^\s*-\s+/u.test(line)) return null;
    const detail = line.replace(/^\s*-\s+/u, "");
    const id = /^hook id:\s+(.+)$/u.exec(detail);
    if (id !== null) {
      current.id = id[1];
      continue;
    }
    const exitCode = /^exit code:\s+(\d+)$/u.exec(detail);
    if (exitCode !== null) {
      current.exitCode = exitCode[1];
      continue;
    }
    current.details.push(detail.replace(/^files were /u, "files "));
  }
  if (hooks.length === 0) return null;
  const failed = hooks.filter((hook) => hook.status === "failed").length;
  const passed = hooks.length - failed;
  const summary = `${failed} failed, ${passed} passed`;
  return [
    summary,
    ...hooks.map((hook) => {
      const id = hook.id === undefined ? "" : ` [${hook.id}]`;
      const exit = hook.exitCode === undefined ? "" : ` exit ${hook.exitCode}`;
      const details = hook.details.length === 0 ? "" : `: ${hook.details.join("; ")}`;
      return `${hook.status} ${hook.name}${id}${exit}${details}`;
    }),
  ].join("\n");
}

function formatHadolint(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  for (const line of sourceLines(text)) {
    const diagnostic = /^(.+):(\d+)\s+([A-Z]+\d+)\s+(error|warning|info):\s+(.+)$/u.exec(line);
    if (diagnostic === null) return null;
    facts.push({
      path: diagnostic[1] ?? "",
      line: diagnostic[2],
      severity: normalizedSeverity(diagnostic[4]),
      code: diagnostic[3],
      message: diagnostic[5] ?? "",
    });
  }
  return formatCompactFacts(facts);
}

function formatMarkdownlint(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  for (const line of sourceLines(text)) {
    const diagnostic = /^(.+):(\d+)(?::(\d+))?\s+([A-Z]+\d+)(?:\/\S+)?\s+(.+)$/u.exec(line);
    if (diagnostic === null) return null;
    facts.push({
      path: diagnostic[1] ?? "",
      line: diagnostic[2],
      column: diagnostic[3],
      severity: "error",
      code: diagnostic[4],
      message: diagnostic[5] ?? "",
    });
  }
  return formatCompactFacts(facts);
}

function formatShellcheck(text: string): string | null {
  const lines = sourceLines(text);
  const facts: DiagnosticFact[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index] === "For more information:") {
      const current = facts.at(-1);
      if (current === undefined) return null;
      const help = lines.slice(index + 1).map((line) => `help: ${line.trim()}`);
      facts[facts.length - 1] = { ...current, context: [...(current.context ?? []), ...help] };
      index = lines.length;
      continue;
    }
    const heading = /^In (.+) line (\d+):$/u.exec(lines[index] ?? "");
    if (heading === null || index + 2 >= lines.length) return null;
    const source = lines[index + 1] ?? "";
    const marker = lines[index + 2] ?? "";
    const detail = /^\s*\^[-^]*\^?\s+([A-Z]+\d+)\s+\(([^)]+)\):\s+(.+)$/u.exec(marker);
    if (detail === null) return null;
    facts.push({
      path: heading[1] ?? "",
      line: heading[2],
      severity: normalizedSeverity(detail[2]),
      code: detail[1],
      message: detail[3] ?? "",
      context: [source, marker.slice(0, marker.indexOf(detail[1] ?? "")).trimEnd()],
    });
    index += 3;
  }
  return formatCompactFacts(facts);
}

function formatYamllint(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  let path: string | null = null;
  for (const line of sourceLines(text)) {
    const diagnostic = /^\s*(\d+):(\d+)\s+(warning|error)\s+(.+?)\s+\(([^)]+)\)$/u.exec(line);
    if (diagnostic !== null && path !== null) {
      facts.push({
        path,
        line: diagnostic[1],
        column: diagnostic[2],
        severity: normalizedSeverity(diagnostic[3]),
        code: diagnostic[5],
        message: diagnostic[4] ?? "",
      });
      continue;
    }
    if (!/^\s/u.test(line)) {
      path = line;
      continue;
    }
    return null;
  }
  return formatCompactFacts(facts);
}
