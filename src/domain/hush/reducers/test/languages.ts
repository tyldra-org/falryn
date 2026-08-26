/** Complete projections for language and build-system test runners. */

import { countSummary, drop, executable, keep, projectTestLines, replace } from "./shared.ts";

export function formatLanguageTests(text: string, commandTokens: readonly string[]): string | null {
  switch (executable(commandTokens)) {
    case "pytest":
      return formatPytest(text);
    case "cargo":
      return commandTokens[1] === "nextest" ? formatNextest(text) : formatCargo(text);
    case "go":
      return formatGo(text);
    case "gradle":
    case "gradlew":
      return formatGradle(text);
    case "mvn":
    case "mvnw":
      return formatMaven(text);
    case "sbt":
      return formatSbt(text);
    case "dotnet":
      return formatDotnet(text);
    case "swift":
    case "xcodebuild":
      return formatApple(text);
    default:
      return null;
  }
}

function formatPytest(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (
      /^(?:=+ test session starts =+|platform |rootdir:|plugins:|collected \d+ items?|=+ FAILURES =+|=+ short test summary info =+)$/u.test(
        line,
      )
    ) {
      return drop();
    }
    if (
      /::[^\s]+\s+PASSED(?:\s+\[\s*\d+%\])?$/u.test(line) ||
      /^\.+\s*\[?\s*\d+%\]?$/u.test(line)
    ) {
      return drop();
    }
    const summary = /^(?:=+\s*)?(.+?)(?:\s+in\s+([\d.]+s))(?:\s*=+)?$/u.exec(line);
    if (
      summary !== null &&
      /\b(?:passed|failed|skipped|xfailed|xpassed|errors?|warnings?)\b/u.test(summary[1] ?? "")
    ) {
      return replace(`${summary[1]?.replace(/,\s*/gu, " ")} ${summary[2]}`.trim());
    }
    return keep();
  });
}

function formatCargo(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (
      /^\s*(?:Compiling|Finished|Running|Doc-tests)\b/u.test(line) ||
      /^running \d+ tests?$/u.test(line)
    ) {
      return drop();
    }
    if (/^test .+ \.\.\. ok$/u.test(line)) {
      return drop();
    }
    const summary =
      /^test result:\s+(?:ok|FAILED)\.\s+(\d+) passed;\s+(\d+) failed;\s+(\d+) ignored;\s+(\d+) measured;\s+(\d+) filtered out(?:;\s+finished in ([\d.]+s))?$/u.exec(
        line,
      );
    if (summary === null) {
      return keep();
    }
    const parts = [countSummary(summary[1] ?? "0", summary[2], undefined, summary[6])];
    if (summary[3] !== "0") parts.push(`${summary[3]} ignored`);
    if (summary[4] !== "0") parts.push(`${summary[4]} measured`);
    if (summary[5] !== "0") parts.push(`${summary[5]} filtered`);
    return replace(parts.join(" "));
  });
}

function formatNextest(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (/^\s*(?:Starting|PASS)\b/u.test(line)) {
      return drop();
    }
    const summary =
      /^\s*Summary\s+\[([^\]]+)\]\s+(\d+) tests? run:\s+(\d+) passed(?:,\s+(\d+) failed)?(?:,\s+(\d+) skipped)?$/u.exec(
        line,
      );
    return summary === null
      ? keep()
      : replace(countSummary(summary[3] ?? "0", summary[4], summary[5], summary[1]));
  });
}

function formatGo(text: string): string | null {
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
  return appendSummary(
    projected,
    `${countSummary(String(passed), String(failed))} ${packageLabel}${packages.size === 1 && duration !== undefined ? ` ${duration}` : ""}`,
  );
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
    if (/^\[info\] (?:welcome to sbt|loading |set current project|Run completed)/u.test(line))
      return drop();
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
  return appendSummary(projected, `${summary}${duration === undefined ? "" : ` ${duration}`}`);
}

function formatDotnet(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (
      /^(?:Determining projects to restore|All projects are up-to-date for restore|Test run for |Microsoft \(R\) Test Execution)/u.test(
        line,
      )
    )
      return drop();
    const result =
      /^Passed!\s+- Failed:\s+(\d+), Passed:\s+(\d+), Skipped:\s+(\d+), Total:\s+(\d+), Duration:\s+(.+?)(?:\s+- .+)?$/u.exec(
        line,
      );
    return result === null
      ? keep()
      : replace(countSummary(result[2] ?? "0", result[1], result[3], result[5]));
  });
}

function formatApple(text: string): string | null {
  return projectTestLines(text, (line) => {
    if (
      /^(?:Building for debugging|Build complete!|Test Suite '.+' (?:started|passed)|Test Case '.+' (?:started|passed)|\*\* TEST SUCCEEDED \*\*)/u.test(
        line,
      )
    )
      return drop();
    const summary =
      /^\s*Executed (\d+) tests?, with (\d+) failures? \((\d+) unexpected\) in ([\d.]+) \([\d.]+\) seconds$/u.exec(
        line,
      );
    if (summary === null) return keep();
    const passed = String(Number(summary[1] ?? "0") - Number(summary[2] ?? "0"));
    const unexpected = summary[3] === "0" ? "" : ` ${summary[3]} unexpected`;
    return replace(`${countSummary(passed, summary[2], undefined, `${summary[4]}s`)}${unexpected}`);
  });
}

function appendSummary(details: string, summary: string): string {
  return details.length === 0 ? summary : `${details}\n${summary}`;
}
