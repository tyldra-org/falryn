/** Pytest output reduction. */

import { drop, keep, projectTestLines, replace } from "../shared.ts";

export function formatPytest(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (
      /^(?:=+ test session starts =+|platform |rootdir:|plugins:|collected \d+ items?|=+ FAILURES =+|=+ short test summary info =+)$/u.test(
        line,
      )
    ) {
      return drop();
    }
    if (
      /::[^\s]+\s+PASSED(?:\s+\[\s*\d+%\])?$/u.test(line) ||
      /^\.+\s*\[?\s*\d+%\]?$/u.test(line)
    ) {
      return drop();
    }
    const summary = /^(?:=+\s*)?(.+?)(?:\s+in\s+([\d.]+s))(?:\s*=+)?$/u.exec(line);
    if (
      summary !== null &&
      /\b(?:passed|failed|skipped|xfailed|xpassed|errors?|warnings?)\b/u.test(summary[1] ?? "")
    ) {
      return replace(`${summary[1]?.replace(/,\s*/gu, " ")} ${summary[2]}`.trim());
    }
    return keep();
  });
}
