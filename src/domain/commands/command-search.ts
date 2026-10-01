/**
 * Deterministic, bounded command search (#790).
 *
 * The palette and the composer `/` list rank with this one function, so the same
 * query orders commands the same way everywhere. No model call, no randomness:
 * a match falls into the first tier it satisfies, and ties keep registry order.
 */

import type { CommandRegistry } from "./command-registry.ts";
import { COMMAND_REGISTRY_LIMITS, type CommandSpec } from "./command-spec.ts";

/** Lower is better. Exported so tests and callers can name a tier. */
export const COMMAND_MATCH_TIERS = Object.freeze({
  exact: 0,
  slashPrefix: 1,
  namePrefix: 2,
  wordPrefix: 3,
  substring: 4,
  fuzzy: 5,
});

export type CommandSearchOptions<T extends CommandSpec> = {
  /** Rows to return; at most the registry's entry limit. */
  readonly limit?: number;
  /** Narrows the candidates before ranking, such as to entries with a slash form. */
  readonly include?: (entry: T) => boolean;
};

export function searchCommands<T extends CommandSpec>(
  registry: CommandRegistry<T>,
  query: string,
  options: CommandSearchOptions<T> = {},
): readonly T[] {
  const limit = Math.max(
    0,
    Math.min(options.limit ?? COMMAND_REGISTRY_LIMITS.entries, COMMAND_REGISTRY_LIMITS.entries),
  );
  const candidates = registry.entries.filter((entry) => options.include?.(entry) ?? true);
  const needle = query.trim().toLowerCase().slice(0, COMMAND_REGISTRY_LIMITS.queryCharacters);
  if (needle === "") return candidates.slice(0, limit);

  const ranked: { readonly entry: T; readonly tier: number; readonly order: number }[] = [];
  candidates.forEach((entry, order) => {
    const tier = matchTier(entry, needle);
    if (tier !== null) ranked.push({ entry, tier, order });
  });
  ranked.sort((a, b) => a.tier - b.tier || a.order - b.order);
  return ranked.slice(0, limit).map((match) => match.entry);
}

/** The best tier at which an entry matches a lowercase query, or `null`. */
export function matchTier(entry: CommandSpec, needle: string): number | null {
  const bare = needle.startsWith("/") ? needle.slice(1) : needle;
  const forms = entry.slash.map((slash) => slash.form.slice(1));
  const id = entry.id.toLowerCase();
  const title = entry.title.toLowerCase();

  if (forms.includes(bare) || id === needle) return COMMAND_MATCH_TIERS.exact;
  if (bare !== "" && forms.some((form) => form.startsWith(bare))) {
    return COMMAND_MATCH_TIERS.slashPrefix;
  }
  // A leading `/` asks for slash forms only.
  if (needle.startsWith("/")) return null;
  if (id.startsWith(needle) || title.startsWith(needle)) return COMMAND_MATCH_TIERS.namePrefix;

  const fields = [title, entry.description.toLowerCase(), ...entry.keywords.map(lower)];
  const words = fields.flatMap((field) => field.split(/[^a-z0-9]+/u));
  if (words.some((word) => word.startsWith(needle))) return COMMAND_MATCH_TIERS.wordPrefix;
  if ([id, ...fields].some((field) => field.includes(needle))) {
    return COMMAND_MATCH_TIERS.substring;
  }
  if (isSubsequence(needle, id) || isSubsequence(needle, title)) return COMMAND_MATCH_TIERS.fuzzy;
  return null;
}

function lower(value: string): string {
  return value.toLowerCase();
}

/** Whether every character of `needle` appears in `haystack` in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let position = 0;
  for (const character of haystack) {
    if (character === needle[position]) position += 1;
    if (position === needle.length) return true;
  }
  return false;
}
