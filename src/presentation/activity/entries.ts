/**
 * Runtime work, as something an interface can draw.
 *
 * The activity rail's whole content is this: one entry per piece of work the
 * runtime is actually doing, carrying what it is, where it is in its lifecycle,
 * and — when it has settled — the outcome the runtime already decided.
 *
 * ## Nothing here invents a vocabulary
 *
 * `ScopeStatus`, `TerminalOutcome`, and `EffectCertainty` are the runtime's and
 * are used unchanged. That is not tidiness: the runtime distinguishes a failure
 * from an effect nobody observed, and a cancelled operation from one that never
 * started, and a projection that flattened those into "error" would force the
 * rail to invent the distinction back — badly, and differently from the CLI
 * renderer that reads the same facts.
 *
 * The one thing this module adds is *ordering and identity*: an entry has a
 * stable key so a rail can update it in place rather than redrawing a list, and
 * an order so two interleaved scopes stay orderable.
 *
 * ## No colour, no token, no renderer
 *
 * An entry says `cancelling` and `uncertain`. What those look like is the theme
 * contract's answer, made where the terminal's capabilities are known — the same
 * split the transcript surface makes, and for the same reason: a colour decided
 * here could not be lowered for a 16-colour terminal or removed for a
 * monochrome one.
 */

import type {
  EffectCertainty,
  ScopeEvent,
  ScopeId,
  ScopeKind,
  ScopeStatus,
  TerminalOutcome,
} from "../../domain/index.ts";
import { effectOf } from "../../domain/index.ts";

/**
 * What produced an entry.
 *
 * A closed list, so a rail can group without inventing categories. `scope` is
 * the only one this build produces — the scheduler and the queue report totals
 * rather than per-item identity, and those reach the interface through
 * `./health.ts` instead. Declaring the other two would be listing a producer
 * that does not exist.
 */
export const ACTIVITY_SOURCES = ["scope"] as const;

export type ActivitySource = (typeof ACTIVITY_SOURCES)[number];

export type ActivityEntry = {
  /** Stable across revisions. Derived from the scope's own identity. */
  readonly key: string;
  readonly source: ActivitySource;
  /** The runtime's own word for what this work is. Never re-worded here. */
  readonly kind: ScopeKind;
  /**
   * Where the work is, in the runtime's vocabulary.
   *
   * `cancelling` is deliberately its own status and not a flavour of active. A
   * slow drain shown as "running" looks like a freeze, and shown as "stopped"
   * is a lie about work that is still acknowledging.
   */
  readonly lifecycle: ScopeStatus;
  /** The outcome, once there is one. `null` while the work is still live. */
  readonly outcome: TerminalOutcome | null;
  /** The most uncertain effect in this scope's subtree, from the runtime. */
  readonly effect: EffectCertainty;
  /** Whether external state must be observed before a retry. The runtime's answer. */
  readonly requiresInspection: boolean;
  /** Monotonic across the tree, so interleaved work stays orderable. */
  readonly order: number;
};

/** The key an entry is identified by. One rule, so nothing derives a second. */
function activityKey(scopeId: ScopeId): string {
  return `scope:${scopeId}`;
}

/**
 * One scope event, as an entry.
 *
 * The resubscription path. A view rebuilding from a cursor has the events rather
 * than the reports — the reports describe *now*, and a cursor is about what has
 * been applied — so an event has to be able to produce the same entry shape.
 */
export function entryForEvent(event: ScopeEvent): ActivityEntry {
  return {
    key: activityKey(event.scopeId),
    source: "scope",
    kind: event.scopeKind,
    lifecycle: lifecycleOf(event),
    outcome: event.outcome,
    effect: event.outcome === null ? (event.effect ?? "none") : effectOf(event.outcome),
    // An event does not carry it; the report does. `false` rather than a guess,
    // because claiming inspection is required when nothing said so would send
    // someone looking at external state for no reason.
    requiresInspection: false,
    order: event.order,
  };
}

/** The lifecycle an event moves a scope to. */
function lifecycleOf(event: ScopeEvent): ScopeStatus {
  switch (event.kind) {
    case "scope.opened":
    case "scope.effect.recorded":
      return "active";
    case "scope.cancellation.requested":
      return "cancelling";
    case "scope.terminal":
      return "terminal";
  }
}

/**
 * How an entry folds onto the one it replaces.
 *
 * Later wins on lifecycle and outcome, because a later event is a later
 * observation of the same work. The effect is monotonic toward uncertainty
 * instead — the same rule the scope tree itself applies when recording one — so
 * a progress report cannot downgrade an uncertainty already observed.
 * `requiresInspection` is sticky for the same reason: it is a fact about work
 * that happened, and a later event that does not mention it has not retracted
 * it.
 */
export function foldEntry(previous: ActivityEntry, next: ActivityEntry): ActivityEntry {
  return {
    ...next,
    effect: mostUncertain(previous.effect, next.effect),
    requiresInspection: previous.requiresInspection || next.requiresInspection,
  };
}

/**
 * Certainty ordering, least to most uncertain.
 *
 * `completed` outranks `none` because something happened; `partial` outranks
 * both because something happened and something did not; `uncertain` outranks
 * everything because nobody looked.
 */
const CERTAINTY_RANK: Readonly<Record<EffectCertainty, number>> = {
  none: 0,
  completed: 1,
  partial: 2,
  uncertain: 3,
};

function mostUncertain(left: EffectCertainty, right: EffectCertainty): EffectCertainty {
  return CERTAINTY_RANK[right] > CERTAINTY_RANK[left] ? right : left;
}

/** Whether an entry describes work that has not settled. */
export function isLive(entry: ActivityEntry): boolean {
  return entry.lifecycle !== "terminal";
}

/**
 * One sentence describing an entry.
 *
 * Words for every state, because the rail's status is not allowed to be a colour
 * alone and because this is also what a headless renderer would print. The
 * outcome's own kind is used verbatim: "timed-out" is the runtime's word and
 * rewording it here would be a second vocabulary in a different voice.
 */
export function describeActivity(entry: ActivityEntry): string {
  const suffix = entry.requiresInspection ? "; needs inspection" : "";
  switch (entry.lifecycle) {
    case "active":
      return `${entry.kind} running${suffix}`;
    case "cancelling":
      return `${entry.kind} stopping${suffix}`;
    case "terminal": {
      const outcome = entry.outcome;
      if (outcome === null) {
        // Terminal with no outcome is not something the runtime produces, and
        // guessing "completed" here is how an interface reports success it was
        // never told about.
        return `${entry.kind} settled without a reported outcome${suffix}`;
      }
      const effect = effectOf(outcome);
      return `${entry.kind} ${outcome.kind}, effect ${effect}${suffix}`;
    }
  }
}
