/** Public options and internal execution contract for the host Git adapter. */

import type { ClockPort, DurationMs } from "../../../domain/foundation/index.ts";
import type { Result } from "../../../domain/foundation/result.ts";
import type { GitError } from "../../../domain/git/index.ts";
import type { ProcessCapturePort, ProcessCaptureReport } from "../../../domain/process/index.ts";

export type HostGitOptions = {
  readonly capture: ProcessCapturePort;
  readonly clock?: ClockPort;
};

export type GitRunner = (
  executable: string,
  cwd: string,
  subcommand: readonly string[],
  timeoutMs: DurationMs,
  signal: AbortSignal | undefined,
  maxOutputBytes: number,
  extraEnv?: Readonly<Record<string, string>> | undefined,
) => Promise<Result<ProcessCaptureReport, GitError>>;
