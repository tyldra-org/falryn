/** CLI controls compose the same native runtime used by the interactive product. */
import type { ScheduleCommand } from "../../application/orchestration/schedule-actions.ts";
import type { ScheduleResult } from "../../domain/orchestration/schedule-state.ts";
import type { GlobalOptions } from "../options.ts";
import { agentRegistryFrom } from "../runtime/agent-configuration.ts";
import { startConfigurationReloadWatcher } from "../runtime/configuration-reload.ts";
import { modelPreferencesFrom } from "../runtime/model-configuration.ts";
import { openProductArtifactSession } from "../runtime/product-artifact-session.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "../runtime/product-configuration.ts";
import { composeProductProviderConnections } from "../runtime/product-provider-connections.ts";
import { composeProductShellAttachments } from "../runtime/product-shell-attachments.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { resultFor } from "./shared.ts";
export type ScheduleArguments = ScheduleCommand | { operation: "host" };
export type SchedulePayload = ScheduleResult<Readonly<Record<string, unknown>>>;
export async function runSchedule(
  services: ServiceProvider,
  command: ScheduleArguments,
  globals: GlobalOptions,
  signal: AbortSignal,
) {
  const mutation = ![
    "validate",
    "preview",
    "inspect",
    "list",
    "history",
    "delete-preview",
  ].includes(command.operation);
  const result = (payload: SchedulePayload) =>
    resultFor(
      "schedule",
      payload,
      [],
      payload.ok
        ? { kind: "completed" }
        : {
            kind: "failed",
            effect: payload.error.code === "recovery-required" ? "uncertain" : "none",
          },
      {
        intent: mutation ? "mutate" : "none",
        observed:
          !payload.ok && payload.error.code === "recovery-required"
            ? "uncertain"
            : payload.ok && mutation
              ? "completed"
              : "none",
      },
    );
  const fail = (code: string) => result({ ok: false, error: { code } });
  const graph = services();
  const workspace = await graph.ensureWorkspaceSet(signal);
  if (!workspace.ok) return fail("workspace-unavailable");
  const configuration = await loadProductConfiguration(
    graph,
    productConfigurationLoadRequest(globals),
    signal,
  );
  if (!["published", "unchanged"].includes(configuration.outcome.kind))
    return fail("configuration-unavailable");
  const product = await openProductArtifactSession(graph, signal);
  if (!product) return fail("storage-unavailable");
  let watcher: ReturnType<typeof startConfigurationReloadWatcher> | undefined;
  let closeHost = async () => {};
  let answer: ReturnType<typeof result> | undefined;
  let cleanClose = true;
  try {
    answer = await (async () => {
      const connections = composeProductProviderConnections(graph, globals, {
        configuration: configuration.values,
        modelCatalogs: product.modelCatalogs,
        providerContinuations: product.providerContinuations,
      });
      const host = await composeProductShellAttachments({
        clock: graph.clock,
        eventStore: product.eventStore,
        fileSystem: graph.fileSystem,
        workspaceSet: workspace.value.set,
        configurationGeneration: configuration.generation,
        configurationValues: () => graph.loader.current()?.values ?? configuration.values,
        sandboxConfiguration: () => graph.loader.current(),
        signal,
        artifacts: product.artifacts,
        loom: product.loom,
        scratch: product.scratch,
        tasks: product.tasks,
        workflows: product.workflows,
        joins: product.joins,
        schedules: { ...product.schedules, autostart: command.operation === "host" },
        publishNativePackages: product.publishNativePackages,
        agentRegistry: agentRegistryFrom(configuration.values),
        async resolveAgentProvider(profile, signal) {
          const resolved = await connections.resolveProfile(profile, signal);
          return resolved.kind === "ready"
            ? { adapter: resolved.adapter, catalog: resolved.session.catalog }
            : { reason: `agent-provider-${resolved.code}` };
        },
        modelPreferences: () =>
          modelPreferencesFrom(graph.loader.current()?.values ?? configuration.values),
      });
      closeHost = async () => {
        await host?.close();
      };
      const schedules = host?.schedules;
      if (!schedules) return fail("schedule-host-unavailable");
      if (command.operation !== "host")
        return result(await schedules.actions.execute(command, "user", signal));
      if (schedules.inspect().failure)
        return fail(schedules.inspect().failure ?? "schedule-host-unavailable");
      watcher = startConfigurationReloadWatcher(graph, globals, { signal });
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      const clean = await schedules.close();
      return result(
        clean
          ? { ok: true, value: { kind: "schedule-host-stopped" } }
          : { ok: false, error: { code: "recovery-required" } },
      );
    })();
  } finally {
    watcher?.dispose();
    await closeHost();
    cleanClose = await product.close();
  }
  return cleanClose ? answer : fail("recovery-required");
}
