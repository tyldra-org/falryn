import { expect, test } from "bun:test";
import { REFLECTION_LIMITS } from "./reflection.ts";
import { reflectionTurnEvents } from "./reflection-extraction.fixtures.ts";
import { extractTurnEnd } from "./reflection-extraction.ts";

const extract = (events: ReturnType<typeof reflectionTurnEvents>) =>
  extractTurnEnd(events, { first: 1, last: events.length });
const proposals = (result: ReturnType<typeof extract>) =>
  result.segments.flatMap((segment) => segment.candidates.map((c) => [c.kind, c.content]));

test("direct user statements become typed, source-backed deterministic candidates", () => {
  const events = reflectionTurnEvents([
    {
      id: "turn-1",
      messages: [
        "Prefer main as the default branch. Please never force-push shared branches.",
        "No, the service port is 8080 not 3000.",
        "We decided to use Postgres for the ledger.",
        "From now on run the linter before commits.",
        "TODO migrate the billing tests later.",
        "Note that the staging database is read-only.",
        "Can you fix the failing build?",
      ],
    },
  ]);
  const result = extract(events);
  expect(proposals(result)).toEqual([
    ["user-preference", "Prefer main as the default branch."],
    ["user-preference", "Please never force-push shared branches."],
    ["correction", "No, the service port is 8080 not 3000."],
    ["decision", "We decided to use Postgres for the ledger."],
    ["workflow-convention", "From now on run the linter before commits."],
    ["recurring-task-context", "TODO migrate the billing tests later."],
    ["project-fact", "Note that the staging database is read-only."],
  ]);
  const [segment] = result.segments;
  expect(result.segments).toHaveLength(1);
  expect(segment?.range).toEqual({ first: 1, last: events.length });
  expect(segment?.disposition).toBe("processed");
  for (const candidate of segment?.candidates ?? []) {
    expect(candidate).toMatchObject({
      method: "deterministic",
      proposedScope: "workspace",
      sensitivity: "user-content",
      artifacts: [],
    });
    expect(candidate.sources).toHaveLength(1);
    expect(events.some((event) => String(event.eventId) === candidate.sources[0])).toBe(true);
  }
});

test("failed, cancelled and uncommitted turns contribute nothing", () => {
  const result = extract(
    reflectionTurnEvents([
      { id: "failed", messages: ["Always use tabs."], outcome: { kind: "failed", effect: "none" } },
      {
        id: "cancelled",
        messages: ["Always use spaces."],
        outcome: { kind: "cancelled", effect: "none" },
      },
      { id: "open", messages: ["We decided to ship on Friday."], unfinished: true },
    ]),
  );
  expect(proposals(result)).toEqual([]);
  expect(result.segments.map((segment) => segment.disposition)).toEqual(["empty"]);
});

test("fenced code, repeats and unmatched prose are not proposed; repeats do not add trust", () => {
  const result = extract(
    reflectionTurnEvents([
      {
        id: "turn-1",
        messages: [
          "Here is config:\n```\n// always enable debug logging here\n```\nThanks.",
          "Always write tests first.",
          "always write tests first.",
        ],
      },
    ]),
  );
  expect(proposals(result)).toEqual([["user-preference", "Always write tests first."]]);
});

test("unreadable messages split out as unavailable ranges and never count as processed", () => {
  const events = reflectionTurnEvents([
    {
      id: "turn-1",
      messages: ["Always squash merge.", { retained: true }, "We agreed to use pnpm."],
    },
  ]);
  const result = extract(events);
  expect(result.unavailableMessages).toBe(1);
  expect(result.segments.map((s) => [s.range, s.disposition, s.candidates.length])).toEqual([
    [{ first: 1, last: 3 }, "processed", 1],
    [{ first: 4, last: 4 }, "unavailable", 0],
    [{ first: 5, last: events.length }, "processed", 1],
  ]);
  // Segments cover the range exactly, in order, without overlap.
  const covered = result.segments.flatMap((s) =>
    Array.from({ length: s.range.last - s.range.first + 1 }, (_, i) => s.range.first + i),
  );
  expect(covered).toEqual(Array.from({ length: events.length }, (_, i) => i + 1));
});

test("repeated capability failures become one operational aggregate; one failure does not", () => {
  const result = extract(
    reflectionTurnEvents([
      {
        id: "turn-1",
        messages: ["Run the suite."],
        failures: ["builtin:shell/run@1", "builtin:shell/run@1", "builtin:git/push@1"],
      },
    ]),
  );
  expect(proposals(result)).toEqual([
    ["reusable-technical-knowledge", "builtin:shell/run@1 failed 2 times in one committed range."],
  ]);
  expect(result.segments[0]?.candidates[0]?.sources).toHaveLength(2);
});

test("candidates are bounded per request and the overflow is counted, not dropped silently", () => {
  const messages = Array.from(
    { length: 40 },
    (_, index) => "Always remember rule number " + index + ".",
  );
  const result = extract(reflectionTurnEvents([{ id: "turn-1", messages }]));
  expect(proposals(result)).toHaveLength(REFLECTION_LIMITS.candidates);
  expect(result.omittedCandidates).toBe(40 - REFLECTION_LIMITS.candidates);
});
