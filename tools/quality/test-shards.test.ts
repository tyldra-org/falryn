import { expect, test } from "bun:test";
import { shardArguments, shardSummary, testShardCount } from "./test-shards.ts";

test("shard count follows the cores, bounded, and honours a valid override only", () => {
  expect(testShardCount(undefined, 8)).toEqual({ ok: true, shards: 4 });
  expect(testShardCount(undefined, 16)).toEqual({ ok: true, shards: 4 });
  expect(testShardCount(undefined, 2)).toEqual({ ok: true, shards: 1 });
  expect(testShardCount(undefined, 1)).toEqual({ ok: true, shards: 1 });
  expect(testShardCount("", 8)).toEqual({ ok: true, shards: 4 });
  expect(testShardCount("6", 2)).toEqual({ ok: true, shards: 6 });
  for (const bad of ["0", "17", "2.5", "four"]) expect(testShardCount(bad, 8).ok).toBe(false);
});

test("every shard balances by the recorded timings and leaves compiled suites to the smoke runs", () => {
  expect(shardArguments(2, 4, ["--only-failures"])).toEqual([
    "test",
    "--shard=2/4",
    "--timings=.github/test-timings.json",
    "--path-ignore-patterns=**/*.compiled.test.ts",
    "--only-failures",
  ]);
  expect(shardArguments(1, 1, [])).not.toContain("--shard=1/1");
});

test("one failing shard fails the run and is named", () => {
  const passed = { exitCode: 0, seconds: 100, ran: "Ran 10 tests across 2 files" };
  expect(
    shardSummary(
      [
        { shard: 2, ...passed },
        { shard: 1, exitCode: 1, seconds: 90, ran: null },
      ],
      2,
      101,
    ),
  ).toEqual([
    "shard 1/2 failed (exit 1) in 90s",
    "shard 2/2 passed in 100s — Ran 10 tests across 2 files",
    "1 of 2 shards failed after 101s: 1",
  ]);
  expect(shardSummary([{ shard: 1, ...passed }], 1, 100).at(-1)).toBe(
    "all 1 shards passed in 100s",
  );
});
