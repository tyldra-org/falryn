/** Headless compaction uses the configured main route and the shared admitted producer. */
import { z } from "zod";
import {
  checkpointRequestSchema,
  checkpointReservationSchema,
} from "../../application/compression/checkpoint-request.ts";
import type { CheckpointOutcome } from "../../application/compression/product-checkpoint.ts";
import { createRuntimeProjectionRedactor } from "../../application/diagnostics/redaction.ts";
import { createUserCatalogModelDiscovery } from "../../application/providers/model-catalogs.ts";
import { historyDigest } from "../../application/sessions/session-history.ts";
import { HARD_CONTEXT_MAX_TOTAL_TOKENS } from "../../domain/context/context-budget.ts";
import { parseProviderConnectionState, providerModelIdentityKey } from "../../providers/index.ts";
import type { GlobalOptions } from "../options.ts";
import { modelPreferencesFrom } from "../runtime/model-configuration.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "../runtime/product-configuration.ts";
import { PROVIDER_CONNECTIONS_CONFIGURATION_KEY } from "../runtime/provider-configuration.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { runStoredCheckpoint } from "./compact-session.ts";
import { resultFor } from "./shared.ts";

export const compactArgumentsSchema = z.strictObject({
  sessionId: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-zA-Z0-9._:-]+$/u),
  request: checkpointRequestSchema,
  reservation: checkpointReservationSchema.optional(),
});
export type CompactArguments = z.infer<typeof compactArgumentsSchema>;
export async function runCompact(
  services: ServiceProvider,
  args: CompactArguments,
  globals: GlobalOptions,
  signal = new AbortController().signal,
) {
  const result = (payload: CheckpointOutcome) =>
    resultFor(
      "compact",
      payload,
      [],
      payload.kind === "refused"
        ? { kind: "failed", effect: payload.effect }
        : { kind: "completed" },
      { intent: args.request.action === "inspect" ? "none" : "mutate", observed: payload.effect },
    );
  const fail = (reason: string) => result({ kind: "refused", reason, effect: "none" });
  if (args.request.action === "inspect")
    return result(
      await runStoredCheckpoint(services, args.sessionId, args.request, () => null, signal),
    );
  if (!args.reservation) return fail("reservation-required");
  const graph = services();
  const loaded = await loadProductConfiguration(
    graph,
    productConfigurationLoadRequest(globals),
    signal,
  );
  if (loaded.outcome.kind !== "published" && loaded.outcome.kind !== "unchanged")
    return fail("configuration-unavailable");
  const route = modelPreferencesFrom(loaded.values, Number(loaded.generation))?.roles.default;
  const connections = parseProviderConnectionState(
    loaded.values[PROVIDER_CONNECTIONS_CONFIGURATION_KEY],
  );
  const profile = connections.ok
    ? connections.value.connections.find((entry) =>
        route
          ? entry.profile.profileId === route.providerProfileId &&
            entry.profile.providerId === route.providerId
          : entry.profile.profileId === connections.value.selectedProfileId,
      )?.profile
    : undefined;
  if (!profile) return fail("main-model-unavailable");
  const discovered = await createUserCatalogModelDiscovery({
    fileSystem: graph.fileSystem,
    async configurationRoot() {
      return graph.configurationRoot;
    },
  }).discover(profile, { signal, now: graph.clock.now() });
  const model =
    discovered.kind === "catalog"
      ? discovered.catalog.models.find(
          (model) =>
            (route === undefined || model.modelId === route.modelId) &&
            model.availability !== "unavailable",
        )
      : undefined;
  if (!model?.contextTokens || !model.outputTokens) return fail("model-budget-unknown");
  if (
    args.reservation.reservedOutputTokens >
    Math.min(model.outputTokens, route?.budgets.outputTokens ?? model.outputTokens)
  )
    return fail("output-budget-exceeded");
  if (
    createRuntimeProjectionRedactor().redactText(
      args.reservation.protectedRequest,
      4 * 1024 * 1024,
    ) !== args.reservation.protectedRequest
  )
    return fail("protected-request-redacted");
  const valuesDigest = historyDigest(JSON.stringify(loaded.values));
  const authority = {
    ...args.reservation,
    model: providerModelIdentityKey(
      route ?? {
        providerProfileId: profile.profileId,
        providerId: profile.providerId,
        modelId: model.modelId,
      },
    ),
    configurationGeneration: Number(loaded.generation),
    policyGeneration: Number(loaded.generation),
    instructionDigest: historyDigest(args.reservation.protectedRequest),
    contextGeneration: historyDigest(`${args.reservation.contextGeneration}:${valuesDigest}`),
    contextWindowTokens: Math.min(model.contextTokens, HARD_CONTEXT_MAX_TOTAL_TOKENS),
    systemAndSkillsTokens: Math.ceil(Buffer.byteLength(args.reservation.protectedRequest) / 4),
    reservedOutputTokens: args.reservation.reservedOutputTokens,
  };
  return result(
    await runStoredCheckpoint(
      services,
      args.sessionId,
      args.request,
      () =>
        historyDigest(JSON.stringify(graph.loader.current()?.values)) === valuesDigest
          ? authority
          : null,
      signal,
    ),
  );
}
