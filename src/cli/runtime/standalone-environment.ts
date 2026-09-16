import { randomUUID } from "node:crypto";
import { createEnvironmentControl } from "../../application/configuration/environment-control.ts";
import { processProductResources } from "../../application/orchestration/product-resources.ts";
import { createTurnEventJournal } from "../../application/runtime/turn-event-journal.ts";
import { sessionId, streamId, traceId, workspaceId } from "../../domain/foundation/index.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import type { OwnedProcessRegistry } from "../../integrations/process/host-owned-process-registry.ts";
import type { GlobalOptions } from "../options.ts";
import { createEnvironmentProcessContext } from "./environment-process-context.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import { composeProductProfileTransitions } from "./product-profile-transitions.ts";
import { productScopedEnvironment } from "./scoped-environment.ts";
import type { Services } from "./services.ts";

/** A standalone invocation owns only its own runtime; it cannot target another process. */
export async function standaloneEnvironment(
  graph: Services,
  globals: GlobalOptions,
  signal?: AbortSignal,
  ownedProcesses?: OwnedProcessRegistry,
) {
  const loaded = await loadProductConfiguration(
    graph,
    productConfigurationLoadRequest(globals),
    signal,
  );
  if (loaded.outcome.kind !== "published" && loaded.outcome.kind !== "unchanged")
    throw new Error("environment-configuration-unavailable");
  const id = randomUUID();
  const scope = { sessionId: id, workspaceId: "standalone" };
  const correlation = {
    sessionId: sessionId.from(id),
    workspaceId: workspaceId.from(scope.workspaceId),
    traceId: traceId.from(id),
    configurationGeneration: loaded.generation,
  };
  const resources = processProductResources.openTask(String(loaded.generation));
  const environment = productScopedEnvironment(graph, id, ownedProcesses);
  const context = createEnvironmentProcessContext();
  context.install(environment.capture);
  let closed = false;
  const service = composeProductProfileTransitions({
    environment,
    graph,
    scope,
    request: productConfigurationLoadRequest(globals),
    resources,
    journal: createTurnEventJournal({
      eventStore: createInMemoryEventStore(),
      clock: graph.clock,
      streamId: streamId.from(id),
      correlation,
    }),
    correlation,
    preserveSelection: true,
    owners: [environment.owner],
    policyRevision: () => "explicit-environment-v1",
    authorize: (actor) => !closed && actor === "user",
  });
  const control = createEnvironmentControl({
    ...service,
    scope,
    inspect: environment.inspect,
    restartRequired: context.restartRequired,
  });
  return {
    control,
    context,
    resources,
    close() {
      closed = true;
      environment.close();
      service.transitions.invalidate();
      resources.close();
    },
  };
}
