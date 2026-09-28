import { expect, test } from "bun:test";
import { routeSkills, SKILL_ROUTING } from "./skill-routing.ts";

const catalog = [
  { name: "release-notes", description: "Draft release notes from merged pull requests." },
  { name: "api-review", description: "Review public API changes for compatibility." },
  { name: "changelog", description: "Draft release notes and changelog entries." },
  { name: "incident", description: "Write an incident postmortem." },
];

test("a skill named in the task is selected without loading unrelated candidates", () => {
  expect(
    routeSkills({ task: "Use release-notes for v2.", candidates: catalog, active: [] }),
  ).toEqual([{ name: "release-notes", decision: "selected", reason: "named-in-task" }]);
});

test("one clearly best description match is selected; a tie stays a recommendation", () => {
  expect(
    routeSkills({
      task: "Review the public API compatibility changes",
      candidates: catalog,
      active: [],
    }),
  ).toEqual([{ name: "api-review", decision: "selected", reason: "unambiguous-task-match" }]);
  expect(routeSkills({ task: "Draft the release notes", candidates: catalog, active: [] })).toEqual(
    [
      { name: "changelog", decision: "recommended", reason: "ambiguous-task-match" },
      { name: "release-notes", decision: "recommended", reason: "ambiguous-task-match" },
    ],
  );
  expect(routeSkills({ task: "Fix the build", candidates: catalog, active: [] })).toEqual([]);
});

test("session-active skills stay while eligible, and selection is bounded", () => {
  expect(
    routeSkills({ task: "Fix the build", candidates: catalog, active: ["incident", "gone"] }),
  ).toEqual([{ name: "incident", decision: "selected", reason: "session-active" }]);
  const many = Array.from({ length: 8 }, (_, index) => ({
    name: `skill-${index}`,
    description: "Unrelated.",
  }));
  const routes = routeSkills({
    task: many.map((item) => item.name).join(" "),
    candidates: many,
    active: [],
  });
  expect(routes.filter((route) => route.decision === "selected")).toHaveLength(
    SKILL_ROUTING.selections,
  );
  expect(routes.filter((route) => route.reason === "selection-limit")).toHaveLength(
    many.length - SKILL_ROUTING.selections,
  );
});
