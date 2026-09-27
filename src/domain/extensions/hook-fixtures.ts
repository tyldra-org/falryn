import { createHash } from "node:crypto";
import { type HookPoint, parseHookEnvelope } from "./hook-points.ts";
import { type ContributionDeclaration, contributionDeclarationSchema } from "./manifest.ts";

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

export function httpHookDeclaration(
  url: string,
  options: {
    readonly credential?: string;
    readonly id?: string;
    readonly point?: "before-capability-invocation" | "after-capability-invocation";
    readonly mode?: "sync" | "async";
  } = {},
): ContributionDeclaration {
  return contributionDeclarationSchema.parse({
    kind: "hook",
    namespace: "fixture",
    id: options.id ?? "remote",
    description: "HTTP decision fixture",
    authority: {
      effects: ["external"],
      permissions: [],
      roots: [],
      destinations: [],
      secretReferences: options.credential === undefined ? [] : [options.credential],
      localData: [],
    },
    hook: {
      version: 1,
      point: options.point ?? "before-capability-invocation",
      pointVersion: 1,
      mode: options.mode ?? "sync",
      nonlocalOptIn: true,
      timeoutMs: 5_000,
      handler: {
        kind: "http-v1",
        url,
        ...(options.credential === undefined ? {} : { credentialReference: options.credential }),
      },
    },
  });
}

type WireRequest = {
  readonly invocationId: string;
  readonly envelope: Record<string, unknown> & { readonly payload: unknown };
};

/** The decision a hook service answers with: observe, or a veto bound to its subject. */
export function hookServiceDecision(request: WireRequest, veto: boolean): string {
  const envelope = request.envelope;
  const binding = {
    factId: envelope.factId,
    subjectId: envelope.subjectId,
    ownerGeneration: envelope.ownerGeneration,
    configurationGeneration: envelope.configurationGeneration,
    registrationGeneration: envelope.registrationGeneration,
    payloadDigest: createHash("sha256").update(JSON.stringify(envelope.payload)).digest("hex"),
  };
  return JSON.stringify({
    version: 1,
    invocationId: request.invocationId,
    decision: veto
      ? { kind: "veto", reason: "remote-veto", binding }
      : { kind: "observe", annotations: { remote: "ok" } },
  });
}
