/**
 * The activity rail's contract, in one place.
 *
 * Everything exported here is a pure function from the projection's vocabulary
 * to the theme's. The component that mounts them is
 * `../components/activity-rail.tsx`, and it is the only part of the rail that
 * needs a renderer — which is why every mapping the rail promises, including
 * that each outcome the runtime owns is visibly distinct, can be asserted
 * without one.
 */

export type { ActivityRow } from "./rows.ts";
export { activityRows, healthFactsLine, statusOfActivity, statusOfHealth } from "./rows.ts";
