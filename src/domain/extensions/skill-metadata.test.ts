import { expect, test } from "bun:test";
import { readSkillEntrypoint } from "./skill-metadata.ts";

const base = { name: "release-notes", description: "Draft release notes from merged changes." };

test("the invocation matrix: each restriction removes exactly one kind of invocation", () => {
  const rows = [
    [{}, { user: true, automatic: true }],
    [{ "disable-model-invocation": true }, { user: true, automatic: false }],
    [{ "user-invocable": false }, { user: false, automatic: true }],
    [
      { "disable-model-invocation": true, "user-invocable": false },
      { user: false, automatic: false },
    ],
    [
      { "disable-model-invocation": false, "user-invocable": true },
      { user: true, automatic: true },
    ],
  ] as const;
  for (const [restrictions, invocation] of rows)
    expect(readSkillEntrypoint({ ...base, ...restrictions }, "release-notes")).toEqual({
      ok: true,
      name: "release-notes",
      description: base.description,
      invocation,
      unsupported: null,
    });
});

test("malformed restrictions fail closed instead of defaulting to permissive", () => {
  for (const value of ["true", 1, null, "false"])
    for (const field of ["disable-model-invocation", "user-invocable"])
      expect(readSkillEntrypoint({ ...base, [field]: value }, "release-notes")).toEqual({
        ok: false,
        problem: "malformed-eligibility",
      });
});

test("the header, directory name and execution controls are checked; inert metadata is kept", () => {
  expect(readSkillEntrypoint(base, "other-name")).toEqual({ ok: false, problem: "name-mismatch" });
  expect(readSkillEntrypoint({ name: "Release Notes", description: "x" }, "Release Notes")).toEqual(
    { ok: false, problem: "malformed-metadata" },
  );
  expect(readSkillEntrypoint({ name: "release-notes" }, "release-notes")).toEqual({
    ok: false,
    problem: "malformed-metadata",
  });
  expect(
    readSkillEntrypoint({ ...base, model: "opus", context: "fork" }, "release-notes"),
  ).toMatchObject({ ok: true, unsupported: "model" });
  // A tool list is a hint that grants nothing, and unknown fields are inert.
  expect(
    readSkillEntrypoint(
      { ...base, "allowed-tools": "Bash(rm:*)", "argument-hint": "[version]" },
      "release-notes",
    ),
  ).toMatchObject({ ok: true, unsupported: null, invocation: { user: true, automatic: true } });
});
