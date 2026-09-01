/** Swift and Xcode test output reduction. */

import { countSummary, drop, keep, projectTestLines, replace } from "../shared.ts";

export function formatAppleTests(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (
      /^(?:Building for debugging|Build complete!|Test Suite '.+' (?:started|passed)|Test Case '.+' (?:started|passed)|\*\* TEST SUCCEEDED \*\*)/u.test(
        line,
      )
    ) {
      return drop();
    }
    const summary =
      /^\s*Executed (\d+) tests?, with (\d+) failures? \((\d+) unexpected\) in ([\d.]+) \([\d.]+\) seconds$/u.exec(
        line,
      );
    if (summary === null) return keep();
    const passed = String(Number(summary[1] ?? "0") - Number(summary[2] ?? "0"));
    const unexpected = summary[3] === "0" ? "" : ` ${summary[3]} unexpected`;
    return replace(`${countSummary(passed, summary[2], undefined, `${summary[4]}s`)}${unexpected}`);
  });
}
