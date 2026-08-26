/** Complete projections for PHP and Ruby test runners. */

import { countSummary, drop, executable, keep, projectTestLines, replace } from "./shared.ts";

export function formatPhpRubyTests(text: string, commandTokens: readonly string[]): string | null {
  switch (executable(commandTokens)) {
    case "phpunit":
    case "pest":
    case "paratest":
      return formatPhp(text);
    case "rake":
    case "rails":
      return formatMinitest(text);
    case "rspec":
      return formatRspec(text);
    default:
      return null;
  }
}

function formatPhp(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (/^(?:PHPUnit|Pest|ParaTest)(?:\s|$)/u.test(line)) return drop();
    if (/^(?:Runtime:|Configuration:|Random Seed:)\s*/u.test(line)) return drop();
    if (/^Time:\s+/u.test(line)) return drop();
    if (/^[.FEWRSIDNOK0-9 /%()-]+$/u.test(line) && line.includes(".")) return drop();
    const ok = /^OK \((\d+) tests?, (\d+) assertions?\)$/u.exec(line);
    if (ok !== null) return replace(`${ok[1]} passed ${ok[2]} assertions`);
    const pest =
      /^Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(\d+) passed\s+\((\d+) assertions?\)$/u.exec(
        line,
      );
    if (pest !== null) {
      return replace(`${countSummary(pest[3] ?? "0", pest[1], pest[2])} ${pest[4]} assertions`);
    }
    const duration = /^Duration:\s+(.+)$/u.exec(line);
    return duration === null ? keep() : replace(duration[1]?.replace(/\s+/gu, "") ?? "");
  });
}

function formatMinitest(text: string): string | null {
  let duration: string | undefined;
  const projected = projectTestLines(text, (line) => {
    if (
      /^(?:Run options:|# Running:|Started with run options)/u.test(line) ||
      /^[.FE]+$/u.test(line)
    )
      return drop();
    const finished = /^Finished in ([\d.]+s),/u.exec(line);
    if (finished !== null) {
      duration = finished[1];
      return drop();
    }
    const summary =
      /^(\d+) (?:runs|tests), (\d+) assertions, (\d+) failures, (\d+) errors, (\d+) skips$/u.exec(
        line,
      );
    if (summary === null) return keep();
    const runs = Number(summary[1] ?? "0");
    const failures = Number(summary[3] ?? "0");
    const errors = Number(summary[4] ?? "0");
    const skips = Number(summary[5] ?? "0");
    const parts = [
      countSummary(String(runs - failures - errors - skips), summary[3], summary[5], duration),
    ];
    if (errors > 0) parts.push(`${errors} errors`);
    return replace(parts.join(" "));
  });
  return projected;
}

function formatRspec(text: string): string | null {
  let duration: string | undefined;
  const projected = projectTestLines(text, (line) => {
    if (/^[.F*]+$/u.test(line)) return drop();
    const finished = /^Finished in (.+?)(?: \(files took .+\))?$/u.exec(line);
    if (finished !== null) {
      duration = finished[1]?.replace(/\s+/gu, "");
      return drop();
    }
    const summary = /^(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?$/u.exec(line);
    if (summary === null) return keep();
    const passed = String(
      Number(summary[1] ?? "0") - Number(summary[2] ?? "0") - Number(summary[3] ?? "0"),
    );
    return replace(countSummary(passed, summary[2], summary[3], duration));
  });
  return projected;
}
