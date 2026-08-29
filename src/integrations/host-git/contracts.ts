/** Public options and internal execution contract for the host Git adapter. */

import type {
  ClockPort,
  DurationMs,
  GitError,
  ProcessCapturePort,
  ProcessCaptureReport,
} from "../../domain/index.ts";
import type { Result } from "../../domain/result.ts";

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
