/** Rust build output parsing. */

import { buildLines, compactDuration, countedList } from "../shared.ts";

export function formatRustBuild(text: string, commandTokens: readonly string[]): string | null {
  if (commandTokens[1] === "install") return formatCargoInstall(text);
  const compiled: string[] = [];
  let profile: string | undefined;
  let duration: string | undefined;
  for (const line of buildLines(text)) {
    const progress = /^\s*(?:Compiling|Checking)\s+([^\s]+)(?:\s+v([^\s]+))?.*$/u.exec(line);
    if (progress !== null) {
      compiled.push(`${progress[1]}${progress[2] === undefined ? "" : `@${progress[2]}`}`);
      continue;
    }
    const finished = /^\s*Finished\s+`?([^`]+?)`?\s+(?:profile\s+)?target\(s\)\s+in\s+(.+)$/u.exec(
      line,
    );
    if (finished !== null) {
      profile = finished[1]?.trim();
      duration = finished[2];
      continue;
    }
    return null;
  }
  if (profile === undefined || duration === undefined) return null;
  return [
    `ok cargo ${profile} ${compactDuration(duration)}`,
    ...(compiled.length === 0 ? [] : [countedList("compiled", compiled)]),
  ].join("\n");
}

function formatCargoInstall(text: string): string | null {
  let packageName: string | undefined;
  let version: string | undefined;
  let binary: string | undefined;
  let duration: string | undefined;
  let compiled = 0;
  for (const line of buildLines(text)) {
    if (/^\s*(?:Updating|Downloaded)\b/u.test(line)) continue;
    const installing = /^\s*Installing\s+([^\s]+)\s+v([^\s]+)/u.exec(line);
    if (installing !== null) {
      packageName = installing[1];
      version = installing[2];
      continue;
    }
    if (/^\s*Compiling\s+/u.test(line)) {
      compiled += 1;
      continue;
    }
    const finished = /^\s*Finished\s+.+\s+in\s+(.+)$/u.exec(line);
    if (finished !== null) {
      duration = finished[1];
      continue;
    }
    const executable = /^\s*Installing\s+(.+\/bin\/\S+)$/u.exec(line);
    if (executable !== null) {
      binary = executable[1];
      continue;
    }
    const installed = /^\s*Installed package `([^`]+) v([^`]+)`/u.exec(line);
    if (installed !== null) {
      packageName ??= installed[1];
      version ??= installed[2];
      continue;
    }
    return null;
  }
  if (
    packageName === undefined ||
    version === undefined ||
    binary === undefined ||
    duration === undefined
  ) {
    return null;
  }
  return `ok installed ${packageName}@${version} ${compactDuration(duration)} -> ${binary}; compiled ${compiled}`;
}
