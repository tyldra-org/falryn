/** .NET build output parsing. */

import { buildLines, compactDuration } from "../shared.ts";

export function formatDotnetBuild(text: string, commandTokens: readonly string[]): string | null {
  if (commandTokens[1] === "restore") return formatDotnetRestore(text);
  const artifacts: string[] = [];
  let restored = 0;
  let warnings: string | undefined;
  let errors: string | undefined;
  let duration: string | undefined;
  let succeeded = false;
  for (const line of buildLines(text)) {
    if (/^\s*Determining projects to restore/u.test(line)) continue;
    if (/^\s*(?:All projects are up-to-date for restore|Restored\s+)/u.test(line)) {
      restored += 1;
      continue;
    }
    const artifact = /^\s*(\S+)\s+->\s+(.+)$/u.exec(line);
    if (artifact !== null) {
      artifacts.push(`${artifact[1]} -> ${artifact[2]}`);
      continue;
    }
    if (line.trim() === "Build succeeded.") {
      succeeded = true;
      continue;
    }
    const warning = /^\s*(\d+) Warning\(s\)$/u.exec(line);
    if (warning !== null) {
      warnings = warning[1];
      continue;
    }
    const error = /^\s*(\d+) Error\(s\)$/u.exec(line);
    if (error !== null) {
      errors = error[1];
      continue;
    }
    const elapsed = /^\s*Time Elapsed\s+(.+)$/u.exec(line);
    if (elapsed !== null) {
      duration = elapsed[1];
      continue;
    }
    return null;
  }
  if (!succeeded || warnings === undefined || errors === undefined || duration === undefined)
    return null;
  return [
    `ok dotnet ${compactDuration(duration)} ${warnings}W ${errors}E restored ${restored}`,
    ...artifacts,
  ].join("\n");
}

function formatDotnetRestore(text: string): string | null {
  const restored: string[] = [];
  for (const line of buildLines(text)) {
    if (/^\s*Determining projects to restore/u.test(line)) continue;
    const item = /^\s*Restored\s+(.+?)\s+\(in\s+(.+)\)\.$/u.exec(line);
    if (item !== null) {
      restored.push(`${item[1]} ${compactDuration(item[2])}`);
      continue;
    }
    return null;
  }
  return restored.length === 0 ? null : [`ok restore ${restored.length}`, ...restored].join("\n");
}
