/** Complete projections for JavaScript and Bun test runners. */

import { countSummary, drop, executable, keep, projectTestLines, replace } from "./shared.ts";

export function formatJavascriptTests(
  text: string,
  commandTokens: readonly string[],
): string | null {
  switch (executable(commandTokens)) {
    case "jest":
      return formatJest(text);
    case "vitest":
      return formatVitest(text);
    case "playwright":
      return formatPlaywright(text);
    case "mocha":
      return formatMocha(text);
    case "bun":
      return commandTokens[1] === "test" ? formatBun(text) : null;
    default:
      return null;
  }
}

function formatJest(text: string): string | null {
  let tests: RegExpExecArray | null = null;
  let duration: string | undefined;
  const projected = projectTestLines(text, (line) => {
    const match =
      /^Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(\d+) passed,\s*\d+ total$/u.exec(line);
    if (match !== null) {
      tests = match;
      return drop();
    }
    if (/^(?:PASS|Test Suites:|Snapshots:|Ran all test suites)/u.test(line)) {
      return drop();
    }
    const time = /^Time:\s+([\d.]+)\s*s/u.exec(line);
    if (time !== null) {
      duration = `${time[1]}s`;
      return drop();
    }
    if (/^\s*[✓✔]\s+/u.test(line)) {
      return drop();
    }
    return keep();
  });
  if (projected === null || tests === null) {
    return null;
  }
  const summary = countSummary(tests[3] ?? "0", tests[1], tests[2], duration);
  return appendSummary(projected, summary);
}

function formatVitest(text: string): string | null {
  let tests: RegExpExecArray | null = null;
  const projected = projectTestLines(text, (line) => {
    if (/^\s*(?:RUN|Test Files|Start at|Duration)\b/u.test(line)) {
      return drop();
    }
    const match =
      /^\s*Tests\s+(?:(\d+) failed\s*\|\s*)?(?:(\d+) skipped\s*\|\s*)?(\d+) passed/u.exec(line);
    if (match !== null) {
      tests = match;
      return drop();
    }
    if (/^\s*[✓✔]\s+.*\(\d+ tests?\)/u.test(line)) {
      return drop();
    }
    return keep();
  });
  if (projected === null || tests === null) {
    return null;
  }
  return appendSummary(projected, countSummary(tests[3] ?? "0", tests[1], tests[2]));
}

function formatPlaywright(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (/^Running \d+ tests? using \d+ workers?$/u.test(line) || /^\s*[✓✔]\s+/u.test(line)) {
      return drop();
    }
    const summary =
      /^\s*(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(\d+) passed\s+\(([^)]+)\)$/u.exec(line);
    return summary === null
      ? keep()
      : replace(countSummary(summary[3] ?? "0", summary[1], summary[2], summary[4]));
  });
}

function formatMocha(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (/^\s*[✓✔]\s+/u.test(line)) {
      return drop();
    }
    const summary = /^\s*(\d+) passing\s+\(([^)]+)\)$/u.exec(line);
    return summary === null
      ? keep()
      : replace(countSummary(summary[1] ?? "0", undefined, undefined, summary[2]));
  });
}

function formatBun(text: string): string | null {
  let passed: string | undefined;
  let failed: string | undefined;
  let duration: string | undefined;
  const projected = projectTestLines(text, (line) => {
    if (/^bun test v/u.test(line) || /^\s*[✓✔]\s+/u.test(line)) {
      return drop();
    }
    const pass = /^\s*(\d+) pass$/u.exec(line);
    if (pass !== null) {
      passed = pass[1];
      return drop();
    }
    const fail = /^\s*(\d+) fail$/u.exec(line);
    if (fail !== null) {
      failed = fail[1];
      return drop();
    }
    if (/^\s*\d+ expect\(\) calls$/u.test(line)) {
      return drop();
    }
    const ran = /^Ran \d+ tests? across \d+ files?\.\s*\[([^\]]+)\]$/u.exec(line);
    if (ran !== null) {
      duration = ran[1];
      return drop();
    }
    return keep();
  });
  if (projected === null || passed === undefined || failed === undefined) {
    return null;
  }
  return appendSummary(projected, countSummary(passed, failed, undefined, duration));
}

function appendSummary(details: string, summary: string): string {
  return details.length === 0 ? summary : `${details}\n${summary}`;
}
