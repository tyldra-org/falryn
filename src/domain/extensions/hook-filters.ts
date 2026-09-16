import type { HookRegistration } from "./hook-handlers.ts";
import type { HookEnvelope } from "./hook-points.ts";

/** Bounded wildcard matching without compiling untrusted regular expressions. */
function glob(pattern: string, value: string): boolean {
  let previous = new Uint8Array(value.length + 1);
  previous[0] = 1;
  for (const character of pattern) {
    const next = new Uint8Array(value.length + 1);
    if (character === "*") next[0] = previous[0] ?? 0;
    for (let i = 1; i <= value.length; i++)
      next[i] =
        character === "*"
          ? previous[i] || (value[i - 1] !== "/" && next[i - 1])
            ? 1
            : 0
          : (character === "?" ? value[i - 1] !== "/" : value[i - 1] === character) &&
              previous[i - 1]
            ? 1
            : 0;
    previous = next;
  }
  return previous[value.length] === 1;
}
export function matchesHookFilters(
  registration: HookRegistration,
  envelope: HookEnvelope,
): boolean {
  return registration.filters.every((filter) => {
    const field = (envelope.payload as Record<string, unknown>)[filter.field];
    const values = Array.isArray(field) ? field : [field];
    return values.some((value) => {
      if (typeof value !== "string" && typeof value !== "number") return false;
      const text = String(value);
      switch (filter.operator) {
        case "exact":
          return text === filter.value;
        case "prefix":
          return text.startsWith(filter.value);
        case "glob":
          return glob(filter.value, text);
      }
      return false;
    });
  });
}
