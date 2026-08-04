/**
 * An activity entry, as rows a terminal can draw.
 *
 * The counterpart to `../transcript/rows.ts`, and the same split for the same
 * reason: this is where the projection's vocabulary becomes a status token and a
 * sentence, and it is pure so the mapping can be asserted without a renderer.
 *
 * ## Every outcome the runtime owns maps to a distinct token
 *
 * That is the acceptance criterion, and it is why `statusOfActivity` is
 * exhaustive over `TerminalOutcomeKind` rather than folding several kinds into
 * "error". The runtime distinguishes a failure from an effect nobody observed
 * and a cancellation from a timeout; a rail that flattened them would be the one
 * surface a user looks at to decide whether to retry, telling them less than the
 * exit code already does.
 *
 * ## An unconfirmed effect outranks a successful outcome
 *
 * A scope can complete while something in its subtree left an effect nobody
 * could observe. Reporting that as success is the "reported success by omission"
 * failure the whole outcome vocabulary exists to prevent, so the effect is
 * checked before the outcome and wins.
 *
 * Nothing here holds React, OpenTUI, a clock, or a colour literal.
 */

import type { ActivityEntry, HealthLevel, RuntimeHealth } from "../../presentation/index.ts";
import { describeActivity } from "../../presentation/index.ts";
import type { StatusToken } from "../theme/index.ts";

/** One drawable row of the rail. Always a status mark: a symbol and a word. */
export type ActivityRow = {
  /** Stable across revisions and re-renders. The entry's own key. */
  readonly key: string;
  readonly status: StatusToken;
  readonly label: string;
};

/**
 * The status an entry wears.
 *
 * The effect is examined first. `uncertain` anywhere in the subtree means nobody
 * knows what happened outside Falryn, and that is more urgent than whatever the
 * scope itself reported.
 */
export function statusOfActivity(entry: ActivityEntry): StatusToken {
  if (entry.effect === "uncertain" || entry.requiresInspection) {
    return "uncertain";
  }

  if (entry.lifecycle === "active") {
    return "pending";
  }
  if (entry.lifecycle === "cancelling") {
    // Not `cancelled`. The work has been asked to stop and has not yet
    // acknowledged, and a rail that reported it as stopped would be describing a
    // drain that is still running as one that finished.
    return "warning";
  }

  const outcome = entry.outcome;
  if (outcome === null) {
    // Terminal with no reported outcome. `informational` says "this happened"
    // rather than inventing the success nothing claimed.
    return "informational";
  }
  switch (outcome.kind) {
    case "completed":
      return entry.effect === "partial" ? "warning" : "success";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    case "timed-out":
      return "warning";
    case "uncertain":
      return "uncertain";
  }
}

/** The rows the rail draws for a set of entries, in order. */
export function activityRows(entries: readonly ActivityEntry[]): readonly ActivityRow[] {
  return entries.map((entry) => ({
    key: entry.key,
    status: statusOfActivity(entry),
    // The projection's own sentence. A second phrasing here would drift from
    // what a headless renderer prints for the same entry.
    label: describeActivity(entry),
  }));
}

/**
 * The status token a health level wears.
 *
 * Exhaustive, and `unknown` maps to `uncertain` rather than to `informational`:
 * "no runtime is attached" is a thing nobody has looked into, not a neutral
 * notice, and the two symbols are what a monochrome terminal has to tell them
 * apart by.
 */
export function statusOfHealth(level: HealthLevel): StatusToken {
  switch (level) {
    case "failing":
      return "error";
    case "degraded":
      return "warning";
    case "busy":
      return "pending";
    case "idle":
      return "informational";
    case "unknown":
      return "uncertain";
  }
}

/**
 * The health facts as one line.
 *
 * `label value`, joined by the theme's separator. Labels are words rather than
 * abbreviations because the status line is read at a glance by someone who has
 * not memorised a legend, and the row is truncated from the right so the facts
 * that matter most are written first by `projectHealth`.
 */
export function healthFactsLine(health: RuntimeHealth, separator: string): string {
  return health.facts.map((fact) => `${fact.label} ${fact.value}`).join(` ${separator} `);
}
