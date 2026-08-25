/** Public Hush contracts shared by orchestration, classification, and reducers. */

import type { ArtifactId } from "../artifact.ts";
import type { DurationMs } from "../clock.ts";
import type { ProcessCaptureId } from "../identity.ts";
import type { CommandMode, CommandRequest } from "../process.ts";
import type {
  ProcessCaptureEncoding,
  ProcessCaptureExit,
  ProcessCaptureReport,
  ProcessCaptureStop,
  ProcessStreamName,
} from "../process-capture.ts";
import type { Result } from "../result.ts";

export const HUSH_REDUCER_VERSION = "hush.v25";

/** Longest reduced projection Hush may emit. */
export const MAX_HUSH_REDUCED_BYTES = 64 * 1_024;
export const DEFAULT_HUSH_REDUCED_BYTES = 8 * 1_024;

export const HUSH_FAMILIES = [
  "git",
  "github",
  "test",
  "lint",
  "typecheck",
  "build",
  "package",
  "container",
  "kubernetes",
  "cloud",
  "data",
  "log",
  "http",
  "search",
  "listing",
  "generic",
] as const;
export type HushFamily = (typeof HUSH_FAMILIES)[number];

export const HUSH_STRATEGIES = ["specialized", "generic", "passthrough"] as const;
export type HushStrategy = (typeof HUSH_STRATEGIES)[number];

export const HUSH_FIDELITIES = ["exact", "deterministic-reduction", "raw-fallback"] as const;
export type HushFidelity = (typeof HUSH_FIDELITIES)[number];

export type HushCommandIdentity = {
  readonly mode: CommandMode;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly command: string | null;
  readonly cwd: string | null;
};

export type HushOmissionKind = "capped-bytes" | "binary-stream" | "reducer-failure";

export type HushOmission = {
  readonly kind: HushOmissionKind;
  readonly stream: ProcessStreamName | "both";
  readonly count: number;
  readonly detail: string | null;
};

export type HushExpansion = {
  readonly stdoutInline: boolean;
  readonly stderrInline: boolean;
  readonly stdoutArtifact: ArtifactId | null;
  readonly stderrArtifact: ArtifactId | null;
};

export type HushRequest = {
  readonly command: CommandRequest;
  readonly capture: ProcessCaptureReport;
  readonly expectedFamilies?: readonly HushFamily[];
  readonly importantPatterns?: readonly string[];
  readonly strategy?: HushStrategy;
  readonly maxReducedBytes?: number;
};

export type HushResult = {
  readonly captureId: ProcessCaptureId;
  readonly command: HushCommandIdentity;
  readonly family: HushFamily;
  readonly reducerId: string;
  readonly strategy: HushStrategy;
  readonly reducerVersion: typeof HUSH_REDUCER_VERSION;
  readonly fidelity: HushFidelity;
  readonly stop: ProcessCaptureStop;
  readonly exit: ProcessCaptureExit;
  readonly durationMs: DurationMs;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly stdoutEncoding: ProcessCaptureEncoding;
  readonly stderrEncoding: ProcessCaptureEncoding;
  readonly truncated: boolean;
  readonly reducedText: string;
  readonly omissions: readonly HushOmission[];
  readonly expansion: HushExpansion;
  readonly fallbackReason: "unknown-family" | "expected-family-miss" | "reducer-failure" | null;
};

export type HushError = {
  readonly kind: "hush";
  readonly code: "invalid-request";
  readonly reason: "invalid-reduced-limit" | "invalid-pattern";
};

export type HushPort = {
  reduce(request: HushRequest): Result<HushResult, HushError>;
};

export type HushStreamProjection = {
  readonly text: string;
  readonly omissions: readonly HushOmission[];
};
