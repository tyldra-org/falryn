import { expect, test } from "bun:test";
import { loadedRoute, receiptEvent, skillDecision, usageDigest } from "./skill-usage.fixtures.ts";
import { createSkillUsageFold } from "./skill-usage.ts";

const winner = skillDecision("release-notes", "project-agents", "selected");
const shadowed = skillDecision("release-notes", "user-agents", "shadowed");

test("same-named sources keep separate counts; a shadowed source never inherits the load", () => {
  const fold = createSkillUsageFold({});
  fold.add(
    receiptEvent({ sequence: 3, sources: [winner, shadowed], routes: [loadedRoute(winner)] }),
  );
  const { rows, admissions } = fold.totals();
  expect(admissions).toBe(1);
  const byOrigin = Object.fromEntries(rows.map((row) => [row.origin, row]));
  expect(byOrigin["project-agents"]?.counts).toMatchObject({
    discovered: 1,
    selected: 1,
    loaded: 1,
    shadowed: 0,
  });
  expect(byOrigin["project-agents"]?.body).toEqual({
    count: 1,
    bytes: 400,
    tokens: 100,
    unestimated: 0,
  });
  expect(byOrigin["project-agents"]?.listing).toEqual({
    count: 1,
    bytes: 30,
    tokens: 8,
    unestimated: 0,
  });
  expect(byOrigin["user-agents"]?.counts).toMatchObject({ discovered: 1, shadowed: 1, loaded: 0 });
  expect(byOrigin["user-agents"]?.body.count).toBe(0);
  expect(byOrigin["project-agents"]?.path).toBe("release-notes/SKILL.md");
});

test("a recommended or refused route belongs to the resolution winner, or stays unattributed", () => {
  const fold = createSkillUsageFold({});
  fold.add(
    receiptEvent({
      sequence: 1,
      sources: [winner, shadowed],
      routes: [
        {
          name: "release-notes",
          decision: "recommended",
          reason: "ambiguous-task-match",
          source: null,
          digest: null,
          bytes: null,
          listing: { bytes: 60, tokens: 15 },
        },
        {
          name: "forked",
          decision: "unavailable",
          reason: "unsupported-control",
          source: null,
          digest: null,
          bytes: null,
          listing: { bytes: 26, tokens: 7 },
        },
      ],
    }),
  );
  const rows = fold.totals().rows;
  const recommended = rows.find((row) => row.origin === "project-agents");
  expect(recommended?.counts.recommended).toBe(1);
  expect(recommended?.reasons).toEqual({ "recommended:ambiguous-task-match": 1 });
  expect(rows.find((row) => row.origin === "user-agents")?.counts.recommended).toBe(0);
  const refused = rows.find((row) => row.name === "forked");
  expect(refused).toMatchObject({ source: null, origin: null, counts: { refused: 1 } });
});

test("reuse is counted apart, each producing event counts once, and scopes stay separate", () => {
  const fold = createSkillUsageFold({});
  const first = receiptEvent({ sequence: 1, sources: [winner], routes: [loadedRoute(winner)] });
  expect(fold.add(first)).toBe("counted");
  expect(fold.add(first)).toBe("duplicate");
  fold.add(
    receiptEvent({
      sequence: 2,
      reused: true,
      sources: [winner],
      routes: [loadedRoute(winner, "session-active")],
    }),
  );
  fold.add(receiptEvent({ sequence: 3, kind: "child", sources: [winner] }));
  const totals = fold.totals();
  expect(totals).toMatchObject({ admissions: 3, reusedAdmissions: 1, duplicates: 1 });
  const [row] = totals.rows;
  expect(row).toMatchObject({
    reused: 1,
    counts: { loaded: 2, discovered: 3 },
    scopes: { main: 2, child: 1, workflow: 0 },
    reasons: { "loaded:named-in-task": 1, "loaded:session-active": 1 },
  });
  expect(row?.body).toEqual({ count: 2, bytes: 800, tokens: 200, unestimated: 0 });
  expect(totals.routingSection).toEqual({ count: 2, bytes: 240, tokens: 60, unestimated: 0 });
});

test("a legacy receipt without estimates reports unknown tokens, never zero", () => {
  const fold = createSkillUsageFold({});
  fold.add(
    receiptEvent({
      sequence: 1,
      estimates: false,
      sources: [winner],
      routes: [loadedRoute(winner, "named-in-task", false)],
    }),
  );
  const totals = fold.totals();
  expect(totals.rows[0]?.body).toEqual({ count: 1, bytes: 400, tokens: 0, unestimated: 1 });
  expect(totals.rows[0]?.listing).toEqual({ count: 1, bytes: 0, tokens: 0, unestimated: 1 });
  expect(totals.routingSection).toEqual({ count: 1, bytes: 0, tokens: 0, unestimated: 1 });
});

test("an edit starts a new generation row; explicit aggregation keeps the breakdown", () => {
  const edited = skillDecision("release-notes", "project-agents", "selected", "edited");
  const events = [
    receiptEvent({ sequence: 1, sources: [winner], routes: [loadedRoute(winner)] }),
    receiptEvent({
      sequence: 2,
      generation: usageDigest("generation-2"),
      sources: [edited],
      routes: [loadedRoute(edited, "session-active")],
    }),
  ];
  const split = createSkillUsageFold({});
  for (const event of events) split.add(event);
  expect(split.totals().rows.map((row) => [row.digest, row.generation, row.counts.loaded])).toEqual(
    [
      [winner.digest, usageDigest("generation-1"), 1],
      [edited.digest, usageDigest("generation-2"), 1],
    ],
  );
  const merged = createSkillUsageFold({ aggregate: "source" });
  for (const event of events) merged.add(event);
  const [row] = merged.totals().rows;
  expect(row).toMatchObject({ generation: null, digest: edited.digest, counts: { loaded: 2 } });
  expect(row?.versions).toEqual([
    { digest: winner.digest, generation: usageDigest("generation-1"), admissions: 1 },
    { digest: edited.digest, generation: usageDigest("generation-2"), admissions: 1 },
  ]);
});

test("a skill filter and omitted sources are honoured without inventing counts", () => {
  const fold = createSkillUsageFold({ skill: "incident" });
  fold.add(
    receiptEvent({
      sequence: 1,
      omitted: 3,
      sources: [winner, skillDecision("incident", "project-agents", "selected")],
    }),
  );
  const totals = fold.totals();
  expect(totals.rows.map((row) => row.name)).toEqual(["incident"]);
  expect(totals.sourcesOmitted).toBe(1);
});
