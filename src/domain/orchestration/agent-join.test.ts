import { expect, test } from "bun:test";
import {
  type AgentLink,
  evaluateJoin,
  type JoinEvidence,
  type JoinInput,
  joinInputSchema,
} from "./agent-join.ts";

const handle = (id: string) => ({
  taskId: id,
  generation: 1,
  task: { version: 1 as const, taskId: `task-${id}`, generation: "generation" },
});
const owner = {
  sessionId: "session",
  turnId: "turn",
  workspaceId: "workspace",
  taskId: "parent",
  generation: 1,
};
const link = (id: string, required = false): AgentLink => ({
  handle: handle(id),
  owner,
  required,
  detached: false,
  rootTaskId: "root",
  rootSessionId: "session",
  definitionDigest: `sha-256:${"a".repeat(64)}`,
  resultSchema: {},
});
const evidence = (
  id: string,
  state: JoinEvidence["state"],
  sequence: number | null,
): JoinEvidence => ({
  handle: handle(id),
  state,
  sequence,
  effect: "none",
  resultDigest: state === "completed" ? `sha-256:${"b".repeat(64)}` : null,
  artifactId: state === "completed" ? `artifact-${id}` : null,
});
function input(mode: JoinInput["policy"]["mode"], quorum: number | null = null): JoinInput {
  return {
    id: "join",
    generation: 1,
    children: [handle("a"), handle("b"), handle("c")],
    policy: { mode, quorum, partialOnFailure: false, cancelRemaining: false },
  };
}

test("first-success uses durable successful order and required children remain barriers", () => {
  const policy = input("first-success");
  const facts = [
    evidence("a", "failed", 1),
    evidence("b", "completed", 3),
    evidence("c", "completed", 2),
  ];
  expect(evaluateJoin(policy, [link("a"), link("b"), link("c")], facts)).toEqual({
    state: "satisfied",
    selected: ["c"],
  });
  expect(evaluateJoin(policy, [link("a", true), link("b"), link("c")], facts).state).toBe("failed");
  expect(
    evaluateJoin(
      policy,
      [link("a", true), link("b"), link("c")],
      [evidence("a", "running", null), ...facts.slice(1)],
    ).state,
  ).toBe("waiting");
});

test("all and quorum keep missing, stale, invalid and uncertain evidence explicit", () => {
  for (const state of [
    "missing",
    "stale",
    "invalid",
    "uncertain",
    "cancelled",
    "timed-out",
  ] as const) {
    const facts = [
      evidence("a", state, 1),
      evidence("b", "completed", 2),
      evidence("c", "completed", 3),
    ];
    const links = [link("a"), link("b"), link("c")];
    expect(evaluateJoin(input("all"), links, facts)).toEqual({ state: "failed", selected: [] });
    expect(evaluateJoin(input("quorum", 2), links, facts).state).toBe("satisfied");
    expect(
      evaluateJoin(
        { ...input("all"), policy: { ...input("all").policy, partialOnFailure: true } },
        links,
        facts,
      ),
    ).toEqual({ state: "failed", selected: ["b", "c"] });
  }
});

test("join contracts reject duplicate children, invalid thresholds and unbounded selection", () => {
  expect(joinInputSchema.safeParse(input("quorum", 0)).success).toBe(false);
  expect(joinInputSchema.safeParse(input("quorum", 4)).success).toBe(false);
  expect(joinInputSchema.safeParse(input("all", 1)).success).toBe(false);
  expect(
    joinInputSchema.safeParse({ ...input("all"), children: [handle("a"), handle("a")] }).success,
  ).toBe(false);
  expect(
    joinInputSchema.safeParse({
      ...input("all"),
      children: Array.from({ length: 17 }, (_, i) => handle(String(i))),
    }).success,
  ).toBe(false);
});
