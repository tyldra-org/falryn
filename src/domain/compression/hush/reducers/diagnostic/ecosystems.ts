/** Complete projections for .NET, Elixir, PHP, and Ruby diagnostics. */

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

export function formatEcosystemDiagnostics(
  text: string,
  commandTokens: readonly string[],
): string | null {
  switch (commandTokens[0] ?? "") {
    case "dotnet":
      return formatDotnet(text);
    case "mix":
      return formatMix(text);
    case "phpstan":
      return formatPhpstan(text);
    case "ecs":
      return formatEcs(text);
    case "pint":
      return formatPint(text);
    case "rubocop":
      return formatRubocop(text);
    default:
      return null;
  }
}

function formatDotnet(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  let duration: string | undefined;
  for (const line of sourceLines(text)) {
    const diagnostic = /^(.+)\((\d+),(\d+)\):\s+(warning|error)\s+([^:]+):\s+(.+)$/u.exec(line);
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
    const complete = /^Format complete in (.+)\.$/u.exec(line);
    if (complete !== null) {
      duration = complete[1]?.replace(/\s+/gu, "");
      continue;
    }
    return null;
  }
  if (facts.length === 0) return duration === undefined ? null : `ok ${duration}`;
  return formatFacts(facts, diagnosticSummary(facts, duration));
}

function formatMix(text: string): string | null {
  const paths: string[] = [];
  let recognized = false;
  for (const line of sourceLines(text)) {
    if (/^\*\* \(Mix\) mix format failed due to --check-formatted\.?$/u.test(line)) {
      recognized = true;
      continue;
    }
    if (line === "The following files are not formatted:") {
      recognized = true;
      continue;
    }
    const path = /^\s*\*\s+(.+)$/u.exec(line);
    if (path !== null) {
      paths.push(path[1] ?? "");
      continue;
    }
    return null;
  }
  if (!recognized || paths.length === 0) return null;
  return [`${paths.length} files need formatting`, ...paths].join("\n");
}

function formatPhpstan(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  let path: string | undefined;
  let pending: Readonly<{ line: string; message: string }> | undefined;
  let reported: number | undefined;
  const flush = (code?: string): boolean => {
    if (pending === undefined) return true;
    if (path === undefined) return false;
    facts.push({ path, line: pending.line, severity: "error", code, message: pending.message });
    pending = undefined;
    return true;
  };

  for (const line of sourceLines(text)) {
    if (/^\s*-{3,}/u.test(line)) continue;
    const heading = /^\s*Line\s+(.+)$/u.exec(line);
    if (heading !== null) {
      if (!flush()) return null;
      path = heading[1]?.trim();
      continue;
    }
    const diagnostic = /^\s*(\d+)\s{2,}(.+)$/u.exec(line);
    if (diagnostic !== null) {
      if (!flush()) return null;
      pending = { line: diagnostic[1] ?? "", message: diagnostic[2] ?? "" };
      continue;
    }
    const identifier = /^\s*🪪\s+(.+)$/u.exec(line);
    if (identifier !== null && pending !== undefined) {
      if (!flush(identifier[1])) return null;
      continue;
    }
    const summary = /^\s*\[ERROR\] Found (\d+) errors?$/u.exec(line);
    if (summary !== null) {
      if (!flush()) return null;
      reported = integer(summary[1]);
      continue;
    }
    return null;
  }
  if (!flush() || facts.length === 0 || !sameCount(reported, facts.length)) return null;
  return formatCompactFacts(facts);
}

function formatEcs(text: string): string | null {
  let recognized = false;
  const output: string[] = [];
  for (const line of sourceLines(text)) {
    const summary = /^(\d+) files? with errors?$/u.exec(line);
    if (summary !== null) {
      recognized = true;
      output.push(`${summary[1]} files need formatting`);
      continue;
    }
    if (/^=+$/u.test(line) || /^\s*-+ (?:begin|end) diff -+$/u.test(line)) {
      recognized = true;
      continue;
    }
    const path = /^\d+\)\s+(.+)$/u.exec(line);
    if (path !== null) {
      recognized = true;
      output.push(path[1] ?? "");
      continue;
    }
    output.push(line);
  }
  return recognized ? output.join("\n") : null;
}

function formatPint(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  let files: number | undefined;
  let issues: number | undefined;
  for (const line of sourceLines(text)) {
    if (/^[⨯×.]+$/u.test(line.trim()) || /^─+\s+Laravel/u.test(line.trim())) continue;
    const summary = /^FAIL\s+.+?\s+(\d+) files?, (\d+) style issues?$/u.exec(line.trim());
    if (summary !== null) {
      files = integer(summary[1]);
      issues = integer(summary[2]);
      continue;
    }
    const diagnostic = /^\s*[⨯×]\s+(.+?)\s{2,}(.+)$/u.exec(line);
    if (diagnostic !== null) {
      facts.push({
        path: diagnostic[1] ?? "",
        severity: "error",
        code: diagnostic[2]?.replace(/,\s*/gu, ","),
        message: "formatting differs",
      });
      continue;
    }
    return null;
  }
  if (
    facts.length === 0 ||
    !sameCount(files, new Set(facts.map((fact) => fact.path)).size) ||
    !sameCount(issues, facts.length)
  ) {
    return null;
  }
  return facts.map((fact) => `${fact.path} [${fact.code ?? "format"}]`).join("\n");
}

function formatRubocop(text: string): string | null {
  const facts: DiagnosticFact[] = [];
  let reported: readonly [number, number, number] | null = null;
  for (const line of sourceLines(text)) {
    if (/^(?:Inspecting \d+ files?|Offenses:|[CWEF.]+)$/u.test(line)) continue;
    const diagnostic =
      /^(.+):(\d+):(\d+):\s+([CWEF]):\s+(?:\[Correctable\]\s+)?([^:]+):\s+(.+)$/u.exec(line);
    if (diagnostic !== null) {
      facts.push({
        path: diagnostic[1] ?? "",
        line: diagnostic[2],
        column: diagnostic[3],
        severity: diagnostic[4] === "C" || diagnostic[4] === "W" ? "warning" : "error",
        code: diagnostic[5],
        message: diagnostic[6] ?? "",
      });
      continue;
    }
    const summary =
      /^(\d+) files? inspected, (\d+) offenses? detected, (\d+) offenses? autocorrectable$/u.exec(
        line,
      );
    if (summary !== null) {
      reported = [integer(summary[1]), integer(summary[2]), integer(summary[3])];
      continue;
    }
    return null;
  }
  if (facts.length === 0 || (reported !== null && reported[1] !== facts.length)) return null;
  const suffix = reported === null ? undefined : `${reported[0]} files, ${reported[2]} correctable`;
  return formatFacts(facts, diagnosticSummary(facts, suffix));
}
