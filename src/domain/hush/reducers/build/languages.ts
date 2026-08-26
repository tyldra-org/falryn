/** Complete projections for language ecosystem build commands. */

import { buildLines, compactDuration, countedList } from "./shared.ts";

export function formatLanguageBuild(text: string, commandTokens: readonly string[]): string | null {
  switch (commandTokens[0] ?? "") {
    case "cargo":
      return formatCargoBuild(text, commandTokens);
    case "go":
      return text.length === 0 ? "" : null;
    case "gradle":
    case "gradlew":
      return formatGradleBuild(text, commandTokens);
    case "mvn":
    case "mvnw":
      return formatMavenBuild(text, commandTokens);
    case "sbt":
      return formatSbtBuild(text, commandTokens);
    case "dotnet":
      return formatDotnetBuild(text, commandTokens);
    case "swift":
      return formatSwiftBuild(text);
    case "xcodebuild":
      return formatXcodeBuild(text);
    case "mix":
      return formatMixBuild(text);
    default:
      return null;
  }
}

function formatCargoBuild(text: string, commandTokens: readonly string[]): string | null {
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

function formatGradleBuild(text: string, commandTokens: readonly string[]): string | null {
  const tasks: string[] = [];
  let duration: string | undefined;
  let actionable: string | undefined;
  let executed: string | undefined;
  for (const line of buildLines(text)) {
    const task = /^> Task (:\S+)(?:\s+(?:UP-TO-DATE|FROM-CACHE|NO-SOURCE))?$/u.exec(line);
    if (task !== null) {
      tasks.push(task[1] ?? "");
      continue;
    }
    const result = /^BUILD SUCCESSFUL in (.+)$/u.exec(line);
    if (result !== null) {
      duration = result[1];
      continue;
    }
    const summary = /^(\d+) actionable tasks?:\s+(\d+) executed(?:,.*)?$/u.exec(line);
    if (summary !== null) {
      actionable = summary[1];
      executed = summary[2];
      continue;
    }
    return null;
  }
  if (
    duration === undefined ||
    actionable === undefined ||
    executed === undefined ||
    tasks.length === 0
  ) {
    return null;
  }
  const action =
    commandTokens.find((token, index) => index > 0 && !token.startsWith("-")) ?? "build";
  return [
    `ok gradle ${action} ${compactDuration(duration)} ${executed}/${actionable} tasks`,
    countedList("ran", tasks),
  ].join("\n");
}

function formatMavenBuild(text: string, commandTokens: readonly string[]): string | null {
  let artifact: string | undefined;
  let packaging: string | undefined;
  let duration: string | undefined;
  let result = false;
  for (const line of buildLines(text)) {
    if (/^\[INFO\] (?:Scanning for projects\.\.\.|--- .* ---|-{4,})$/u.test(line)) continue;
    const project = /^\[INFO\] Building\s+([^\s]+)\s+([^\s]+)$/u.exec(line);
    if (project !== null) {
      artifact = `${project[1]}@${project[2]}`;
      continue;
    }
    const packageType = /^\[INFO\] Packaging:\s+(.+)$/u.exec(line);
    if (packageType !== null) {
      packaging = packageType[1];
      continue;
    }
    if (line === "[INFO] BUILD SUCCESS") {
      result = true;
      continue;
    }
    const total = /^\[INFO\] Total time:\s+(.+)$/u.exec(line);
    if (total !== null) {
      duration = total[1];
      continue;
    }
    if (/^\[INFO\] Finished at:/u.test(line)) continue;
    return null;
  }
  if (!result || artifact === undefined || packaging === undefined || duration === undefined)
    return null;
  const action =
    commandTokens.find((token, index) => index > 0 && !token.startsWith("-")) ?? "build";
  return `ok maven ${action} ${artifact} ${packaging} ${compactDuration(duration)}`;
}

function formatSbtBuild(text: string, commandTokens: readonly string[]): string | null {
  let version: string | undefined;
  let compiled: string | undefined;
  let duration: string | undefined;
  for (const line of buildLines(text)) {
    const welcome = /^\[info\] welcome to sbt (\S+)/u.exec(line);
    if (welcome !== null) {
      version = welcome[1];
      continue;
    }
    const compiling = /^\[info\] compiling (\d+) .+ sources?/u.exec(line);
    if (compiling !== null) {
      compiled = compiling[1];
      continue;
    }
    const success = /^\[success\] Total time:\s+([^,]+),/u.exec(line);
    if (success !== null) {
      duration = success[1];
      continue;
    }
    return null;
  }
  if (version === undefined || duration === undefined) return null;
  const action = commandTokens[1] ?? "compile";
  return `ok sbt ${action} ${compactDuration(duration)} v${version}${compiled === undefined ? "" : ` ${compiled} sources`}`;
}

function formatDotnetBuild(text: string, commandTokens: readonly string[]): string | null {
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

function formatMixBuild(text: string): string | null {
  let files: string | undefined;
  let app: string | undefined;
  for (const line of buildLines(text)) {
    const compiling = /^Compiling (\d+) files? \(.+\)$/u.exec(line);
    if (compiling !== null) {
      files = compiling[1];
      continue;
    }
    const generated = /^Generated (\S+) app$/u.exec(line);
    if (generated !== null) {
      app = generated[1];
      continue;
    }
    return null;
  }
  return files === undefined || app === undefined ? null : `ok mix ${app} ${files} files`;
}
