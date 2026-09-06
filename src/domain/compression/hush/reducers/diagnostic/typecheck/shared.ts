/** Shared facts and formatting for type-checker parsers. */

export type DiagnosticSeverity = "error" | "information" | "warning";

export type Location = Readonly<{ path: string; line: number; column: number }>;

export type TypecheckDiagnostic = Readonly<{
  location: Location;
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  context: readonly string[];
}>;

export function formatFlatDiagnostic(diagnostic: TypecheckDiagnostic): readonly string[] {
  const rule = diagnostic.code.length > 0 ? `[${diagnostic.code}]` : "";
  return [
    `${diagnostic.location.path}:${diagnostic.location.line}:${diagnostic.location.column} ${diagnostic.severity}${rule}: ${diagnostic.message}`,
    ...diagnostic.context.map((line) => `  ${line}`),
  ];
}

export function formatGroupedDiagnostics(
  diagnostics: readonly TypecheckDiagnostic[],
): readonly string[] {
  const grouped = new Map<string, TypecheckDiagnostic[]>();
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

export function countsBySeverity(
  diagnostics: readonly TypecheckDiagnostic[],
): Readonly<Record<DiagnosticSeverity, number>> {
  const counts = { error: 0, information: 0, warning: 0 };
  for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
  return counts;
}

export function typecheckSummary(errors: number, warnings: number, files: number): string {
  const warning = warnings === 0 ? "" : `, ${warnings} ${plural(warnings, "warning")}`;
  return `${errors} ${plural(errors, "error")}${warning} in ${files} ${plural(files, "file")}`;
}

export function looksLikePythonPath(line: string): boolean {
  return !/^\s/u.test(line) && /(?:^|[\\/])[^\\/]+\.pyi?$/u.test(line);
}

export function location(
  path: string | undefined,
  line: string | undefined,
  column: string | undefined,
): Location {
  return { path: path ?? "", line: integer(line), column: integer(column) };
}

export function severity(value: string | undefined): DiagnosticSeverity {
  return value === "warning" || value === "information" ? value : "error";
}

export function integer(value: string | undefined): number {
  return Number.parseInt(value ?? "0", 10);
}

export function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
