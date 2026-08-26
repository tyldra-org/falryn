/** Complete, uncapped projection for Git's native log presentation. */

import { parseNativeGitCommit, renderNativeGitCommit } from "./commit.ts";

export function formatNativeGitLog(source: string): string | null {
  const lines = sourceLines(source);
  if (lines === null || lines.length === 0) {
    return null;
  }

  const commits: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const parsed = parseNativeGitCommit(lines, index);
    if (parsed === null || parsed.nextLine <= index) {
      return null;
    }
    commits.push(renderNativeGitCommit(parsed.commit));
    index = parsed.nextLine;
    if (index < lines.length && !(lines[index] ?? "").startsWith("commit ")) {
      return null;
    }
  }

  const formatted = commits.join("\n");
  return source.endsWith("\n") ? `${formatted}\n` : formatted;
}

export function sourceLines(source: string): string[] | null {
  if (source.length === 0 || source.includes("\r") || source.includes("\0")) {
    return null;
  }
  const lines = source.split("\n");
  if (source.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}
