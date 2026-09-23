import { describe, expect, test } from "bun:test";
import { ORDER_KEY_MAX, orderKeyBetween, spreadOrderKeys } from "./work-hierarchy.ts";

describe("opaque sibling order keys", () => {
  test("always land strictly between their neighbours and never end in the lowest character", () => {
    const keys = ["item-a", "item-b"];
    let seed = 7;
    for (let round = 0; round < 500; round += 1) {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
      const index = seed % (keys.length + 1);
      const key = orderKeyBetween(keys[index - 1] ?? null, keys[index] ?? null);
      if (index > 0) expect(key > (keys[index - 1] ?? "")).toBeTrue();
      if (index < keys.length) expect(key < (keys[index] ?? "")).toBeTrue();
      expect(key.endsWith("!")).toBeFalse();
      keys.splice(index, 0, key);
    }
    expect(keys).toEqual(keys.toSorted());
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("repeated insertion at one spot grows keys until the store must respace", () => {
    let low = "a";
    let grew = 0;
    for (let round = 0; round < 2_000 && grew <= ORDER_KEY_MAX; round += 1) {
      low = orderKeyBetween(low, "b");
      grew = low.length;
    }
    expect(grew).toBeGreaterThan(ORDER_KEY_MAX);
  });

  test("respacing yields short, distinct, ordered keys", () => {
    for (const count of [1, 2, 93, 94, 1_000]) {
      const keys = spreadOrderKeys(count);
      expect(keys).toHaveLength(count);
      expect(keys).toEqual(keys.toSorted());
      expect(new Set(keys).size).toBe(count);
      expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(3);
      expect(keys.some((key) => key.endsWith("!"))).toBeFalse();
    }
  });

  test("refuses an empty or inverted range", () => {
    expect(() => orderKeyBetween("b", "a")).toThrow("order-key-range");
    expect(() => orderKeyBetween("a", "a")).toThrow("order-key-range");
  });
});
