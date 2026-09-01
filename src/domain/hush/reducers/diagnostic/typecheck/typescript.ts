/** TypeScript compiler diagnostic parsing. */

import { shortestText } from "../../shared/text.ts";
import {
  formatFlatDiagnostic,
  formatGroupedDiagnostics,
  integer,
  location,
  severity,
  type TypecheckDiagnostic,
  typecheckSummary,
} from "./shared.ts";

const DIAGNOSTIC = /^(.+)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/u;
const SUMMARY =
  /^Found\s+(\d+)\s+errors?(?:\s+in\s+(\d+)\s+files?)?\.?(?:\s+Watching for file changes\.)?$/u;

export function formatTypescriptDiagnostics(lines: readonly string[]): string | null {
  const diagnostics: TypecheckDiagnostic[] = [];
  let reportedErrors: number | null = null;
  let reportedFiles: number | null = null;
  for (const line of lines) {
    const match = DIAGNOSTIC.exec(line);
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
    const summary = SUMMARY.exec(line);
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
  if (diagnostics.length === 0) return reportedErrors === 0 ? "0 errors" : null;
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
