import { expect, test } from "bun:test";
import { processingNativeParametersSchema } from "../../domain/sessions/model-processing.ts";
import { processingQualificationSchema } from "../../providers/configuration/processing.ts";
import { routeDefinition, routeFacts } from "../../providers/routing/named-route.fixtures.ts";
import { resolveNamedRoute } from "../../providers/routing/named-route.ts";
import { processingProduct } from "../runtime/product-processing.fixture.ts";
import { bindModelProcessing, inspectModelProcessing } from "./model-processing.ts";
import { processingPromptCache } from "./provider-prompt-cache.ts";

test("inspection is pure, exact-destination scoped and distinguishes unknown prices from unset budgets", () => {
  const product = processingProduct();
  const selected = product.select("fast");
  const input = {
    adapter: product.adapter,
    route: selected.receipt,
    pricing: product.state.pricing,
    inputTokens: 100,
    outputTokens: 10,
  };
  const inspected = inspectModelProcessing(input);
  expect(inspected.eligible).toBe(true);
  expect(inspected.maximumCostMicros).toBe(3100);
  expect(selected.receipt.budgets.cost).toBeUndefined();
  product.state.qualification.destinationId = "another-destination";
  const different = inspectModelProcessing(input);
  expect(different.reason).toBe("processing-unknown");
  expect(different.maximumCostMicros).toBeNull();
  expect(product.requests).toHaveLength(0);
});

test("bindings freeze captured prices and cache identity changes only for a qualified partition", () => {
  const product = processingProduct();
  const selected = product.select("fast");
  const inspection = inspectModelProcessing({
    adapter: product.adapter,
    route: selected.receipt,
    pricing: product.state.pricing,
    inputTokens: 100,
    outputTokens: 10,
  });
  const bound = bindModelProcessing(inspection, selected.receipt, 5, {
    owner: "task",
    attempt: "attempt",
    operation: "request-1",
  });
  const policy = {
    schemaVersion: 1 as const,
    key: `sha-256:${"a".repeat(64)}`,
    scope: "session" as const,
    stablePrefixDigest: `sha-256:${"b".repeat(64)}`,
    stableMessageCount: 1,
    toolCatalogGeneration: 1,
    mode: "implicit-prefix" as const,
    minimumInputTokens: null,
  };
  expect(processingPromptCache(policy, bound.cachePartition)).toBe(policy);
  expect(processingPromptCache(policy, "fast")?.key).not.toBe(policy.key);
  expect(processingPromptCache(policy, "fast")?.stablePrefixDigest).toBe(policy.stablePrefixDigest);
  expect(Object.isFrozen(bound.preference)).toBe(true);
  expect(Object.isFrozen(bound.price.tierIds)).toBe(true);
});

test("qualification and native parameters reject arbitrary provider fields, headers and unbounded identifiers", () => {
  const product = processingProduct();
  const qualification = product.state.qualification;
  expect(processingQualificationSchema.safeParse(qualification).success).toBe(true);
  for (const input of [
    { ...qualification, endpoint: "unqualified" },
    { ...qualification, modelId: "x".repeat(257) },
    { ...qualification, evidenceUrl: "https://user:secret@example.com/path" },
  ])
    expect(processingQualificationSchema.safeParse(input).success).toBe(false);
  for (const input of [
    { serviceTier: "priority", speed: null, betaHeaders: "vendor-beta" },
    { serviceTier: "ignored-fast", speed: null },
    null,
  ])
    expect(processingNativeParametersSchema.safeParse(input).success).toBe(false);
});

test("session Fast preference cannot widen the captured named-route premium grant", () => {
  const product = processingProduct();
  const selected = product.select("fast");
  const resolved = resolveNamedRoute(routeDefinition(), routeFacts(), {
    configurationGeneration: 1,
    factsRevision: 1,
  });
  if (resolved.kind !== "resolved") throw new Error("fixture");
  const inspected = inspectModelProcessing({
    adapter: product.adapter,
    route: { ...selected.receipt, namedRoute: resolved.receipt },
    preference: { mode: "fast", fallback: "allow-standard" },
    pricing: product.state.pricing,
  });
  expect(inspected).toMatchObject({
    eligible: false,
    reason: "premium-processing-not-approved",
    standardFallbackAllowed: false,
  });
  expect(product.requests).toEqual([]);
});
