/** Go test output reduction. */

import { countSummary, drop, keep, projectTestLines } from "../shared.ts";

export function formatGoTests(text: string): string | null {
  let passed = 0;
  let failed = 0;
  const packages = new Set<string>();
  let duration: string | undefined;
  const projected = projectTestLines(text, (line) => {
    if (/^=== RUN\s+/u.test(line)) return drop();
    if (/^--- PASS:/u.test(line)) {
      passed += 1;
      return drop();
    }
    if (/^--- FAIL:/u.test(line)) {
      failed += 1;
      return keep();
    }
    if (line === "PASS" || line === "FAIL") return drop();
    const packageLine = /^(?:ok|FAIL)\s+(\S+)\s+([\d.]+s)$/u.exec(line);
    if (packageLine !== null) {
      packages.add(packageLine[1] ?? "");
      duration = packageLine[2];
      return drop();
    }
    return keep();
  });
  if (projected === null || passed + failed === 0 || packages.size === 0) return null;
  const packageLabel = `${packages.size} ${packages.size === 1 ? "package" : "packages"}`;
  const summary = `${countSummary(String(passed), String(failed))} ${packageLabel}${packages.size === 1 && duration !== undefined ? ` ${duration}` : ""}`;
  return projected.length === 0 ? summary : `${projected}\n${summary}`;
}
