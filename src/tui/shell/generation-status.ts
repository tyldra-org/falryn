/**
 * The status line's generation rate.
 *
 * The executor's activity is the projection owner and already limits live
 * updates to four per second; this only subscribes and labels. A rate change is
 * an ordinary state change rendered on demand, with no timeline and no live
 * render request.
 */

import { useCallback, useSyncExternalStore } from "react";
import type {
  GenerationActivity,
  GenerationActivityEntry,
} from "../../application/providers/generation-timing.ts";
import { generationRateLabel } from "../../presentation/index.ts";
import type { StatusLineModel } from "./view-model.ts";

const NO_SUBSCRIPTION = (): void => {};

export function useGenerationEntry(
  activity: GenerationActivity | undefined,
): GenerationActivityEntry | null {
  const subscribe = useCallback(
    (listener: () => void) => activity?.subscribe(listener) ?? NO_SUBSCRIPTION,
    [activity],
  );
  const snapshot = useCallback(() => activity?.current() ?? null, [activity]);
  return useSyncExternalStore(subscribe, snapshot);
}

export function generationStatus(
  entry: GenerationActivityEntry | null,
): StatusLineModel["generation"] | undefined {
  if (entry === null) return undefined;
  return entry.phase === "live"
    ? { label: generationRateLabel(entry.rate, "live"), active: true }
    : { label: generationRateLabel(entry.timing.rate, entry.timing.completion), active: false };
}
