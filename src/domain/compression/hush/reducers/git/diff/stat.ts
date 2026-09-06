/** Presentation-only compaction for complete Git diff-stat output. */

const SHORTSTAT =
  /^\s*\d+ files? changed(?:, \d+ insertions?\(\+\))?(?:, \d+ deletions?\(-\))?\s*$/u;

export function formatGitDiffStat(source: string): string | null {
  if (!source.endsWith("\n") || source.includes("\r") || source.includes("\0")) {
    return null;
  }
  const lines = source.slice(0, -1).split("\n");
  const summary = lines.at(-1) ?? "";
  return SHORTSTAT.test(summary) ? lines.join("\n") : null;
}
