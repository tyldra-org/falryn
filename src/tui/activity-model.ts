/**
 * What the activity rail and the status line are given.
 *
 * A view model in the sense `./view-model.ts` means it: plain data, no renderer,
 * no OpenTUI type, no port. The projection is carried whole rather than
 * flattened into rows, for the reason the transcript model states — a copy is
 * what goes stale, and the rail's rows are cheap to derive from the projection
 * every time it is drawn.
 */

import type { ActivityProjection, RuntimeHealth } from "../presentation/index.ts";

export type ActivityModel = {
  readonly projection: ActivityProjection;
  /**
   * The runtime's health, already projected.
   *
   * Resolved once by the layer that has every report, so the rail and the status
   * line cannot disagree about how the run is going. Two components each
   * deriving a level from overlapping inputs is exactly how a status line says
   * "idle" beside a rail showing a failure.
   */
  readonly health: RuntimeHealth;
};
