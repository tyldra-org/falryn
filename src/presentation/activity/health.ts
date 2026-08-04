/**
 * What the status line says about the runtime.
 *
 * One health level, one sentence, and a bounded set of facts a reader can act
 * on. The inputs are the reports the runtime already produces — the scheduler's,
 * the queue's, the shutdown coordinator's — plus the activity projection, and
 * none of them is re-derived here.
 *
 * ## Health is not a summary of counters
 *
 * The level is decided by the most serious thing that is true, in a stated
 * order, and the order is the whole design. A run with three completed scopes
 * and one uncertain effect is not "mostly fine": the uncertain effect is the
 * thing someone has to act on, and an average would bury it. So the rule is a
 * precedence, not an aggregate.
 *
 * ## `unknown` is a real level
 *
 * A build with no producer attached reports `unknown`, not `healthy`. Those are
 * different statements, and the difference is the same one `FactValue` draws
 * between `empty` and `unavailable`: nothing is running and nothing can tell us
 * are not the same answer, and an interface that showed a green tick for the
 * second would be reporting success by omission.
 *
 * Pure: no clock, no renderer, no colour. What a level looks like is the theme's
 * answer, made where the terminal's capabilities are known.
 */

import type { ConfigurationGeneration, QueueReport, SchedulerReport } from "../../domain/index.ts";
import { effectOf } from "../../domain/index.ts";
import type { ActivityProjection } from "./reducer.ts";
import { EMPTY_ACTIVITY, liveEntries } from "./reducer.ts";

/**
 * How the runtime is doing, worst-first.
 *
 * Ordered by severity so a precedence rule is a comparison rather than a switch
 * nobody can check for completeness.
 */
export const HEALTH_LEVELS = ["failing", "degraded", "busy", "idle", "unknown"] as const;

export type HealthLevel = (typeof HEALTH_LEVELS)[number];

/** One labelled fact the status line may show. Bounded, and never a metric dump. */
export type HealthFact = {
  readonly label: string;
  readonly value: string;
};

export type RuntimeHealth = {
  readonly level: HealthLevel;
  /** One short sentence. Never the only carrier of the level — the word is. */
  readonly headline: string;
  readonly facts: readonly HealthFact[];
};

/**
 * What is currently shutting down, if anything.
 *
 * A narrow shape rather than `ShutdownReport`, because the status line needs
 * two facts and the report carries a phase-by-phase record. A view holding the
 * whole report would be a second reader of something the coordinator owns.
 */
export type ShutdownState = {
  readonly shuttingDown: boolean;
  readonly level: string;
};

export type HealthInput = {
  readonly activity: ActivityProjection;
  /** `null` when nothing is scheduling. Absent is not the same as zero. */
  readonly scheduler: SchedulerReport | null;
  readonly queue: QueueReport | null;
  readonly shutdown: ShutdownState | null;
  /** The configuration this run resolved. Carried so a reload is visible. */
  readonly configuration: ConfigurationGeneration | null;
};

/**
 * What a build with no runtime attached reports from.
 *
 * Every producer absent, which is what makes the level `unknown` rather than
 * `idle`. The empty projection is the reducer's own, not a literal: a second
 * empty value here would carry a generation nobody updated.
 */
export const NO_HEALTH_INPUT: HealthInput = {
  activity: EMPTY_ACTIVITY,
  scheduler: null,
  queue: null,
  shutdown: null,
  configuration: null,
};

/**
 * The runtime's health, as one value.
 *
 * The precedence, worst first:
 *
 * 1. **Shutting down** outranks everything. It is the only state where what a
 *    user should do changes completely — wait, or escalate — and a rail showing
 *    "busy" while the process is tearing down would be describing work that is
 *    being cancelled as work that is progressing.
 * 2. **A failed or uncertain outcome** is next. Both need someone to look;
 *    uncertain needs it more, because nobody has.
 * 3. **Refused or expired work** is degraded: something was asked for and did
 *    not happen, which is a different thing from something that failed.
 * 4. **Live work** is busy.
 * 5. **Nothing running, with something attached** is idle.
 * 6. **Nothing attached at all** is unknown.
 */
