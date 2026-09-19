import { modelId } from "../../domain/foundation/identity.ts";
import { unknownModelCapability } from "../catalog/model-capability.ts";
import { namedRouteDefinitionSchema } from "../configuration/named-route.ts";
import type { RouteCandidateFacts } from "./named-route.ts";
export function routeDefinition() {
  return namedRouteDefinitionSchema.parse({
    id: "daily",
    revision: 1,
    primary: { connectionId: "one", providerId: "openai", modelId: "exact" },
    alternatives: [{ connectionId: "two", providerId: "openai", modelId: "exact" }],
    policy: { triggers: ["transport"], maxAttempts: 2 },
  });
}
export function routeFacts(): [RouteCandidateFacts, RouteCandidateFacts] {
  const definition = routeDefinition();
  const fact = (target: typeof definition.primary): RouteCandidateFacts => ({
    target,
    revision: 1,
    accountGeneration: `account-${target.connectionId}`,
    catalogGeneration: 1,
    destinationId: "destination",
    transportId: "transport",
    credential: "declared",
    lifecycle: "active",
    trusted: true,
    allowed: true,
    disclosures: [],
    capability: {
      ...unknownModelCapability(modelId.from("exact")),
      tools: "supported",
      streaming: "supported",
      reasoning: "supported",
      inputModalities: ["text"],
      outputModalities: ["text"],
      contextTokens: 10000,
      outputTokens: 1000,
    },
    reasoning: ["provider-default", "balanced"],
    quota: "unknown",
    includedEnforced: false,
    maximumCostMicros: null,
    fast: "supported",
    standard: "supported",
  });
  return [fact(definition.primary), fact({ ...definition.primary, connectionId: "two" })];
}
