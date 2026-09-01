/** .NET test output reduction. */

import { countSummary, drop, keep, projectTestLines, replace } from "../shared.ts";

export function formatDotnetTests(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (
      /^(?:Determining projects to restore|All projects are up-to-date for restore|Test run for |Microsoft \(R\) Test Execution)/u.test(
        line,
      )
    ) {
      return drop();
    }
    const result =
      /^Passed!\s+- Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+), Total:\s+(\d+), Duration:\s+(.+?)(?:\s+- .+)?$/u.exec(
        line,
      );
    return result === null
      ? keep()
      : replace(countSummary(result[2] ?? "0", result[1], result[3], result[5]));
  });
}
