/** JVM build output parsing. */

import { buildLines, compactDuration, countedList } from "../shared.ts";

export function formatJvmBuild(text: string, commandTokens: readonly string[]): string | null {
  switch (commandTokens[0] ?? "") {
    case "gradle":
    case "gradlew":
      return formatGradleBuild(text, commandTokens);
    case "mvn":
    case "mvnw":
      return formatMavenBuild(text, commandTokens);
    case "sbt":
      return formatSbtBuild(text, commandTokens);
    default:
      return null;
  }
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
