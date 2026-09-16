import { expect, test } from "bun:test";
import {
  applyEnvironmentEdits,
  environmentEditsSchema,
  environmentError,
  parseEnvironmentFrame,
} from "./environment.ts";

test("environment edits distinguish absent, empty and unset, including Windows PATH", () => {
  expect(environmentEditsSchema.safeParse({ set: { A: "" }, unset: ["A"] }).success).toBe(false);
  expect(applyEnvironmentEdits({ A: "old", B: "keep" }, { set: { A: "" } }, ":")).toEqual({
    A: "",
    B: "keep",
  });
  expect(
    applyEnvironmentEdits(
      { Path: "C:\\old", REMOVE: "old" },
      { unset: ["remove"], pathPrepend: ["C:\\first"], pathAppend: ["C:\\last"] },
      ";",
    ),
  ).toEqual({ Path: "C:\\first;C:\\old;C:\\last" });
  expect(environmentError({ Path: "first", PATH: "second" }, true)).toBe(
    "ambiguous-environment-name",
  );
  expect(environmentError({ A: "x".repeat(32768) }, false)).toBe("environment-too-large");
});

test("capture framing rejects malformed, duplicate, undeclared, oversized and trailing values", () => {
  const valid = "id\0S\0A\0line=one\nline two\0U\0B\0END\0";
  expect(parseEnvironmentFrame(valid, "id", ["A", "B"])).toEqual({
    set: { A: "line=one\nline two" },
    unset: ["B"],
  });
  for (const frame of [
    valid.slice(0, -1),
    `${valid}extra`,
    valid.replace("U\0B", "U\0A"),
    valid.replace("U\0B", "U\0C"),
    valid.replace("line=one\nline two", "x".repeat(32768)),
    "id\0END\0",
  ])
    expect(parseEnvironmentFrame(frame, "id", ["A", "B"])).toBeNull();
  expect(environmentEditsSchema.safeParse(JSON.parse('{"set":{"__proto__":"bad"}}')).success).toBe(
    false,
  );
});
