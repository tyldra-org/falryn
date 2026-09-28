/**
 * Automatic skill routing before inference (#136).
 *
 * Chooses the smallest relevant set from compact metadata, reusing the opportunity
 * planner's task terms. A skill named in the task, or already active in the session, is
 * selected. Otherwise exactly one clearly best match is selected; ties stay
 * recommendations. Descriptions are untrusted relevance evidence, and a textual match
 * is not a guarantee of semantic fit. Eligibility is decided before this runs: only
 * automatically eligible candidates reach it.
 */
import { tokens } from "../orchestration/opportunity-plan.ts";

export const SKILL_ROUTING = Object.freeze({
  /** Bodies loaded into one request. */
  selections: 4,
  /** Unloaded candidates disclosed to the model. */
  recommendations: 5,
  /** Distinct shared terms for a description match. */
  minimumOverlap: 2,
  taskCharacters: 32_000,
});

export type SkillCandidate = { readonly name: string; readonly description: string };
export type SkillRoute = {
  readonly name: string;
  readonly decision: "selected" | "recommended" | "unavailable";
  /** A routing reason, or the source's problem for an unavailable named skill. */
  readonly reason: string;
};

export function routeSkills(input: {
  readonly task: string;
  readonly candidates: readonly SkillCandidate[];
  /** Skills already activated in this session stay selected while eligible. */
  readonly active: readonly string[];
  /**
   * Automatically eligible skills that cannot load, with the reason. Only one the task
   * names is reported, so the model learns why it is missing.
   */
  readonly unavailable?: readonly { readonly name: string; readonly reason: string }[];
}): readonly SkillRoute[] {
  const task = tokens(input.task.slice(0, SKILL_ROUTING.taskCharacters));
  const byName = new Map(input.candidates.map((candidate) => [candidate.name, candidate]));
  const selected: SkillRoute[] = [];
  const choose = (name: string, reason: string) => {
    if (selected.some((route) => route.name === name)) return;
    selected.push({ name, decision: "selected", reason });
  };
  const names = [...byName.keys()].sort();
  for (const name of names) if (task.has(name)) choose(name, "named-in-task");
  for (const name of [...input.active].sort()) if (byName.has(name)) choose(name, "session-active");
  const matches = names
    .filter((name) => !selected.some((route) => route.name === name))
    .map((name) => {
      const candidate = byName.get(name) as SkillCandidate;
      const terms = tokens(`${name.replaceAll("-", " ")} ${candidate.description}`);
      return { name, overlap: [...task].filter((term) => terms.has(term)).length };
    })
    .filter((match) => match.overlap >= SKILL_ROUTING.minimumOverlap)
    .sort((a, b) => b.overlap - a.overlap || (a.name < b.name ? -1 : 1));
  const [best, next] = matches;
  const clear = best !== undefined && (next === undefined || best.overlap > next.overlap);
  if (clear) choose(best.name, "unambiguous-task-match");
  const recommended: SkillRoute[] = [];
  for (const route of selected.splice(SKILL_ROUTING.selections))
    recommended.push({ ...route, decision: "recommended", reason: "selection-limit" });
  for (const match of matches)
    if (!selected.some((route) => route.name === match.name))
      recommended.push({
        name: match.name,
        decision: "recommended",
        reason: "ambiguous-task-match",
      });
  const missing: SkillRoute[] = (input.unavailable ?? [])
    .filter((item) => task.has(item.name) && !byName.has(item.name))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .map((item) => ({ name: item.name, decision: "unavailable", reason: item.reason }));
  return [...selected, ...recommended.slice(0, SKILL_ROUTING.recommendations), ...missing];
}
