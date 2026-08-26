/** Dispatch build output to its language ecosystem parser. */

import { formatAppleBuild } from "./languages/apple.ts";
import { formatDotnetBuild } from "./languages/dotnet.ts";
import { formatElixirBuild } from "./languages/elixir.ts";
import { formatJvmBuild } from "./languages/jvm.ts";
import { formatRustBuild } from "./languages/rust.ts";

export function formatLanguageBuild(text: string, commandTokens: readonly string[]): string | null {
  switch (commandTokens[0] ?? "") {
    case "cargo":
      return formatRustBuild(text, commandTokens);
    case "go":
      return text.length === 0 ? "" : null;
    case "gradle":
    case "gradlew":
    case "mvn":
    case "mvnw":
    case "sbt":
      return formatJvmBuild(text, commandTokens);
    case "dotnet":
      return formatDotnetBuild(text, commandTokens);
    case "swift":
    case "xcodebuild":
      return formatAppleBuild(text, commandTokens);
    case "mix":
      return formatElixirBuild(text);
    default:
      return null;
  }
}
