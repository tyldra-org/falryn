/** Secret-free declared route facts. Never constructs adapters or resolves credentials. */
import { createHash } from "node:crypto";
import type { ConfigurationValues } from "../../domain/configuration/index.ts";
import { modelId } from "../../domain/foundation/identity.ts";
import { openAiProcessing } from "../../integrations/providers/openai-processing.ts";
import { providerDestinationId } from "../../integrations/providers/provider-destination.ts";
import { resolveProviderTransportCompatibilityPlan } from "../../integrations/providers/provider-transport-compatibility.ts";
import { knownModelCapability } from "../../providers/catalog/known-model-capability.ts";
import { capabilityFromDeclaration } from "../../providers/catalog/model-capability.ts";
import { parseProviderConnectionState } from "../../providers/configuration/connection-schema.ts";
import type { NamedRouteDefinition } from "../../providers/configuration/named-route.ts";
import { REASONING_EFFORTS } from "../../providers/configuration/policy.ts";
import type { RouteCandidateFacts } from "../../providers/routing/named-route.ts";
import { reasoningControlFor } from "../../providers/routing/routing.ts";
/** Metadata only: a declared credential is not evidence that a credential resolves at admission. */
export function declaredRouteFacts(
  values: ConfigurationValues,
  routes: readonly NamedRouteDefinition[],
): readonly RouteCandidateFacts[] {
  const parsed = parseProviderConnectionState(values["providers.connections"]);
  if (!parsed.ok) return [];
  const facts: RouteCandidateFacts[] = [];
  for (const route of routes)
    for (const target of [route.primary, ...route.alternatives]) {
      const connection = parsed.value.connections.find(
        (entry) =>
          entry.profile.profileId === target.connectionId &&
          String(entry.profile.providerId) === target.providerId,
      );
      if (!connection || target.variant !== undefined) continue; // No canonical/variant mapping may be guessed.
      const profile = connection.profile;
      const declaration =
        profile.modelCapabilities.find((entry) => String(entry.modelId) === target.modelId) ??
        knownModelCapability(
          profile.adapterKind,
          target.modelId,
          profile.endpoint,
          String(profile.providerId),
        );
      const capability =
        profile.enabledModels.some((id) => String(id) === target.modelId) && declaration
          ? capabilityFromDeclaration(declaration)
          : null;
      const transport = resolveProviderTransportCompatibilityPlan(
        profile.adapterKind,
        profile.transportCompatibility,
        {
          modelId: modelId.from(target.modelId),
          modelOverrides: profile.modelTransportCompatibility ?? [],
        },
      );
      const digest = (value: unknown) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const processing =
        profile.adapterKind === "openai" && transport.ok && profile.endpoint !== null
          ? openAiProcessing({
              baseUrl: profile.endpoint,
              profileId: profile.profileId,
              providerId: String(profile.providerId),
              processingAccountGeneration: digest(connection),
            })
              .qualify(transport.value, modelId.from(target.modelId))
              .declaration.processingQualifications?.find(
                (entry) => entry.modelId === target.modelId,
              )
          : undefined;
      facts.push({
        target,
        revision: parsed.value.revision,
        accountGeneration: digest(connection),
        catalogGeneration: parsed.value.revision,
        destinationId: providerDestinationId(profile.adapterKind, profile.endpoint),
        transportId: transport.ok ? transport.value.compatibilityId : "",
        credential: profile.credential === null ? "missing" : "declared",
        lifecycle: "active",
        trusted: true,
        allowed: true,
        disclosures: [],
        capability,
        reasoning: capability
          ? REASONING_EFFORTS.filter(
              (effort) =>
                effort === "provider-default" ||
                reasoningControlFor(capability, effort, profile.adapterKind) !== null,
            )
          : [],
        quota: "unknown",
        includedEnforced: false,
        maximumCostMicros: capability?.pricing?.kind === "free" ? 0 : null,
        fast: processing?.modes.fast.support ?? "unknown",
        standard: processing?.modes.standard.support ?? "unknown",
      });
    }
  return facts;
}
