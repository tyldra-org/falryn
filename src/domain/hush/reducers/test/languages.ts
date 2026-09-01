/** Dispatch test output to its language ecosystem parser. */

import { formatAppleTests } from "./languages/apple.ts";
import { formatDotnetTests } from "./languages/dotnet.ts";
import { formatGoTests } from "./languages/go.ts";
import { formatJvmTests } from "./languages/jvm.ts";
import { formatPytest } from "./languages/python.ts";
import { formatRustTests } from "./languages/rust.ts";
import { executable } from "./shared.ts";

export function formatLanguageTests(text: string, commandTokens: readonly string[]): string | null {
  const command = executable(commandTokens);
  switch (command) {
    case "pytest":
      return formatPytest(text);
    case "cargo":
      return formatRustTests(text, commandTokens[1] === "nextest");
    case "go":
      return formatGoTests(text);
    case "gradle":
    case "gradlew":
    case "mvn":
    case "mvnw":
    case "sbt":
      return formatJvmTests(text, command);
    case "dotnet":
      return formatDotnetTests(text);
    case "swift":
    case "xcodebuild":
      return formatAppleTests(text);
    default:
      return null;
  }
}
