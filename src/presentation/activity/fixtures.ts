/**
 * Scope events and reports a test can build a rail from.
 *
 * Written out rather than generated, for the reason the transcript corpus states:
 * a generated fixture constructs whatever the type demands and proves only that
 * the type is inhabited. These are plausible sequences a runtime would actually
 * emit, which is what makes a fold over them worth asserting.
 *
 * Not product code. `src/presentation-boundaries.test.ts` excludes fixtures from
 * the purity controls for the modules that ship, and includes them in the ones
 * about dependency direction — a fixture that imported a renderer would make
 * every consumer need a terminal.
 */

import type {
  EffectCertainty,
  Instant,
  ScopeEvent,
  ScopeId,
  ScopeKind,
  TerminalOutcome,
} from "../../domain/index.ts";
import { instant, scopeId } from "../../domain/index.ts";

/** A fixed moment. Never a clock: a fixture that read one would not replay. */
export const FIXTURE_INSTANT: Instant = instant(Date.UTC(2026, 7, 1, 9, 30, 0));

export function fixtureScope(name: string): ScopeId {
  return scopeId.from(`scope-${name}`);
}

/** One event, with everything a caller does not care about filled in. */
export function scopeEvent(overrides: {
  readonly order: number;
  readonly kind: ScopeEvent["kind"];
  readonly scope: string;
  readonly scopeKind?: ScopeKind;
  readonly outcome?: TerminalOutcome | null;
  readonly effect?: EffectCertainty | null;
}): ScopeEvent {
  return {
    order: overrides.order,
    kind: overrides.kind,
    scopeId: fixtureScope(overrides.scope),
    scopeKind: overrides.scopeKind ?? "invocation",
    at: FIXTURE_INSTANT,
    reason: null,
    outcome: overrides.outcome ?? null,
    effect: overrides.effect ?? null,
  };
}

/** A scope that opened and is still running. */
export function running(order: number, scope: string): readonly ScopeEvent[] {
  return [scopeEvent({ order, kind: "scope.opened", scope })];
}

/** A scope that opened and then settled with the given outcome. */
export function settled(
  order: number,
  scope: string,
  outcome: TerminalOutcome,
): readonly ScopeEvent[] {
  return [
    scopeEvent({ order, kind: "scope.opened", scope }),
    scopeEvent({ order: order + 1, kind: "scope.terminal", scope, outcome }),
  ];
}

/** Every terminal outcome the runtime declares, each on its own scope. */
export function everyOutcome(): readonly ScopeEvent[] {
  const outcomes: readonly TerminalOutcome[] = [
    { kind: "completed" },
    { kind: "failed", effect: "none" },
    { kind: "cancelled", effect: "partial" },
    { kind: "timed-out", effect: "none" },
    { kind: "uncertain", effect: "uncertain" },
  ];
  return outcomes.flatMap((outcome, index) => settled(index * 2, outcome.kind, outcome));
}
