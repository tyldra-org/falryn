/**
 * Height reuse is the other half of a bounded window: placing the window is
 * cheap only when measuring the history is not a wrap of every block.
 */

import { describe, expect, test } from "bun:test";
import { type BlockDescriptor, type HeightBatch, reconcileHeights } from "./measure.ts";

function descriptors(count: number, stamp = "c:2"): readonly BlockDescriptor[] {
  return Array.from({ length: count }, (_unused, index) => ({
    key: `b${index}`,
    stamp,
  }));
}

function materializeFrom(heights: readonly number[]): {
  readonly calls: number[];
  readonly heightOf: (index: number) => { readonly rows: number; readonly built: null };
} {
  const calls: number[] = [];
  return {
    calls,
    heightOf: (index) => {
      calls.push(index);
      return { rows: heights[index] ?? 2, built: null };
    },
  };
}

describe("a first measurement", () => {
  test("materializes every block and records a rebuild", () => {
    const work = materializeFrom(Array.from({ length: 4 }, () => 2));
    const batch = reconcileHeights(null, descriptors(4), work.heightOf);
    expect(batch.kind).toBe("rebuild");
    expect(batch.examined).toBe(4);
    expect(work.calls).toEqual([0, 1, 2, 3]);
    expect(batch.records.map((record) => record.rows)).toEqual([2, 2, 2, 2]);
  });
});

describe("an unchanged history", () => {
  test("examines nothing", () => {
    const first = reconcileHeights(null, descriptors(10_000), () => ({ rows: 2, built: null }));
    const work = materializeFrom([]);
    const again = reconcileHeights(first, descriptors(10_000), work.heightOf);
    expect(again.kind).toBe("reuse");
    expect(again.examined).toBe(0);
    expect(work.calls).toEqual([]);
    expect(again.records).toBe(first.records);
  });
});

describe("appending", () => {
  test("materializes only the new suffix", () => {
    const prior = reconcileHeights(null, descriptors(10_000), () => ({ rows: 2, built: null }));
    const work = materializeFrom(Array.from({ length: 10_002 }, () => 2));
    const next = reconcileHeights(prior, descriptors(10_002), work.heightOf);
    expect(next.kind).toBe("append");
    expect(next.examined).toBe(2);
    expect(work.calls).toEqual([10_000, 10_001]);
    expect(next.records).toHaveLength(10_002);
  });
});

describe("a tail revision", () => {
  test("materializes from the first changed stamp", () => {
    const prior = reconcileHeights(null, descriptors(1_000), () => ({ rows: 2, built: null }));
    const nextDescriptors: BlockDescriptor[] = [
      ...descriptors(999),
      { key: "b999", stamp: "x:80:grew" },
    ];
    const work = materializeFrom(
      Array.from({ length: 1_000 }, (_unused, index) => (index === 999 ? 6 : 2)),
    );
    const next = reconcileHeights(prior, nextDescriptors, work.heightOf);
    expect(next.kind).toBe("revise-suffix");
    expect(next.examined).toBe(1);
    expect(work.calls).toEqual([999]);
    expect(next.records[999]?.rows).toBe(6);
    expect(next.records[0]).toBe(prior.records[0]);
  });
});

describe("a prefix change", () => {
  test("rebuilds rather than trusting a matching tail", () => {
    const prior = reconcileHeights(null, descriptors(8), () => ({ rows: 2, built: null }));
    const nextDescriptors: BlockDescriptor[] = [
      { key: "b0", stamp: "c:1" },
      ...descriptors(8).slice(1),
    ];
    const work = materializeFrom(Array.from({ length: 8 }, () => 2));
    const next = reconcileHeights(prior, nextDescriptors, work.heightOf);
    expect(next.kind).toBe("rebuild");
    expect(next.examined).toBe(8);
    expect(work.calls).toHaveLength(8);
  });
});

describe("a shortened history", () => {
  test("rebuilds", () => {
    const prior: HeightBatch = reconcileHeights(null, descriptors(8), () => ({
      rows: 2,
      built: null,
    }));
    const work = materializeFrom([2, 2, 2]);
    const next = reconcileHeights(prior, descriptors(3), work.heightOf);
    expect(next.kind).toBe("rebuild");
    expect(next.examined).toBe(3);
  });
});
