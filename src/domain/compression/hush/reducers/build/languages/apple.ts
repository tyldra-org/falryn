/** Swift and Xcode build output parsing. */

import { buildLines, compactDuration, countedList } from "../shared.ts";

export function formatAppleBuild(text: string, commandTokens: readonly string[]): string | null {
  return commandTokens[0] === "swift" ? formatSwiftBuild(text) : formatXcodeBuild(text);
}

function formatSwiftBuild(text: string): string | null {
  let mode: string | undefined;
  let duration: string | undefined;
  let total: string | undefined;
  const steps: string[] = [];
  for (const line of buildLines(text)) {
    const heading = /^Building for (.+)\.\.\.$/u.exec(line);
    if (heading !== null) {
      mode = heading[1];
      continue;
    }
    const step = /^\[(\d+)\/(\d+)\]\s+(.+)$/u.exec(line);
    if (step !== null) {
      total = step[2];
      steps.push(step[3] ?? "");
      continue;
    }
    const complete = /^Build complete! \((.+)\)$/u.exec(line);
    if (complete !== null) {
      duration = complete[1];
      continue;
    }
    return null;
  }
  if (mode === undefined || duration === undefined || total === undefined || steps.length === 0)
    return null;
  return [
    `ok swift ${mode} ${compactDuration(duration)} ${total} steps`,
    countedList("ran", steps),
  ].join("\n");
}

function formatXcodeBuild(text: string): string | null {
  let target: string | undefined;
  const actions: string[] = [];
  let succeeded = false;
  for (const line of buildLines(text)) {
    if (/^(?:Command line invocation|Build settings from command line):$/u.test(line)) continue;
    if (/^\s+\/.*xcodebuild/u.test(line) || /^\s+\S+\s*=\s*\S+/u.test(line)) continue;
    const heading = /^=== BUILD TARGET (\S+) OF PROJECT (\S+) ===$/u.exec(line);
    if (heading !== null) {
      target = `${heading[2]}/${heading[1]}`;
      continue;
    }
    const action = /^(CompileSwift|Ld)\s+(.+)$/u.exec(line);
    if (action !== null) {
      actions.push(`${action[1]} ${action[2]}`);
      continue;
    }
    if (line === "** BUILD SUCCEEDED **") {
      succeeded = true;
      continue;
    }
    return null;
  }
  if (!succeeded || target === undefined || actions.length === 0) return null;
  return [`ok xcode ${target}`, ...actions].join("\n");
}
