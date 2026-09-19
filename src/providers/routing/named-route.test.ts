import { expect, test } from "bun:test";
import {
  namedRouteDefinitionSchema,
  namedRouteRegistrySchema,
} from "../configuration/named-route.ts";
import { routeDefinition, routeFacts } from "./named-route.fixtures.ts";
import { qualifiedRouteAlternatives, resolveNamedRoute } from "./named-route.ts";

const request = { configurationGeneration: 3, factsRevision: 5 };
test("named destinations are bounded exact identities; duplicates, recursive routes and unknown policy refuse", () => {
  const route = routeDefinition();
  const alternatives = Array.from({ length: 16 }, (_, n) => ({
    ...route.primary,
    connectionId: `account-${n}`,
  }));
  expect(namedRouteDefinitionSchema.safeParse({ ...route, alternatives }).success).toBe(true);
  for (const invalid of [
    { ...route, alternatives: [...alternatives, alternatives[0]] },
    { ...route, alternatives: [route.primary] },
    { ...route, primary: { routeId: "cycle" } },
    { ...route, policy: { ...route.policy, random: true } },
  ])
    expect(namedRouteDefinitionSchema.safeParse(invalid).success).toBe(false);
  expect(namedRouteRegistrySchema.safeParse([route, route]).success).toBe(false);
});
test("ordered affinity, strict target and deadline-bounded waits retain separate uncertainty", () => {
  const definition = routeDefinition(),
    facts = routeFacts();
  const first = facts[0],
    second = facts[1];
  const result = resolveNamedRoute(definition, facts, { ...request, current: second.target });
  expect(result.receipt?.eligible[0]?.target.connectionId).toBe("two");
  expect(result.receipt?.eligible[0]?.uncertainty).toContain("price-unknown");
  const exhausted = { ...first, quota: "exhausted" as const, waitMs: 50 };
  const waitDefinition = { ...definition, policy: { ...definition.policy, maxWaitMs: 50 } };
  expect(
    resolveNamedRoute(waitDefinition, [exhausted, second], {
      ...request,
      current: first.target,
      remainingMs: 49,
    }).receipt?.eligible[0]?.target.connectionId,
  ).toBe("two");
  expect(
    resolveNamedRoute(waitDefinition, [exhausted, second], {
      ...request,
      current: first.target,
      remainingMs: 50,
    }).receipt?.eligible[0]?.waitMs,
  ).toBe(50);
  const strict = {
    ...definition,
    policy: { ...definition.policy, strategy: "strict-target" as const },
  };
  expect(
    resolveNamedRoute(strict, [{ ...first, lifecycle: "draining" }, second], request).kind,
  ).toBe("unresolved");
});
test("account, model, transport, capability and billing failures explain every excluded candidate", () => {
  const definition = routeDefinition(),
    facts = routeFacts();
  const first = facts[0];
  if (!first.capability) throw new Error("Missing fixture capability");
  for (const change of [
    { credential: "missing" as const },
    { credential: "revoked" as const },
    { lifecycle: "paused" as const },
    { lifecycle: "draining" as const },
    { allowed: false },
    { trusted: false },
    { transportId: "" },
    { capability: null },
    { capability: { ...first.capability, tools: "unsupported" as const } },
  ]) {
    const result = resolveNamedRoute(definition, [{ ...first, ...change }, facts[1]], {
      ...request,
      required: { tools: true },
    });
    expect(result.receipt?.eligible.map((entry) => entry.target.connectionId)).toEqual(["two"]);
    expect(result.receipt?.exclusions[0]?.reasons.length).toBeGreaterThan(0);
  }
  expect(
    resolveNamedRoute(
      { ...definition, policy: { ...definition.policy, billing: "included-only" } },
      facts,
      request,
    ).kind,
  ).toBe("unresolved");
  expect(
    resolveNamedRoute(
      { ...definition, policy: { ...definition.policy, maxCostMicros: 1 } },
      facts,
      request,
    ).kind,
  ).toBe("unresolved");
  expect(
    resolveNamedRoute(
      definition,
      facts.map((fact) => ({ ...fact, maximumCostMicros: 2 })),
      { ...request, remainingCostMicros: 1 },
    ).kind,
  ).toBe("unresolved");
});
test("shared quota, processing permission and capability requirements cannot be bypassed by another label", () => {
  const definition = routeDefinition(),
    facts = routeFacts();
  expect(
    resolveNamedRoute(
      definition,
      facts.map((fact, index) => ({
        ...fact,
        quotaPool: "shared",
        quota: index === 0 ? "exhausted" : "available",
      })),
      request,
    ).kind,
  ).toBe("unresolved");
  const premium = { ...definition, policy: { ...definition.policy, allowPremiumProcessing: true } };
  for (const fallback of ["stop", "allow-standard"] as const) {
    expect(
      resolveNamedRoute(
        premium,
        facts.map((fact) => ({ ...fact, fast: "unsupported" })),
        { ...request, processing: { mode: "fast", fallback } },
      ).kind,
    ).toBe("unresolved");
  }
  expect(
    resolveNamedRoute(definition, facts, { ...request, processing: { mode: "fast" } }).kind,
  ).toBe("unresolved");
  expect(resolveNamedRoute(premium, facts, { ...request, processing: { mode: "fast" } }).kind).toBe(
    "resolved",
  );
  for (const required of [
    { minContextTokens: 10001 },
    { minOutputTokens: 1001 },
    { modalities: ["image" as const] },
    { reasoningControls: ["unavailable-control"] },
  ])
    expect(resolveNamedRoute(definition, facts, { ...request, required }).kind).toBe("unresolved");
});
test("captured receipts are immutable; later definitions do not rewrite admitted work; alternatives are a bounded handoff", () => {
  const definition = routeDefinition(),
    facts = routeFacts();
  const result = resolveNamedRoute(definition, facts, request);
  if (result.kind !== "resolved") throw new Error("fixture");
  expect(Object.isFrozen(result.receipt.definition.primary)).toBe(true);
  definition.revision = 2;
  facts[0] = { ...facts[0], accountGeneration: "replacement" };
  expect(result.receipt.definitionRevision).toBe(1);
  expect(result.receipt.eligible[0]?.accountGeneration).toBe("account-one");
  expect(qualifiedRouteAlternatives(result.receipt, "transport", 1)).toHaveLength(1);
  for (const trigger of ["authorization", "cancelled", "uncertain-effect"])
    expect(qualifiedRouteAlternatives(result.receipt, trigger, 1)).toEqual([]);
  expect(qualifiedRouteAlternatives(result.receipt, "transport", 2)).toEqual([]);
  expect(resolveNamedRoute(undefined, facts, request)).toEqual({
    kind: "unresolved",
    code: "route-missing",
    receipt: null,
  });
});
