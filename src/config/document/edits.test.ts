import { describe, expect, test } from "bun:test";
import { planConfigurationEdits } from "./edits.ts";

describe("source-preserving configuration edits", () => {
  for (const eol of ["\n", "\r\n"]) {
    for (const indent of ["  ", "\t"]) {
      test(`changes only the selected token with ${JSON.stringify({ eol, indent })}`, () => {
        const source = [
          "// café 🌱",
          "{",
          `${indent}"schemaVersion": 1,`,
          `${indent}// level`,
          `${indent}"diagnostics": { /* inside */ "level": "info", }, // after`,
          "}",
          "// end",
          "",
        ].join(eol);
        const result = planConfigurationEdits(source, [
          { kind: "set", path: ["diagnostics", "level"], value: "warn" },
        ]);
        expect(result).toMatchObject({
          kind: "planned",
          text: source.replace('"info"', '"warn"'),
          changedPaths: ["diagnostics.level"],
        });
        expect(
          planConfigurationEdits(source, [
            { kind: "set", path: ["diagnostics", "level"], value: "info" },
          ]),
        ).toMatchObject({ kind: "planned", text: source, changedPaths: [] });
      });
    }
  }

  test("updates an object without rewriting its unchanged children", () => {
    const source =
      '{"models": {"policy": { /* role */ "roles": { "fast": "old", "default": /* pinned */ "same" }, "revision": 1 }}}';
    const result = planConfigurationEdits(source, [
      {
        kind: "set",
        path: ["models", "policy"],
        value: { roles: { fast: "new", default: "same" }, revision: 2 },
      },
    ]);
    expect(result).toMatchObject({
      kind: "planned",
      text: source.replace('"old"', '"new"').replace('"revision": 1', '"revision": 2'),
    });
  });

  for (const source of [
    '{"a": { // before\n "x": /* inside */ 1, // after\n "y": 2, }}',
    '{"a": { "y": 2, // before\n "x": /* inside */ 1 // after\n }}',
    '{"a": { // before\n "x": /* inside */ 1, // after\n }}',
  ]) {
    test(`reset keeps comments and the authored parent: ${source}`, () => {
      const result = planConfigurationEdits(source, [{ kind: "remove", path: ["a", "x"] }]);
      expect(result.kind).toBe("planned");
      if (result.kind !== "planned") return;
      expect(result.text).toContain("// before");
      expect(result.text).toContain("/* inside */");
      expect(result.text).toContain("// after");
      expect(result.document.a).not.toHaveProperty("x");
    });
  }

  test("keeps comment-only files and trailing comments", () => {
    for (const source of ["", "// keep", "/* keep */\r\n"]) {
      const result = planConfigurationEdits(source, [{ kind: "set", path: ["a"], value: 1 }]);
      expect(result.kind).toBe("planned");
      if (result.kind === "planned") expect(result.text.startsWith(source)).toBe(true);
    }
  });

  test("refuses malformed, duplicate, oversized and unsafe documents", () => {
    for (const source of [
      '{"a":',
      '{"a":1,"a":2}',
      '{"a":{"x":1,"x":2}}',
      '{"__proto__":{}}',
      `/*${"x".repeat(256 * 1024)}*/{}`,
    ]) {
      expect(planConfigurationEdits(source, [{ kind: "set", path: ["a"], value: 3 }]).kind).toBe(
        "rejected",
      );
    }
    expect(
      planConfigurationEdits("{}", [{ kind: "set", path: ["__proto__", "polluted"], value: true }])
        .kind,
    ).toBe("rejected");
  });
});
