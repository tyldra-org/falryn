import { describe, expect, test } from "bun:test";
import { createSandboxExpansionGrant, type SandboxInvocation } from "./sandbox.ts";

const invocation: SandboxInvocation = {
  invocationId: "invocation-1",
  capabilityId: "builtin:run@1",
  source: "builtin",
  catalogGeneration: 1,
  policyGeneration: 2,
  inputFingerprint: "exact-input",
  effect: "mutation",
  confirmationId: "confirmed-once",
  resourceTaskId: "task-1",
  expiresAt: 500,
};
function grant() {
  return createSandboxExpansionGrant({
    invocation,
    expansion: { readRoots: ["/extra"], writeRoots: [] },
    expiresAt: 200,
  });
}
describe("sandbox expansion authority", () => {
  test("consumes exact confirmed intent once", () => {
    const approved = grant();
    expect(approved.consume(invocation, 100)).toEqual({ readRoots: ["/extra"], writeRoots: [] });
    expect(approved.consume(invocation, 100)).toBeNull();
  });
  test("rejects expired, missing and changed authority without permitting replay", () => {
    expect(grant().consume(invocation, 200)).toBeNull();
    for (const changed of [
      { invocationId: "other" },
      { capabilityId: "other" },
      { catalogGeneration: 2 },
      { policyGeneration: 3 },
      { inputFingerprint: "other" },
      { effect: "external" },
      { confirmationId: null },
      { resourceTaskId: "other" },
    ]) {
      const approved = grant();
      expect(approved.consume({ ...invocation, ...changed }, 100)).toBeNull();
      expect(approved.consume(invocation, 100)).toBeNull();
    }
  });
  test("copies destinations at grant time", () => {
    const roots = ["/approved"];
    const approved = createSandboxExpansionGrant({
      invocation,
      expansion: { readRoots: roots, writeRoots: [] },
      expiresAt: 200,
    });
    roots.push("/unapproved");
    expect(approved.consume(invocation, 100)?.readRoots).toEqual(["/approved"]);
  });
});
