/**
 * The wrap cache.
 *
 * Speed is the reason it exists and the least interesting thing about it. What
 * these tests hold is that it is bounded, that it cannot serve a frame measured
 * under a theme or capability that no longer applies, and that dropping a
 * projection actually drops what it displayed — the last one because cached text
 * is *content*, and a cache that outlived its owner would keep a file or a model
 * reply reachable after everything else had let go of it.
 */

import { describe, expect, test } from "bun:test";
import { wrapToWidth } from "../domain/index.ts";
import { createTextCache, MAX_CACHE_CHARACTERS, MAX_CACHE_ENTRIES } from "./text-cache.ts";

const PARAGRAPH =
  "The interface is running but nothing is behind it yet, which is a true " +
  "statement about this build rather than a placeholder waiting to be replaced.";

describe("wrapping", () => {
  test("agrees with the domain's own function", () => {
    // A cache that returned something different from the thing it is caching
    // would be a second wrapping rule, and the two would disagree at exactly the
    // widths nobody tested.
    const cache = createTextCache({ generation: 1 });
    for (const width of [10, 24, 40, 80]) {
      expect(cache.wrap(PARAGRAPH, width)).toEqual(wrapToWidth(PARAGRAPH, width));
    }
  });

  test("returns the same value on a hit", () => {
    const cache = createTextCache({ generation: 1 });
    const first = cache.wrap(PARAGRAPH, 40);
    // Identity, not equality: a hit that re-measured would be a miss wearing a
    // hit's clothes, and the whole point is not to measure twice.
    expect(cache.wrap(PARAGRAPH, 40)).toBe(first);
    expect(cache.size()).toBe(1);
  });

  test("keys on the width, so a resize re-measures", () => {
    const cache = createTextCache({ generation: 1 });
    cache.wrap(PARAGRAPH, 40);
    cache.wrap(PARAGRAPH, 41);
    expect(cache.size()).toBe(2);
    expect(cache.wrap(PARAGRAPH, 40)).not.toBe(cache.wrap(PARAGRAPH, 41));
  });
});

describe("the bounds", () => {
  test("hold on entry count", () => {
    const cache = createTextCache({ generation: 1, maxEntries: 4 });
    for (let index = 0; index < 20; index += 1) {
      cache.wrap(`line ${index}`, 40);
    }
    expect(cache.size()).toBe(4);
  });

  test("hold on retained characters, not only on entries", () => {
    // Five hundred one-line labels and five hundred whole files are the same
    // count and are not the same amount of retained content.
    const cache = createTextCache({ generation: 1, maxEntries: 1000, maxCharacters: 200 });
    for (let index = 0; index < 40; index += 1) {
      cache.wrap(`${PARAGRAPH} ${index}`, 40);
    }
    expect(cache.characters()).toBeLessThanOrEqual(200);
    expect(cache.size()).toBeGreaterThan(0);
  });

  test("evict the least recently used", () => {
    const cache = createTextCache({ generation: 1, maxEntries: 2 });
    cache.wrap("first", 40);
    cache.wrap("second", 40);
    // Touching `first` makes `second` the oldest, so the next insert drops it.
    const first = cache.wrap("first", 40);
    cache.wrap("third", 40);

    expect(cache.wrap("first", 40)).toBe(first);
    expect(cache.size()).toBe(2);
  });

  test("measure but never store a value larger than the whole budget", () => {
    // Admitting it would evict everything else to hold one item that does not
    // fit, which is worse than missing on it every time.
    const cache = createTextCache({ generation: 1, maxCharacters: 50 });
    const huge = "x".repeat(500);
    expect(cache.wrap(huge, 40)).toEqual(wrapToWidth(huge, 40));
    expect(cache.size()).toBe(0);
  });

  test("declare defaults a long session can actually live within", () => {
    expect(MAX_CACHE_ENTRIES).toBeGreaterThan(0);
    expect(MAX_CACHE_CHARACTERS).toBeGreaterThan(0);
  });
});

describe("letting go", () => {
  test("drops everything on discard", () => {
    // How displayed content stops being reachable when its projection goes away.
    const cache = createTextCache({ generation: 1 });
    cache.wrap(PARAGRAPH, 40);
    expect(cache.size()).toBe(1);

    cache.discard();
    expect(cache.size()).toBe(0);
    expect(cache.characters()).toBe(0);
  });

  test("drops everything when the generation changes", () => {
    // A frame measured under the old theme cannot be served under the new one,
    // and the check is a number comparison rather than a palette diff.
    const cache = createTextCache({ generation: 1 });
    const first = cache.wrap(PARAGRAPH, 40);
    cache.reset(2);

    expect(cache.size()).toBe(0);
    expect(cache.wrap(PARAGRAPH, 40)).not.toBe(first);
  });

  test("keeps everything when the generation did not change", () => {
    // `reset` runs on every render. One that cleared unconditionally would make
    // the cache a slower way of doing no caching at all.
    const cache = createTextCache({ generation: 7 });
    const first = cache.wrap(PARAGRAPH, 40);
    cache.reset(7);
    expect(cache.wrap(PARAGRAPH, 40)).toBe(first);
  });

  test("cannot serve content from a generation it has moved past", () => {
    // The property stated directly: no sequence of resets brings an old
    // measurement back.
    const cache = createTextCache({ generation: 1 });
    const first = cache.wrap("secret value", 40);
    cache.reset(2);
    cache.reset(1);
    expect(cache.wrap("secret value", 40)).not.toBe(first);
  });
});
