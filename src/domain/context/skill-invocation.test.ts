import { expect, test } from "bun:test";
import {
  completeSkillCommand,
  parseSkillsCommand,
  resolveSkillCommand,
  skillCatalogLines,
} from "./skill-invocation.ts";

const skills = new Set(["deploy", "release-notes", "review"]);
const templates = new Set(["review"]);

test("only a leading slash command naming a skill resolves; templates force qualification", () => {
  expect(resolveSkillCommand("/deploy now", { skills, templates })).toEqual({
    kind: "skill",
    name: "deploy",
    qualified: false,
  });
  expect(resolveSkillCommand("/skill:review", { skills, templates })).toEqual({
    kind: "skill",
    name: "review",
    qualified: true,
  });
  expect(resolveSkillCommand("/review", { skills, templates })).toEqual({
    kind: "ambiguous",
    name: "review",
  });
  // A qualified name reaches the owner even when unknown, so admission reports why.
  expect(resolveSkillCommand("/skill:missing", { skills, templates })?.kind).toBe("skill");
  for (const text of ["/missing", "please /deploy", "/skills", "/kit:review", "/skill:Bad"])
    expect(resolveSkillCommand(text, { skills, templates })).toBeNull();
});

test("/skills takes an optional filter and page offset", () => {
  expect(parseSkillsCommand("/skills")).toEqual({ filter: null, offset: 0 });
  expect(parseSkillsCommand("/skills rel after 100")).toEqual({ filter: "rel", offset: 100 });
  expect(parseSkillsCommand("/skill")).toBeNull();
});

test("completion extends a command prefix to invocable skills only", () => {
  const catalog = { invocable: new Set(["deploy", "release-notes", "review"]), templates };
  const builtin = (text: string) => text === "/deploy";
  expect(completeSkillCommand("/rel", catalog, () => false)).toEqual({
    text: "/release-notes ",
    matches: ["/release-notes"],
  });
  // Bare names a built-in or template also answers to complete to the qualified form.
  expect(completeSkillCommand("/dep", catalog, builtin)?.text).toBe("/skill:deploy ");
  expect(completeSkillCommand("/rev", catalog, () => false)?.text).toBe("/skill:review ");
  expect(completeSkillCommand("/re", catalog, () => false)).toEqual({
    text: "/re",
    matches: ["/release-notes", "/skill:review"],
  });
  expect(completeSkillCommand("/skill:re", catalog, () => false)?.matches).toEqual([
    "/skill:release-notes",
    "/skill:review",
  ]);
  for (const text of ["", "hello", "/rel now", "/x", "/kit:re", "/rel\n"])
    expect(completeSkillCommand(text, catalog, () => false)).toBeNull();
});

test("catalog lines name each skill's command or why it cannot be invoked", () => {
  expect(skillCatalogLines(null, null)).toEqual([
    "No skill catalog is available for this session yet.",
  ]);
  const lines = skillCatalogLines(
    {
      generation: "g",
      total: 150,
      nextOffset: 100,
      entries: [
        {
          name: "triage",
          source: "s",
          origin: "project-agents",
          path: ".agents/skills/triage/SKILL.md",
          scope: "",
          state: "excluded",
          reason: "not-user-invocable",
          userInvocable: false,
          automatic: true,
          command: null,
        },
      ],
    },
    "tri",
  );
  expect(lines[1]).toContain("triage — not user-invocable");
  expect(lines.at(-1)).toBe("More skills: /skills tri after 100");
});