export function projectHealth(input: HealthInput): RuntimeHealth {
  const facts = factsFor(input);

  if (input.shutdown?.shuttingDown === true) {
    return { level: "failing", headline: `Shutting down (${input.shutdown.level}).`, facts };
  }

  const troubled = troubledEntries(input.activity);
  if (troubled.uncertain > 0) {
    return {
      level: "failing",
      headline: plural(troubled.uncertain, "operation", "left an unconfirmed effect"),
      facts,
    };
  }
  if (troubled.failed > 0) {
    return { level: "failing", headline: plural(troubled.failed, "operation", "failed"), facts };
  }

  const refused = (input.scheduler?.refused ?? 0) + (input.queue?.rejected ?? 0);
  const expired = input.queue?.expired ?? 0;
  if (refused > 0 || expired > 0) {
    return {
      level: "degraded",
      headline: plural(refused + expired, "request", "was not accepted"),
      facts,
    };
  }
  if (troubled.cancelled > 0) {
    return {
      level: "degraded",
      headline: plural(troubled.cancelled, "operation", "was cancelled"),
      facts,
    };
  }

  const live = liveEntries(input.activity).length;
  const running = input.scheduler?.running ?? 0;
  if (live > 0 || running > 0) {
    return {
      level: "busy",
      headline: plural(Math.max(live, running), "operation", "running"),
      facts,
    };
  }

  if (attached(input)) {
    return { level: "idle", headline: "Nothing is running.", facts };
  }
  return {
    level: "unknown",
    headline: "No runtime is attached, so there is nothing to report.",
    facts,
  };
}

/** Whether anything at all is reporting. `unknown` exists for when nothing is. */
function attached(input: HealthInput): boolean {
  return (
    input.scheduler !== null ||
    input.queue !== null ||
    input.shutdown !== null ||
    input.activity.entries.length > 0
  );
}

type Troubled = {
  readonly failed: number;
  readonly cancelled: number;
  readonly uncertain: number;
};

/**
 * Settled work that needs attention, counted by what it needs.
 *
 * `uncertain` counts both the outcome kind and any settled outcome whose effect
 * could not be observed, because those are the same problem for a reader: a
 * completed-looking operation that may have changed something outside Falryn.
 */
function troubledEntries(activity: ActivityProjection): Troubled {
  let failed = 0;
  let cancelled = 0;
  let uncertain = 0;
  for (const entry of activity.entries) {
    const outcome = entry.outcome;
    if (outcome === null) {
      continue;
    }
    if (outcome.kind === "uncertain" || effectOf(outcome) === "uncertain") {
      uncertain += 1;
      continue;
    }
    if (outcome.kind === "failed") {
      failed += 1;
      continue;
    }
    if (outcome.kind === "cancelled" || outcome.kind === "timed-out") {
      cancelled += 1;
    }
  }
  return { failed, cancelled, uncertain };
}

/**
 * The facts worth a row, and only those.
 *
 * A fact is included when it is non-zero or when its absence is itself the
 * answer. A status line listing eleven counters that are all zero is a
 * telemetry dump, and the design direction refuses one.
 */
function factsFor(input: HealthInput): readonly HealthFact[] {
  const facts: HealthFact[] = [];
  const live = liveEntries(input.activity).length;
  if (live > 0) {
    facts.push({ label: "running", value: `${live}` });
  }
  if (input.scheduler !== null && input.scheduler.queued > 0) {
    facts.push({ label: "queued", value: `${input.scheduler.queued}` });
  }
  if (input.queue !== null && input.queue.items > 0) {
    facts.push({
      label: "buffered",
      value: `${input.queue.items}/${input.queue.maxItems}`,
    });
  }
  if (input.queue !== null && input.queue.waiting > 0) {
    facts.push({ label: "waiting", value: `${input.queue.waiting}` });
  }
  if (input.activity.droppedSettled > 0) {
    // Never silent. A rail that dropped finished work and said nothing would be
    // presenting a truncated list as a complete one.
    facts.push({ label: "not shown", value: `${input.activity.droppedSettled} finished` });
  }
  if (input.configuration !== null) {
    facts.push({ label: "config", value: `${input.configuration}` });
  }
  return facts;
}

/** `1 operation running`, `3 operations running`. */
function plural(count: number, noun: string, verb: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`} ${verb}.`;
}
