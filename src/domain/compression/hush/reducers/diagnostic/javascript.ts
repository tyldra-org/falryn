/** Complete projections for JavaScript lint and format commands. */

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

export function formatJavascriptDiagnostics(
  text: string,
  commandTokens: readonly string[],
): string | null {
  const executable = commandTokens[0] ?? "";
  if (executable === "bun" && commandTokens[1] === "run") {
    return formatBunLint(text);
  }
  switch (executable) {
    case "biome":
      return formatBiome(text);
    case "eslint":
      return formatEslint(text);
    case "oxlint":
      return formatOxlint(text);
    case "prettier":
      return formatPrettier(text);
    default:
      return null;
  }
}

function formatBunLint(text: string): string | null {
  const withoutScriptEcho = sourceLines(text)
    .filter((line) => !/^\$\s+\S/u.test(line))
    .join("\n");
  if (withoutScriptEcho.length === 0) return "ok";
  return (
    formatBiome(withoutScriptEcho) ??
    formatEslint(withoutScriptEcho) ??
    formatOxlint(withoutScriptEcho) ??
    formatPrettier(withoutScriptEcho)
  );
}

function formatBiome(text: string): string | null {
  const lines = sourceLines(text);
  const success = /^Checked (\d+) files? in ([^.]+)\. No fixes applied\.$/u.exec(lines.join(" "));
  if (success !== null) return `ok ${success[1]} files ${success[2]?.replace(/\s+/gu, "")}`;

  const facts: DiagnosticFact[] = [];
  let pending: Omit<DiagnosticFact, "message"> | null = null;
  let reportedErrors: number | undefined;
  for (const line of lines) {
    const header = /^(.+):(\d+):(\d+)\s+(\S+)\s+━+$/u.exec(line);
    if (header !== null) {
      if (pending !== null) return null;
      pending = {
        path: header[1] ?? "",
        line: header[2],
        column: header[3],
        severity: "error",
        code: header[4],
      };
      continue;
    }
    const message = /^\s*[×!]\s+(.+)$/u.exec(line);
    if (message !== null && pending !== null) {
      facts.push({ ...pending, message: message[1] ?? "" });
      pending = null;
      continue;
    }
    const checked = /^Checked \d+ files? in .+\. No fixes applied\.$/u.exec(line);
    if (checked !== null) continue;
    const summary = /^Found (\d+) errors?\.?$/u.exec(line);
    if (summary !== null) {
      reportedErrors = integer(summary[1]);
      continue;
    }
    return null;
  }
  if (pending !== null || facts.length === 0 || !sameCount(reportedErrors, facts.length))
    return null;
  const files = new Set(facts.map((fact) => fact.path)).size;
  return formatFacts(
    facts,
    diagnosticSummary(facts, `in ${files} ${files === 1 ? "file" : "files"}`),
  );
}

function formatEslint(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  let path: string | null = null;
  let reported: readonly [number, number, number] | null = null;
  for (const line of sourceLines(text)) {
    const summary = /^✖ (\d+) problems? \((\d+) errors?, (\d+) warnings?\)$/u.exec(line);
    if (summary !== null) {
      reported = [integer(summary[1]), integer(summary[2]), integer(summary[3])];
      continue;
    }
    const diagnostic = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+(\S+)$/u.exec(line);
    if (diagnostic !== null && path !== null) {
      facts.push({
        path,
        line: diagnostic[1],
        column: diagnostic[2],
        severity: normalizedSeverity(diagnostic[3]),
        message: diagnostic[4] ?? "",
        code: diagnostic[5],
      });
      continue;
    }
    if (!/^\s/u.test(line) && !line.startsWith("✖")) {
      path = line;
      continue;
    }
    return null;
  }
  if (facts.length === 0) return null;
  const errors = facts.filter((fact) => fact.severity === "error").length;
  const warnings = facts.length - errors;
  if (
    reported !== null &&
    (reported[0] !== facts.length || reported[1] !== errors || reported[2] !== warnings)
  ) {
    return null;
  }
  return formatCompactFacts(facts);
}

function formatOxlint(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  let reported: readonly [number, number] | null = null;
  for (const line of sourceLines(text)) {
    const diagnostic = /^(.+):(\d+):(\d+):\s+(error|warning|info)\s+([^:]+):\s+(.+)$/u.exec(line);
    if (diagnostic !== null) {
      facts.push({
        path: diagnostic[1] ?? "",
        line: diagnostic[2],
        column: diagnostic[3],
        severity: normalizedSeverity(diagnostic[4]),
        code: diagnostic[5]?.trim(),
        message: diagnostic[6] ?? "",
      });
      continue;
    }
    const summary = /^Found (\d+) warnings? and (\d+) errors?\.?$/u.exec(line);
    if (summary !== null) {
      reported = [integer(summary[1]), integer(summary[2])];
      continue;
    }
    return null;
  }
  if (facts.length === 0) return null;
  const warnings = facts.filter((fact) => fact.severity === "warning").length;
  const errors = facts.filter((fact) => fact.severity === "error").length;
  if (reported !== null && (reported[0] !== warnings || reported[1] !== errors)) return null;
  return formatCompactFacts(facts);
}

function formatPrettier(text: string): string | null {
  const paths: string[] = [];
  let reported: number | undefined;
  for (const line of sourceLines(text)) {
    if (line === "Checking formatting...") continue;
    const path = /^\[warn\]\s+(.+)$/u.exec(line);
    if (path !== null && !path[1]?.startsWith("Code style issues")) {
      paths.push(path[1] ?? "");
      continue;
    }
    const summary = /^\[warn\] Code style issues found in (\d+) files?\..+$/u.exec(line);
    if (summary !== null) {
      reported = integer(summary[1]);
      continue;
    }
    if (line === "All matched files use Prettier code style!") return "ok";
    return null;
  }
  if (paths.length === 0 || !sameCount(reported, paths.length)) return null;
  return [`fmt ${paths.length}`, ...paths].join("\n");
}
