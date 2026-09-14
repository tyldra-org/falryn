/** Availability and evidence returned by authorized semantic history reads. */
import type { RuntimeEvent } from "./event.ts";

export type HistoryAvailability =
  | "exact"
  | "reduced"
  | "missing"
  | "expired"
  | "redacted"
  | "unauthorized"
  | "corrupt"
  | "unavailable"
  | "cancelled";
export type HistoryReadItem = {
  readonly references?: readonly {
    readonly artifactId: string | null;
    readonly availability: HistoryAvailability;
    readonly text: string | null;
    readonly reason: string | null;
  }[];
  readonly event: RuntimeEvent | null;
  readonly availability: HistoryAvailability;
  readonly text: string | null;
  readonly reason: string | null;
};
