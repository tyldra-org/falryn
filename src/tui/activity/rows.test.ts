/**
 * The rail's mapping from the runtime's vocabulary to the theme's.
 *
 * The acceptance criterion is that the rail distinguishes every outcome state
 * the runtime owns, and "distinguishes" is tested the only way worth testing it:
 * on a monochrome terminal, where a colour is not available to break a tie. So
 * the walk is over the runtime's own declared lists, and what it asserts is that
 * each one reaches a token whose symbol *and* word differ from the others'.
 */

import { describe, expect, test } from "bun:test";
import {
  EFFECT_CERTAINTIES,
  type EffectCertainty,
  TERMINAL_OUTCOME_KINDS,
  type TerminalOutcome,
} from "../../domain/index.ts";
import type { ActivityEntry, HealthLevel, RuntimeHealth } from "../../presentation/index.ts";
import { HEALTH_LEVELS } from "../../presentation/index.ts";
import { resolveTheme, STATUS_PRESENTATION, type StatusToken } from "../theme/index.ts";
import { activityRows, healthFactsLine, statusOfActivity, statusOfHealth } from "./rows.ts";

const THEME = resolveTheme({
  variant: "monochrome",
  colorLevel: "none",
  symbols: "unicode",
  reducedMotion: true,
  generation: 1,
});

/** An entry with everything a case does not care about filled in. */
function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    key: "scope:one",
    source: "scope",
    kind: "invocation",
    lifecycle: "terminal",
    outcome: { kind: "completed" },
    effect: "completed",
    requiresInspection: false,
    order: 0,
    ...overrides,
  };
}

/** An outcome of the given kind, with the effect the union permits. */
function outcomeOf(kind: (typeof TERMINAL_OUTCOME_KINDS)[number]): TerminalOutcome {
  switch (kind) {
    case "completed":
      return { kind: "completed" };
    case "uncertain":
      return { kind: "uncertain", effect: "uncertain" };
    default:
      return { kind, effect: "none" };
  }
}

/** What a monochrome terminal actually shows for a token: a symbol and a word. */
function shown(token: ReturnType<typeof statusOfActivity>): string {
  const presentation = STATUS_PRESENTATION[token];
  return `${THEME.symbol(presentation.symbol)} ${presentation.label}`;
}

describe("every outcome the runtime owns", () => {
  test("reaches a token, walking the runtime's own list", () => {
    // A list rather than a hand-written set of cases, so a kind added to the
    // runtime cannot quietly fall through to a default here.
    for (const kind of TERMINAL_OUTCOME_KINDS) {
      const token = statusOfActivity(entry({ outcome: outcomeOf(kind), effect: "none" }));
      expect({ kind, token: typeof token }).toEqual({ kind, token: "string" });
    }
  });

  test("is distinguishable without colour", () => {
    // The only test of "visibly distinct" worth passing. Each outcome resolves
    // to a token whose symbol and word differ from the others', so a terminal
    // with no colour at all still tells them apart.
    const seen = new Map<string, string>();
    for (const kind of TERMINAL_OUTCOME_KINDS) {
      const mark = shown(statusOfActivity(entry({ outcome: outcomeOf(kind), effect: "none" })));
      expect({ kind, collidesWith: seen.get(mark) ?? null }).toEqual({ kind, collidesWith: null });
      seen.set(mark, kind);
    }
    expect(seen.size).toBe(TERMINAL_OUTCOME_KINDS.length);
  });

  test("never reports a failure or a timeout as success", () => {
    for (const kind of ["failed", "timed-out", "cancelled", "uncertain"] as const) {
      const token = statusOfActivity(entry({ outcome: outcomeOf(kind), effect: "none" }));
      expect({ kind, token }).not.toEqual({ kind, token: "success" });
    }
  });
});

describe("an unconfirmed effect", () => {
  test("outranks the outcome that carried it", () => {
    // A scope can complete while something in its subtree left an effect nobody
    // could observe. Reporting that as success is the exact failure the outcome
    // vocabulary exists to prevent.
    expect(statusOfActivity(entry({ outcome: { kind: "completed" }, effect: "uncertain" }))).toBe(
      "uncertain",
    );
  });

  test("is implied by a scope that requires inspection", () => {
    expect(
      statusOfActivity(entry({ outcome: { kind: "completed" }, requiresInspection: true })),
    ).toBe("uncertain");
  });

  test("makes a partial completion a warning rather than a success", () => {
    expect(statusOfActivity(entry({ outcome: { kind: "completed" }, effect: "partial" }))).toBe(
      "warning",
    );
  });

  test("covers every certainty the runtime declares", () => {
    for (const effect of EFFECT_CERTAINTIES) {
      const token = statusOfActivity(entry({ outcome: { kind: "completed" }, effect }));
      const expected: Record<EffectCertainty, StatusToken> = {
        none: "success",
        completed: "success",
        partial: "warning",
        uncertain: "uncertain",
      };
      expect({ effect, token }).toEqual({ effect, token: expected[effect] });
    }
  });
});

describe("live work", () => {
  test("is pending while running and a warning while stopping", () => {
    // `cancelling` is not `cancelled`. The work has been asked to stop and has
    // not acknowledged, and reporting it as stopped describes a drain that is
    // still running as one that finished.
    expect(statusOfActivity(entry({ lifecycle: "active", outcome: null, effect: "none" }))).toBe(
      "pending",
    );
    expect(
      statusOfActivity(entry({ lifecycle: "cancelling", outcome: null, effect: "none" })),
    ).toBe("warning");
  });

  test("terminal with no reported outcome is informational, never success", () => {
    // Saying "this happened" beats inventing a success nothing claimed.
    expect(statusOfActivity(entry({ lifecycle: "terminal", outcome: null, effect: "none" }))).toBe(
      "informational",
    );
  });
});

describe("rows", () => {
  test("carry the projection's own sentence and the entry's key", () => {
    const rows = activityRows([entry({ key: "scope:a", lifecycle: "active", outcome: null })]);
    expect(rows.length).toBe(1);
    expect(rows[0]?.key).toBe("scope:a");
    expect(rows[0]?.label).toContain("running");
  });
});

describe("health", () => {
  test("maps every level, and unknown is not merely informational", () => {
    // "No runtime is attached" is a thing nobody has looked into rather than a
    // neutral notice, and the two symbols are what a monochrome terminal has to
    // tell them apart by.
    const tokens = new Set<string>();
    for (const level of HEALTH_LEVELS) {
      tokens.add(statusOfHealth(level as HealthLevel));
    }
    expect(tokens.size).toBe(HEALTH_LEVELS.length);
    expect(statusOfHealth("unknown")).toBe("uncertain");
    expect(statusOfHealth("idle")).toBe("informational");
  });

  test("joins the facts with the theme's separator and says nothing when there are none", () => {
    const health: RuntimeHealth = {
      level: "busy",
      headline: "1 operation running.",
      facts: [
        { label: "running", value: "1" },
        { label: "queued", value: "2" },
      ],
    };
    expect(healthFactsLine(health, "·")).toBe("running 1 · queued 2");
    expect(healthFactsLine({ ...health, facts: [] }, "·")).toBe("");
  });
});
