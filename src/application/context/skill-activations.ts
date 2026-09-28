/**
 * Skills activated in a session (#136). Once a skill's complete body has been admitted,
 * it stays selected for the session's later turns while it remains eligible, so its
 * instructions are not dropped when a later prompt stops mentioning it. A resumed session
 * recovers the set from its stored admission receipts; nothing here loads a body.
 */
import type { RuntimeEvent } from "../../domain/sessions/index.ts";

export const MAX_ACTIVE_SKILLS = 16;

export type SkillActivations = {
  active(): readonly string[];
  /** Record the skills whose bodies an admitted turn loaded. */
  record(names: readonly string[]): void;
};

export function createSkillActivations(seed: readonly string[] = []): SkillActivations {
  const names: string[] = [];
  const add = (name: string) => {
    const index = names.indexOf(name);
    if (index >= 0) names.splice(index, 1);
    names.push(name);
    // The most recently used stay; the oldest activation is released first.
    if (names.length > MAX_ACTIVE_SKILLS) names.shift();
  };
  for (const name of seed) add(name);
  return {
    active: () => [...names],
    record(loaded) {
      for (const name of loaded) add(name);
    },
  };
}

/** The skills an earlier turn loaded, in order, from its admission receipts. */
export function activatedSkills(events: readonly RuntimeEvent[]): string[] {
  return events.flatMap((event) =>
    event.kind === "instructions.resolved" && event.payload.skills
      ? event.payload.skills.routes
          .filter((route) => route.decision === "loaded")
          .map((route) => route.name)
      : [],
  );
}
