import { expect, test } from "bun:test";
import {
  coveredRangesUnchanged,
  lowerTextReplacements,
  textReplacementsInputSchema,
} from "./text-replacements.ts";
import { applyPatchHunks, joinPatchedLines } from "./workspace-patch.ts";
import { splitLines } from "./workspace-read.ts";

const encode = (value: string) => new TextEncoder().encode(value);
const whole = (bytes: Uint8Array) => [{ offset: 0, length: bytes.length }];
const item = (itemId: string, oldText: string, newText: string, replaceAll = false) => ({
  itemId,
  oldText,
  newText,
  replaceAll,
});
/** Apply lowered hunks the way the native executor does and return the resulting text. */
function patched(
  source: string,
  bytes = encode(source),
  coverage = whole(bytes),
  items = [item("a", "x", "y")],
) {
  const lowered = lowerTextReplacements(bytes, coverage, items);
  if (!lowered.ok) return lowered.error;
  const style = source.includes("\r\n") ? "crlf" : "lf";
  const applied = applyPatchHunks(
    splitLines(source.replace(/^\uFEFF/u, "")),
    lowered.value.hunks.map((hunk, index) => ({ ...hunk, index, addressDigest: null })),
  );
  if (!applied.ok) throw new Error(applied.error.code);
  return joinPatchedLines(applied.value.lines, style, /[\r\n]$/u.test(source));
}

test("the provider-visible example validates and omitted conveniences normalize", () => {
  const example = {
    version: 1,
    kind: "text-replacements",
    freshness: "exact-revision",
    dependencies: [],
    targets: [
      {
        itemId: "source",
        evidenceRef: "resource-evidence-0f6c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
        replacements: [
          {
            itemId: "source-name",
            oldText: "export const oldName =",
            newText: "export const newName =",
            replaceAll: false,
          },
        ],
      },
      {
        itemId: "test",
        evidenceRef: "resource-evidence-1f6c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b",
        replacements: [
          {
            itemId: "test-import",
            oldText: "import { oldName }",
            newText: "import { newName }",
            replaceAll: false,
          },
        ],
      },
    ],
  };
  expect(textReplacementsInputSchema.safeParse(example).success).toBe(true);
  const minimal = textReplacementsInputSchema.parse({
    version: 1,
    kind: "text-replacements",
    targets: [
      {
        itemId: "t",
        evidenceRef: "resource-evidence-a1",
        replacements: [{ itemId: "r", oldText: "a", newText: "b" }],
      },
    ],
  });
  expect(minimal).toMatchObject({
    freshness: "exact-revision",
    dependencies: [],
    targets: [{ replacements: [{ replaceAll: false }] }],
  });
  const nine = Array.from({ length: 9 }, (_, index) => ({
    itemId: `t${index}`,
    evidenceRef: "resource-evidence-a1",
    replacements: [{ itemId: `r${index}`, oldText: "a", newText: "b", replaceAll: false }],
  }));
  // Nine targets exceed the native plan's default, so preparation refuses them up front.
  expect(
    textReplacementsInputSchema.safeParse({ ...example, targets: nine.slice(0, 8) }).success,
  ).toBe(true);
  for (const broken of [
    { ...example, targets: nine },
    { ...example, extra: true },
    { ...example, version: 2 },
    { ...example, freshness: "fuzzy" },
    { ...example, targets: [] },
    { ...example, targets: [{ ...example.targets[0], evidenceRef: "src/a.ts" }] },
    { ...example, targets: [{ ...example.targets[0], replacements: [item("x", "", "y")] }] },
    { ...example, targets: [example.targets[0], { ...example.targets[1], itemId: "source" }] },
  ])
    expect(textReplacementsInputSchema.safeParse(broken).success).toBe(false);
});

test("exact replacements lower to native hunks that reproduce the requested text", () => {
  const source = "alpha beta\ngamma zeta\ndelta\n";
  expect(patched(source, undefined, undefined, [item("a", "alpha beta", "ALPHA")])).toBe(
    "ALPHA\ngamma zeta\ndelta\n",
  );
  // Two disjoint edits on one line share one hunk; neither sees the other's output.
  const both = lowerTextReplacements(encode(source), whole(encode(source)), [
    item("one", "gamma", "beta"),
    item("two", "zeta", "X"),
  ]);
  expect(both).toMatchObject({
    ok: true,
    value: {
      hunks: [{ hunkId: "one+two", oldStart: 2, oldLines: ["gamma zeta"], newLines: ["beta X"] }],
    },
  });
  // Multi-line old text and a deletion that consumes a line break.
  expect(patched(source, undefined, undefined, [item("a", "beta\ngamma", "B\nC\nD")])).toBe(
    "alpha B\nC\nD zeta\ndelta\n",
  );
  expect(patched(source, undefined, undefined, [item("a", "gamma zeta\n", "")])).toBe(
    "alpha beta\ndelta\n",
  );
  expect(patched(source, undefined, undefined, [item("a", "beta\n", "")])).toBe(
    "alpha gamma zeta\ndelta\n",
  );
});

