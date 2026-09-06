/** Shared structures for complete, uncapped lint and format projections. */

export type DiagnosticSeverity = "error" | "info" | "warning";

export type DiagnosticFact = Readonly<{
  path: string;
  line?: string | undefined;
  column?: string | undefined;
  severity: DiagnosticSeverity;
  code?: string | undefined;
  message: string;
  context?: readonly string[] | undefined;
}>;

export function sourceLines(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/u, "").trimEnd())
    .filter((line) => line.trim().length > 0);
}

export function formatFacts(facts: readonly DiagnosticFact[], summary?: string): string | null {
  if (facts.length === 0) return summary ?? null;
  const output = facts.flatMap((fact) => {
    const position =
      fact.line === undefined
        ? fact.path
        : `${fact.path}:${fact.line}${fact.column === undefined ? "" : `:${fact.column}`}`;
    const code = fact.code === undefined || fact.code.length === 0 ? "" : `[${fact.code}]`;
    return [
      `${position} ${fact.severity}${code}: ${fact.message}`,
      ...(fact.context ?? []).map((line) => `  ${line}`),
    ];
  });
  return summary === undefined ? output.join("\n") : [summary, ...output].join("\n");
}

export function formatCompactFacts(facts: readonly DiagnosticFact[]): string | null {
  if (facts.length === 0) return null;
  return facts
    .map((fact) => {
      const severity = fact.severity === "error" ? "E" : fact.severity === "warning" ? "W" : "I";
      const code = fact.code === undefined || fact.code.length === 0 ? "" : `[${fact.code}]`;
      const position = `${fact.path}${fact.line === undefined ? "" : `:${fact.line}${fact.column === undefined ? "" : `:${fact.column}`}`}`;
      const context = (fact.context ?? []).map((line) => `\n  ${line}`).join("");
      return `${severity}${code} ${position} ${fact.message}${context}`;
    })
    .join("\n");
}

export function diagnosticSummary(facts: readonly DiagnosticFact[], suffix?: string): string {
  const errors = facts.filter((fact) => fact.severity === "error").length;
  const warnings = facts.filter((fact) => fact.severity === "warning").length;
  const infos = facts.filter((fact) => fact.severity === "info").length;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} ${plural(errors, "error")}`);
  if (warnings > 0) parts.push(`${warnings} ${plural(warnings, "warning")}`);
  if (infos > 0) parts.push(`${infos} ${plural(infos, "info")}`);
  if (parts.length === 0) parts.push("0 issues");
  return suffix === undefined ? parts.join(", ") : `${parts.join(", ")} ${suffix}`;
}

export function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

export function normalizedSeverity(value: string | undefined): DiagnosticSeverity {
  const normalized = value?.toLowerCase();
  if (normalized === "warning" || normalized === "warn" || normalized === "w") {
    return "warning";
  }
  if (normalized === "info" || normalized === "information" || normalized === "note") {
    return "info";
  }
  return "error";
}

export function sameCount(reported: number | undefined, actual: number): boolean {
  return reported === undefined || reported === actual;
}

export function integer(value: string | undefined): number {
  return Number.parseInt(value ?? "0", 10);
}
