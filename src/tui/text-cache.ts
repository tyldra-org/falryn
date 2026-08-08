/**
 * A bounded cache for wrapped text.
 *
 * Wrapping measures every character's display width, so it is linear in the text
 * and repeated on every frame that redraws the same paragraph at the same width
 * — which, for rendered transcript content, is most frames. Caching it is the difference
 * between a resize being smooth and being a re-measure of the whole scrollback.
 *
 * Two properties matter more than the speed.
 *
 * **It is bounded.** A cache that grows with the content is a leak with a
 * friendly name. Entries beyond the bound are evicted least-recently-used, so a
 * long session costs a fixed amount rather than an increasing one.
 *
 * **It cannot retain content past its owner.** Cached text is *content* — a
 * file, a model reply, a value out of a configuration file — and a cache that
 * outlived the projection it belonged to would keep it reachable after
 * everything else had let go. `discard()` is the operation that makes dropping a
 * projection actually drop what it displayed, and the generation stamp means a
 * theme or capability change cannot serve a frame measured under the old one.
 *
 * The key is the text itself rather than a digest of it. A digest would cost a
 * pass over the same string this function is trying to avoid passing over, and
 * would trade an exact key for one that can collide. The bound is on entries and
 * on total characters held, so keying by content does not turn the cache into an
 * unbounded copy of everything ever rendered.
 */

import { wrapToWidth } from "../domain/index.ts";

/** Entries held before the least recently used is dropped. */
export const MAX_CACHE_ENTRIES = 512;

/**
 * Characters held across all entries.
 *
 * A second bound because entries alone do not bound memory: five hundred
 * one-line labels and five hundred whole files are the same count and are not
 * the same amount of retained content.
 */
export const MAX_CACHE_CHARACTERS = 256 * 1024;

export type TextCache = {
  /** Wrapped lines, measured or recalled. Always correct for this generation. */
  wrap(text: string, width: number): readonly string[];
  /**
   * Drops everything.
   *
   * For the projection that owned the content going away. Nothing calls it
   * yet — there is no projection to tear down until the transcript exists — so
   * the retention guarantee this delivery actually keeps is the generation one
   * below, and this is the seam its owner will use. Stated rather than implied,
   * because a method that reads as live cleanup and has no caller is worse than
   * one that says it is waiting for a caller.
   */
  discard(): void;
  /** Entries currently held. Exposed so the bound is testable rather than asserted. */
  size(): number;
  /** Characters currently held, by the same reasoning. */
  characters(): number;
};

export type TextCacheOptions = {
  /**
   * The theme and capability generation this cache is measured under.
   *
   * A single number rather than two, because a caller that had to remember to
   * pass both would eventually pass one. `AppShell` combines them.
   */
  readonly generation: number;
  readonly maxEntries?: number;
  readonly maxCharacters?: number;
};

export function createTextCache(options: TextCacheOptions): TextCache & {
  /** Rebinds the generation, discarding anything measured under the old one. */
  reset(generation: number): void;
} {
  const maxEntries = options.maxEntries ?? MAX_CACHE_ENTRIES;
  const maxCharacters = options.maxCharacters ?? MAX_CACHE_CHARACTERS;

  let generation = options.generation;
  // Insertion order is recency order: a `Map` preserves it, and re-inserting on
  // a hit moves an entry to the end. That is a complete LRU with no bookkeeping.
  let entries = new Map<string, readonly string[]>();
  let characters = 0;

  const clear = (): void => {
    entries = new Map();
    characters = 0;
  };

  const evictWhileOverBound = (): void => {
    while (entries.size > maxEntries || characters > maxCharacters) {
      const oldest = entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      const dropped = entries.get(oldest.value);
      entries.delete(oldest.value);
      characters -= weigh(dropped ?? []);
    }
  };

  return {
    wrap(text: string, width: number): readonly string[] {
      // `\0` as the separator, written as an escape and never as a literal byte.
      // The escape matters twice over: a raw NUL in the source makes Git treat
      // this file as binary, which removes it from every diff and every review.
      // The character matters because text can contain anything else — a space
      // separator would let generation 1 at width 40 collide with generation 1
      // at width 4 over text beginning "0 ", and the two would serve each
      // other's frames.
      const key = `${generation}\0${width}\0${text}`;
      const hit = entries.get(key);
      if (hit !== undefined) {
        // Re-inserted so a repeatedly used entry stays furthest from eviction.
        entries.delete(key);
        entries.set(key, hit);
        return hit;
      }

      const wrapped = wrapToWidth(text, width);
      const weight = weigh(wrapped);
      // A single value larger than the whole budget is measured and returned but
      // never stored: admitting it would evict everything else to hold one item
      // that will not fit, which is worse than missing on it every time.
      if (weight > maxCharacters) {
        return wrapped;
      }

      entries.set(key, wrapped);
      characters += weight;
      evictWhileOverBound();
      return wrapped;
    },

    discard: clear,

    reset(next: number): void {
      if (next === generation) {
        return;
      }
      generation = next;
      clear();
    },

    size: () => entries.size,
    characters: () => characters,
  };
}

function weigh(lines: readonly string[]): number {
  let total = 0;
  for (const line of lines) {
    total += line.length;
  }
  return total;
}
