/**
 * Process-tree stop policy.
 */

import { describe, expect, test } from "bun:test";

import { nextProcessTreeKill, processTreeCleanupAfter } from "./process-tree.ts";

describe("process-tree kill stages", () => {
  test("escalates none to terminate, then kill, then unconfirmed", () => {
    expect(nextProcessTreeKill("none")).toBe("terminate");
    expect(nextProcessTreeKill("terminate")).toBe("kill");
    expect(nextProcessTreeKill("kill")).toBe("unconfirmed");
    expect(nextProcessTreeKill("unconfirmed")).toBe("unconfirmed");
  });

  test("a reaped terminate is confirmed", () => {
    expect(processTreeCleanupAfter("terminate", true)).toEqual({
      stage: "terminate",
      certainty: "reaped",
    });
  });

  test("an unreaped kill is unconfirmed rather than a clean stop", () => {
    expect(processTreeCleanupAfter("kill", false)).toEqual({
      stage: "unconfirmed",
      certainty: "uncertain",
    });
  });

  test("an unreaped terminate stays terminate and uncertain", () => {
    expect(processTreeCleanupAfter("terminate", false)).toEqual({
      stage: "terminate",
      certainty: "uncertain",
    });
  });
});
