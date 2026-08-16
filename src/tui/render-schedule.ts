/**
 * Whether a folded snapshot may become a React commit.
 *
 * Folding is not this module's job. Presentation `coalesce` already turns a
 * burst of revisions into one block, and OpenTUI already coalesces native
 * frames. What remains is the commit in between: a listener that calls
 * `setState` on every event still asks React to reconcile on every token, and
 * a cadence that treated a keystroke as one more token would make typing wait
 * on the stream.
 *
 * Two rules, both enforced here:
 *
 * **Stream paints share a cadence.** Display-only updates replace one pending
 * snapshot rather than queuing frames. The fold has already happened; this
 * only decides when the tree is told.
 *
 * **Input and semantic facts flush now.** A keystroke, a cancel, a terminal
 * outcome, or a shutdown change publishes immediately and takes any held
 * stream snapshot with it. Coalescing may change how often a view repaints.
 * It may not delay the thing the user just did, or hide that work has settled.
 *
 * Time comes from `ClockPort`. A second `requestAnimationFrame` would fight
 * the renderer that already owns one, and `Date.now` would make the cadence
 * untestable.
 */

import {
  addDuration,
  type DurationMs,
  duration,
  elapsedBetween,
  type Instant,
} from "../domain/index.ts";

/** How long a stream update may wait for a quieter moment. One 60 Hz frame. */
export const STREAM_PUBLISH_CADENCE = duration(16);

export type RenderKind = "stream" | "input" | "semantic";

export type RenderSchedule = {
  readonly pending: boolean;
  /** `null` before the first publish, so that first stream update is immediate. */
  readonly lastPublishedAt: Instant | null;
  /**
   * Stream notes held since the last publish.
   *
   * Zero after an idle publish. After a flush of a hold, the count of stream
   * notes that rode along — so a test can see coalescing without inspecting
   * React.
   */
  readonly coalesced: number;
  readonly dueAt: Instant | null;
};

export const IDLE_RENDER_SCHEDULE: RenderSchedule = {
  pending: false,
  lastPublishedAt: null,
  coalesced: 0,
  dueAt: null,
};

export type RenderDecision = {
  readonly schedule: RenderSchedule;
  readonly publish: boolean;
};

function published(now: Instant, coalesced: number): RenderSchedule {
  return { pending: false, lastPublishedAt: now, coalesced, dueAt: null };
}

export function noteRender(
  schedule: RenderSchedule,
  kind: RenderKind,
  now: Instant,
  cadence: DurationMs = STREAM_PUBLISH_CADENCE,
): RenderDecision {
  switch (kind) {
    case "input":
    case "semantic":
      return {
        schedule: published(now, schedule.pending ? schedule.coalesced : 0),
        publish: true,
      };
    case "stream":
      return noteStream(schedule, now, cadence);
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function noteStream(schedule: RenderSchedule, now: Instant, cadence: DurationMs): RenderDecision {
  if (schedule.pending) {
    if (schedule.dueAt !== null && now >= schedule.dueAt) {
      return { schedule: published(now, schedule.coalesced + 1), publish: true };
    }
    return {
      schedule: {
        pending: true,
        lastPublishedAt: schedule.lastPublishedAt,
        coalesced: schedule.coalesced + 1,
        dueAt: schedule.dueAt ?? addDuration(now, cadence),
      },
      publish: false,
    };
  }

  if (schedule.lastPublishedAt === null) {
    return { schedule: published(now, 0), publish: true };
  }

  if (elapsedBetween(schedule.lastPublishedAt, now) >= cadence) {
    return { schedule: published(now, 0), publish: true };
  }

  return {
    schedule: {
      pending: true,
      lastPublishedAt: schedule.lastPublishedAt,
      coalesced: 1,
      dueAt: addDuration(schedule.lastPublishedAt, cadence),
    },
    publish: false,
  };
}

/** The timer firing: publish if a hold is due, otherwise leave it. */
export function dueRender(schedule: RenderSchedule, now: Instant): RenderDecision {
  if (!schedule.pending || schedule.dueAt === null || now < schedule.dueAt) {
    return { schedule, publish: false };
  }
  return { schedule: published(now, schedule.coalesced), publish: true };
}
