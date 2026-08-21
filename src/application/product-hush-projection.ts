/**
 * Product Hush tool-result projection (#718).
 *
 * Maps a Hush observation onto a harness/model-facing projection that always
 * carries expansion and recovery handles when reduction or spill occurs.
 * Does not spawn processes or invent exact-source claims for reductions.
 */

import type { HushObservation } from "./hush.ts";

export const PRODUCT_HUSH_PROJECTION_OWNER = "#718";

export type ProductHushHarnessProjection = {
  readonly owner: typeof PRODUCT_HUSH_PROJECTION_OWNER;
  readonly origin: HushObservation["origin"];
  readonly text: string;
  readonly fidelity: HushObservation["hush"]["fidelity"];
  readonly reduced: boolean;
  readonly truncated: boolean;
  readonly expansion: {
    readonly stdoutArtifact: string | null;
    readonly stderrArtifact: string | null;
    readonly claimsExactSource: boolean;
  };
  readonly recovery: {
    readonly captureId: string;
    readonly via: "artifact" | "inline-capture";
    readonly stdoutTruncated: boolean;
    readonly stderrTruncated: boolean;
  };
};

/**
 * Project a Hush observation for tool-result / harness consumers.
 */
export function projectHushForHarness(observation: HushObservation): ProductHushHarnessProjection {
  const reduced =
    observation.hush.fidelity !== "exact" ||
    observation.hush.omissions.length > 0 ||
    observation.hush.truncated ||
    observation.capture.stdout.truncated ||
    observation.capture.stderr.truncated;
  const stdoutArtifact = observation.hush.expansion.stdoutArtifact;
  const stderrArtifact = observation.hush.expansion.stderrArtifact;
  return {
    owner: PRODUCT_HUSH_PROJECTION_OWNER,
    origin: observation.origin,
    text: observation.projection,
    fidelity: observation.hush.fidelity,
    reduced,
    truncated: observation.hush.truncated,
    expansion: {
      stdoutArtifact: stdoutArtifact === null ? null : String(stdoutArtifact),
      stderrArtifact: stderrArtifact === null ? null : String(stderrArtifact),
      claimsExactSource: observation.hush.fidelity === "exact" && !reduced,
    },
    recovery: {
      captureId: String(observation.hush.captureId),
      via: stdoutArtifact !== null || stderrArtifact !== null ? "artifact" : "inline-capture",
      stdoutTruncated: observation.capture.stdout.truncated,
      stderrTruncated: observation.capture.stderr.truncated,
    },
  };
}
