import { type HookPoint, parseHookEnvelope } from "./hook-points.ts";

export const hookFixtureDigest = "a".repeat(64);
export function hookFixtureEnvelope(
  point: HookPoint = "before-capability-invocation",
  payload: unknown = {
    capabilityId: "builtin:workspace/read_file@1",
    inputDigest: hookFixtureDigest,
    declaredEffect: "observation",
  },
) {
  return parseHookEnvelope({
    version: 1,
    point,
    pointVersion: 1,
    factId: "fact:1",
    subjectId: "subject:1",
    ownerGeneration: 5,
    configurationGeneration: 5,
    registrationGeneration: 7,
    sequence: 0,
    correlation: { sessionId: "session:1", turnId: "turn:1", attemptId: "attempt:1" },
    origin: "system",
    reason: "normal",
    remainingMs: 50,
    recursionDepth: 0,
    payload,
  });
}

export const externalHookFixture = {
  version: 1,
  point: "before-capability-invocation",
  pointVersion: 1,
  handler: {
    kind: "external-command-v1",
    executable: "bun",
    argv: [],
    entrypoint: "hooks/observe.ts",
    executionProfile: "local",
  },
  mode: "sync",
} as const;
