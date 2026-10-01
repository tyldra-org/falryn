import { describe, expect, test } from "bun:test";
import {
  callableName,
  type DisclosedOperationProfile,
  lowerProfileProposals,
  type OperationProfileDefinition,
  planProfileProjection,
} from "./operation-profiles.ts";

const INSPECT: OperationProfileDefinition = {
  id: "git.inspect",
  version: 1,
  name: "git_inspect",
  description: "Inspect Git.",
  members: [
    { operation: "status", toolName: "git_status" },
    { operation: "diff", toolName: "git_diff" },
    { operation: "log", toolName: "git_log" },
  ],
};
const CHANGE: OperationProfileDefinition = {
  id: "git.change",
  version: 1,
  name: "git_change",
  description: "Change Git.",
  members: [
    { operation: "stage", toolName: "git_stage" },
    { operation: "commit", toolName: "git_commit" },
  ],
};

const DISCLOSED_INSPECT: DisclosedOperationProfile = {
  name: "git_inspect",
  profileId: "git.inspect",
  version: 1,
  operations: [
    { operation: "status", toolName: "git_status" },
    { operation: "diff", toolName: "git_diff" },
  ],
};

describe("planProfileProjection", () => {
  test("replaces two or more disclosed members with one profile at the first member's place", () => {
    const plan = planProfileProjection(
      [INSPECT, CHANGE],
      ["read_file", "git_diff", "run_process", "git_status", "git_commit"],
    );
    expect(plan.map((item) => (item.kind === "native" ? item.name : item.definition.name))).toEqual(
      ["read_file", "git_inspect", "run_process", "git_commit"],
    );
    const inspect = plan[1];
    if (inspect?.kind !== "profile") throw new Error("expected a profile");
    // Operations follow the profile's declared order; the rest are reported omitted.
    expect(inspect.operations.map((operation) => operation.operation)).toEqual(["status", "diff"]);
    expect(inspect.omitted.map((operation) => operation.operation)).toEqual(["log"]);
  });

  test("keeps a lone member as its native tool and is deterministic", () => {
    const names = ["git_commit", "git_status"];
    expect(planProfileProjection([INSPECT, CHANGE], names)).toEqual([
      { kind: "native", name: "git_commit" },
      { kind: "native", name: "git_status" },
    ]);
    expect(planProfileProjection([INSPECT], ["git_log", "git_status"])).toEqual(
      planProfileProjection([INSPECT], ["git_log", "git_status"]),
    );
  });
});

describe("lowerProfileProposals", () => {
  const lower = (args: unknown) =>
    lowerProfileProposals(
      [DISCLOSED_INSPECT],
      [{ toolCallId: "call-1", name: "git_inspect", arguments: args }],
      [INSPECT],
    );

  test("lowers to the exact native call and keeps the call id", () => {
    expect(lower({ operation: "diff", diff: { scope: "staged" } })).toEqual({
      ok: true,
      value: [{ toolCallId: "call-1", name: "git_diff", arguments: { scope: "staged" } }],
    });
    expect(lower({ operation: "status" })).toEqual({
      ok: true,
      value: [{ toolCallId: "call-1", name: "git_status", arguments: {} }],
    });
  });

  test("lets `operation` decide and ignores other operations' properties", () => {
    // Strict dialects send them as null; a lenient model may echo them back.
    expect(lower({ operation: "status", status: { maxEntries: 3 }, diff: null })).toMatchObject({
      ok: true,
      value: [{ name: "git_status", arguments: { maxEntries: 3 } }],
    });
    expect(lower({ operation: "status", diff: { scope: "staged" } })).toMatchObject({
      ok: true,
      value: [{ name: "git_status", arguments: {} }],
    });
  });

  test("names a member the way the model can call it", () => {
    expect(callableName([DISCLOSED_INSPECT], "git_diff")).toBe("git_inspect(diff)");
    expect(callableName([DISCLOSED_INSPECT], "git_log")).toBe("git_log");
  });

  test("passes other tools through untouched", () => {
    const proposals = [{ toolCallId: "call-2", name: "read_file", arguments: { path: "a" } }];
    expect(lowerProfileProposals([DISCLOSED_INSPECT], proposals)).toEqual({
      ok: true,
      value: proposals,
    });
  });

  test("refuses every malformed profile call with a typed reason", () => {
    const reasonOf = (args: unknown) => {
      const result = lower(args);
      return result.ok ? null : result.error.reason;
    };
    expect(reasonOf("status")).toBe("arguments-not-object");
    expect(reasonOf({ status: {} })).toBe("operation-missing");
    expect(reasonOf({ operation: "rebase" })).toBe("operation-unknown");
    // Declared by the profile but not disclosed to this attempt.
    expect(reasonOf({ operation: "log" })).toBe("operation-not-disclosed");
    expect(reasonOf({ operation: "status", status: "all" })).toBe("operation-arguments-invalid");
    const refused = lower({ operation: "rebase" });
    expect(refused).toEqual({
      ok: false,
      error: {
        code: "profile-operation-invalid",
        toolCallId: "call-1",
        name: "git_inspect",
        reason: "operation-unknown",
      },
    });
  });

  test("one invalid profile call refuses the whole batch", () => {
    const result = lowerProfileProposals(
      [DISCLOSED_INSPECT],
      [
        { toolCallId: "call-1", name: "git_inspect", arguments: { operation: "status" } },
        { toolCallId: "call-2", name: "git_inspect", arguments: { operation: "nope" } },
      ],
    );
    expect(result).toMatchObject({ ok: false, error: { toolCallId: "call-2" } });
  });
});