test("line endings, BOM and a missing final newline are preserved", () => {
  const crlf = "one\r\ntwo\r\nthree\r\n";
  // Line breaks in both texts are written in the file's CRLF style.
  expect(patched(crlf, undefined, undefined, [item("a", "two\nthr", "2\nTHR")])).toBe(
    "one\r\n2\r\nTHRee\r\n",
  );
  expect(patched(crlf, undefined, undefined, [item("a", "two", "2\n2b")])).toBe(
    "one\r\n2\r\n2b\r\nthree\r\n",
  );
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encode("héllo\nworld")]);
  expect(patched("\uFEFFhéllo\nworld", bom, whole(bom), [item("a", "world", "monde")])).toBe(
    "héllo\nmonde",
  );
  // Any break in old text means the file's own break, so a CRLF pair is never split.
  expect(patched("a\r\nb\r\n", undefined, undefined, [item("a", "a\r", "x")])).toBe("xb\r\n");
  // Removing the final line break cannot be expressed by native line hunks.
  expect(
    lowerTextReplacements(encode("a\nb\n"), whole(encode("a\nb\n")), [item("a", "b\n", "c")]),
  ).toMatchObject({
    ok: false,
    error: { code: "unrepresentable-replacement" },
  });
  for (const bytes of [
    encode("a\r\nb\nc"),
    new Uint8Array([0xff, 0xfe, 0x61, 0x00]),
    encode("a\0b"),
  ])
    expect(lowerTextReplacements(bytes, whole(bytes), [item("a", "a", "b")])).toMatchObject({
      ok: false,
      error: { code: "unsupported-fidelity" },
    });
});

test("uniqueness and replace-all never reach beyond the evidence", () => {
  const source = "value = 1\nvalue = 2\nvalue = 3\n";
  const bytes = encode(source);
  const secondLine = [{ offset: 10, length: 10 }];
  expect(lowerTextReplacements(bytes, whole(bytes), [item("a", "value =", "v =")])).toMatchObject({
    ok: false,
    error: { code: "ambiguous-match", matches: 3 },
  });
  // Unique inside the excerpt that was read, even though the file repeats it elsewhere.
  expect(lowerTextReplacements(bytes, secondLine, [item("a", "value =", "v =")])).toMatchObject({
    ok: true,
    value: {
      scope: "covered-ranges",
      hunks: [{ oldStart: 2 }],
      items: [{ matches: 1, lines: [{ start: 2, end: 2 }] }],
    },
  });
  expect(lowerTextReplacements(bytes, secondLine, [item("a", "= 3", "= 4")])).toMatchObject({
    ok: false,
    error: { code: "match-outside-evidence" },
  });
  expect(lowerTextReplacements(bytes, secondLine, [item("a", "absent", "x")])).toMatchObject({
    ok: false,
    error: { code: "no-match" },
  });
  expect(lowerTextReplacements(bytes, secondLine, [item("a", "value", "v", true)])).toMatchObject({
    ok: false,
    error: { code: "replace-all-needs-complete-evidence" },
  });
  expect(patched(source, bytes, whole(bytes), [item("a", "value", "v", true)])).toBe(
    "v = 1\nv = 2\nv = 3\n",
  );
  expect(
    lowerTextReplacements(encode("aaa\n"), whole(encode("aaa\n")), [item("a", "aa", "b")]),
  ).toMatchObject({
    ok: false,
    error: { code: "ambiguous-match", matches: 2 },
  });
  expect(
    lowerTextReplacements(bytes, whole(bytes), [
      item("a", "value = 1\nvalue", "x"),
      item("b", "value = 2", "y"),
    ]),
  ).toMatchObject({
    ok: false,
    error: { code: "overlapping-replacements", itemIds: ["a", "b"] },
  });
});

test("covered ranges must be byte-identical at their original offsets", () => {
  const before = encode("keep\ntarget line\ntail\n");
  const range = [{ offset: 5, length: 12 }];
  expect(coveredRangesUnchanged(before, encode("keep\ntarget line\nTAIL\n"), range)).toBe(true);
  // Same text shifted by an inserted line is not the same evidence.
  expect(coveredRangesUnchanged(before, encode("new\nkeep\ntarget line\ntail\n"), range)).toBe(
    false,
  );
  expect(coveredRangesUnchanged(before, encode("keep\n"), range)).toBe(false);
});
