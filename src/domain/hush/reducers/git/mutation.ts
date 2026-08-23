import type { ProcessCaptureReport } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { gitSubcommand, gitSubcommandArguments } from "../../git-command.ts";
import { gitAddProjection } from "./mutation/add.ts";
import { gitCommitProjection } from "./mutation/commit.ts";
import { gitPullProjection } from "./mutation/pull.ts";
import { gitPushProjection } from "./mutation/push.ts";
import { gitMutationFallbackProjection } from "./mutation/shared.ts";

export function gitMutationProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
): HushStreamProjection {
  const args = gitSubcommandArguments(commandTokens);
  switch (gitSubcommand(commandTokens)) {
    case "add":
      return gitAddProjection(capture, maxBytes, patterns, args);
    case "commit":
      return gitCommitProjection(capture, maxBytes, patterns, args);
    case "pull":
      return gitPullProjection(capture, maxBytes, patterns, args);
    case "push":
      return gitPushProjection(capture, maxBytes, patterns, args);
    default:
      return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
}
