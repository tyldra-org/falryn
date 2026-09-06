/** Gradle, Maven, and sbt test output reduction. */

import { countSummary, drop, keep, projectTestLines, replace } from "../shared.ts";

export function formatJvmTests(text: string, executable: string): string | null {
  switch (executable) {
    case "gradle":
    case "gradlew":
      return formatGradle(text);
    case "mvn":
    case "mvnw":
      return formatMaven(text);
    case "sbt":
      return formatSbt(text);
    default:
      return null;
  }
}

function formatGradle(text: string): string | null {
  const succeeded = text.includes("BUILD SUCCESSFUL");
  return projectTestLines(text, (line) => {
    if (
      (succeeded && /^> Task /u.test(line)) ||
      /^> Task .+ (?:UP-TO-DATE|NO-SOURCE|SKIPPED)$/u.test(line) ||
      /^Starting a Gradle Daemon/u.test(line)
    ) {
      return drop();
    }
    const success = /^BUILD SUCCESSFUL in (.+)$/u.exec(line);
    if (success !== null) return replace(`ok ${success[1]}`);
    const failure = /^BUILD FAILED in (.+)$/u.exec(line);
    if (failure !== null) return replace(`failed ${failure[1]}`);
    if (succeeded && /^\d+ actionable tasks?:/u.test(line)) return drop();
    return keep();
  });
}

function formatMaven(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (
      /^\[INFO\] (?:Scanning for projects|Running |Building |Reactor Summary)/u.test(line) ||
      /^\[INFO\] -+(?:<.*>)?-+$/u.test(line)
    ) {
      return drop();
    }
    const tests =
      /^\[(?:INFO|WARNING|ERROR)\] Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)(?:, Time elapsed: ([\d.]+) s)?(?:.+ in (.+))?$/u.exec(
        line,
      );
    if (tests !== null) {
      const suite = tests[6] === undefined ? "" : ` ${tests[6]}`;
      const passed = String(
        Number(tests[1] ?? "0") -
          Number(tests[2] ?? "0") -
          Number(tests[3] ?? "0") -
          Number(tests[4] ?? "0"),
      );
      const parts = [
        countSummary(
          passed,
          tests[2],
          tests[4],
          tests[5] === undefined ? undefined : `${tests[5]}s`,
        ),
      ];
      if (tests[3] !== "0") parts.push(`${tests[3]} errors`);
      return replace(`${parts.join(" ")}${suite}`);
    }
    const build = /^\[INFO\] BUILD (SUCCESS|FAILURE)$/u.exec(line);
    if (build !== null) return replace(`BUILD ${build[1]}`);
    const time = /^\[INFO\] Total time:\s+(.+)$/u.exec(line);
    return time === null ? keep() : replace(`total ${time[1]?.replace(/\s+/gu, "")}`);
  });
}

function formatSbt(text: string): string | null {
  let summary: string | undefined;
  let duration: string | undefined;
  const projected = projectTestLines(text, (line) => {
    if (/^\[info\] (?:welcome to sbt|loading |set current project|Run completed)/u.test(line)) {
      return drop();
    }
    const tests =
      /^\[info\] Tests: succeeded (\d+), failed (\d+), canceled (\d+), ignored (\d+), pending (\d+)$/u.exec(
        line,
      );
    if (tests !== null) {
      const parts = [countSummary(tests[1] ?? "0", tests[2])];
      if (tests[3] !== "0") parts.push(`${tests[3]} canceled`);
      if (tests[4] !== "0") parts.push(`${tests[4]} ignored`);
      if (tests[5] !== "0") parts.push(`${tests[5]} pending`);
      summary = parts.join(" ");
      return drop();
    }
    if (/^\[info\] Total number of tests run:/u.test(line)) return drop();
    const time = /^\[success\] Total time: (.+)$/u.exec(line);
    if (time !== null) {
      duration = time[1]?.replace(/\s+/gu, "");
      return drop();
    }
    return keep();
  });
  if (projected === null || summary === undefined) return null;
  const finalSummary = `${summary}${duration === undefined ? "" : ` ${duration}`}`;
  return projected.length === 0 ? finalSummary : `${projected}\n${finalSummary}`;
}
