import type { ProcessCaptureReport } from "../../../process-capture.ts";
import type { HushStreamProjection } from "../../contracts.ts";
import { gitSubcommand, gitSubcommandArguments } from "../../invocation/git.ts";
import type { HushReducer } from "../contracts.ts";
import { gitAddProjection } from "./mutation/add.ts";
import { gitBranchProjection } from "./mutation/branch.ts";
import { gitCheckoutProjection } from "./mutation/checkout.ts";
import { gitCommitProjection } from "./mutation/commit.ts";
import { gitFetchProjection } from "./mutation/fetch.ts";
import { gitPullProjection } from "./mutation/pull.ts";
import { gitPushProjection } from "./mutation/push.ts";
import { gitMutationFallbackProjection } from "./mutation/shared.ts";
import { gitStashProjection } from "./mutation/stash.ts";
import { gitWorktreeProjection } from "./mutation/worktree.ts";

export const reduceGitMutation: HushReducer = ({
  capture,
  maxBytes,
  patterns,
  commandTokens,
  cwd,
}) => gitMutationProjection(capture, maxBytes, patterns, commandTokens, cwd);

export function gitMutationProjection(
  capture: ProcessCaptureReport,
  maxBytes: number,
  patterns: readonly string[],
  commandTokens: readonly string[],
  cwd: string | null,
): HushStreamProjection {
  const args = gitSubcommandArguments(commandTokens);
  switch (gitSubcommand(commandTokens)) {
    case "add":
      return gitAddProjection(capture, maxBytes, patterns, args);
    case "branch":
      return gitBranchProjection(capture, maxBytes, patterns, args);
    case "checkout":
      return gitCheckoutProjection(capture, maxBytes, patterns, args);
    case "commit":
      return gitCommitProjection(capture, maxBytes, patterns, args);
    case "fetch":
      return gitFetchProjection(capture, maxBytes, patterns, args);
    case "pull":
      return gitPullProjection(capture, maxBytes, patterns, args);
    case "push":
      return gitPushProjection(capture, maxBytes, patterns, args);
    case "stash":
      return gitStashProjection(capture, maxBytes, patterns, args);
    case "worktree":
      return gitWorktreeProjection(capture, maxBytes, patterns, args, cwd);
    default:
      return gitMutationFallbackProjection(capture, maxBytes, patterns);
  }
}
