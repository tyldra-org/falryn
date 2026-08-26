/** Git show projection that reuses the complete unified-diff validator. */

import { formatGitUnifiedDiff } from "../diff/format.ts";
import { formatGitDiffStat } from "../diff/stat.ts";
import { parseNativeGitCommit, renderNativeGitCommit } from "./commit.ts";
import { sourceLines } from "./format.ts";

export function formatNativeGitShow(source: string, arguments_: readonly string[]): string | null {
  const lines = sourceLines(source);
  if (lines === null || lines.length === 0) {
    return null;
  }
  const parsed = parseNativeGitCommit(lines, 0);
  if (parsed === null) {
    return null;
  }

  const summary = renderNativeGitCommit(parsed.commit);
  const remainder = lines.slice(parsed.nextLine);
  if (remainder.length === 0) {
    return source.endsWith("\n") ? `${summary}\n` : summary;
  }

  const tail = `${remainder.join("\n")}${source.endsWith("\n") ? "\n" : ""}`;
  const formatted = remainder[0]?.startsWith("diff --git ")
    ? formatGitUnifiedDiff(tail)
    : requestsDiffStat(arguments_)
      ? formatGitDiffStat(tail)
      : null;
  return formatted === null ? null : `${summary}\n${formatted}`;
}

function requestsDiffStat(arguments_: readonly string[]): boolean {
  return arguments_.some(
    (argument) =>
      argument === "--stat" || argument.startsWith("--stat=") || argument === "--shortstat",
  );
}
