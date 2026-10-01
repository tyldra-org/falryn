import { expect, test } from "bun:test";
import { mergeTimings, parseTimings } from "./test-timings.ts";

test("shard records replace the previous durations, keep unmeasured files and drop removed ones", () => {
  const previous = {
    version: 1 as const,
    files: { "b.test.ts": 9, "a.test.ts": 1, "gone.test.ts": 5 },
  };
  const shards = [
    { version: 1 as const, files: { "a.test.ts": 2 } },
    { version: 1 as const, files: { "c.test.ts": 3 } },
  ];
  const merged = mergeTimings(previous, shards, new Set(["a.test.ts", "b.test.ts", "c.test.ts"]));
  expect(merged).toEqual({ version: 1, files: { "a.test.ts": 2, "b.test.ts": 9, "c.test.ts": 3 } });
  expect(Object.keys(merged.files)).toEqual(["a.test.ts", "b.test.ts", "c.test.ts"]);
  expect(mergeTimings(null, shards, new Set(["c.test.ts"])).files).toEqual({ "c.test.ts": 3 });
});

test("only a well-formed timings document is accepted", () => {
  expect(parseTimings('{"version":1,"files":{"a.test.ts":12}}')).toEqual({
    version: 1,
    files: { "a.test.ts": 12 },
  });
  for (const bad of ["", "[]", '{"version":2,"files":{}}', '{"version":1,"files":{"a":-1}}'])
    expect(parseTimings(bad)).toBeNull();
});
