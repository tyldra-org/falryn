import { randomUUID } from "node:crypto";
import type {
  ProfileTransitionOwner,
  ProfileTransitions,
} from "../../application/configuration/index.ts";
import {
  createProfileControl,
  type ProfileControl,
} from "../../application/configuration/profile-control.ts";
import { scopeProviderContinuations } from "../../application/providers/continuation-scope.ts";
import type { ProductAgentRuntime } from "../../application/runtime/product-agent-runtime.ts";
import type { ProductAdmissionBinding } from "../../application/runtime/product-live-turn.ts";
import type { ConfigurationGenerationRecord } from "../../domain/configuration/index.ts";
import { configurationGeneration } from "../../domain/foundation/index.ts";
import { runWorkingConfiguration } from "../commands/profile.ts";
import type { GlobalOptions } from "../options.ts";
import { startConfigurationReloadWatcher } from "./configuration-reload.ts";
import { modelPreferencesFrom } from "./model-configuration.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import { composeProductModelSettings } from "./product-model-settings.ts";
import { composeProductProfileTransitions } from "./product-profile-transitions.ts";
import {
  composeProductProviderConnections,
  type ProductProviderConnectionHandoff,
  type ProductProviderConnectionOptions,
  type ProductProviderConnections,
} from "./product-provider-connections.ts";
import type { Services } from "./services.ts";
import { workspaceProfilePreference } from "./workspace-profile-preferences.ts";

export type WorkingProfileSession = {
  readonly control: ProfileControl;
  readonly provider: ProductProviderConnectionHandoff;
  readonly modelSettings: ReturnType<typeof composeProductModelSettings>;
  readonly transitions: ProfileTransitions;
  readonly current: () => { generation: number; sources: string; policy: string };
  readonly scope: { sessionId: string; workspaceId: string };
  capture(): ProductAdmissionBinding;
  close(): Promise<void>;
};

export type WorkingProfileSessionFactory = (
  runtime: ProductAgentRuntime,
  compose: (
    record: ConfigurationGenerationRecord,
    connections: ProductProviderConnections,
    provider: Extract<ProductProviderConnectionHandoff, { kind: "ready" }>,
  ) => ProductAgentRuntime,
) => Promise<WorkingProfileSession>;

/** Host factory shared by interactive and embeddable session composition. */
export function productWorkingProfileSessions(
  parent: Services,
  globals: GlobalOptions,
  providerOptions: ProductProviderConnectionOptions,
  additionalOwners: readonly ProfileTransitionOwner[] = [],
): WorkingProfileSessionFactory {
  return async (runtime, compose) => {
    const history = await runtime.journal.replay();
    if (history.kind !== "rebuilt" && history.kind !== "empty")
      throw new Error("profile-recovery-unavailable");
    const prior =
      history.kind === "rebuilt"
        ? history.events.findLast(
            (event) =>
              event.kind === "configuration.transition.recorded" &&
              event.payload.publishedGeneration !== null,
          )
        : undefined;
    const recovered = prior?.kind === "configuration.transition.recorded" ? prior.payload : null;
    const baseline =
      recovered?.publishedGeneration == null
        ? runtime.correlation.configurationGeneration
        : configurationGeneration.from(
            Math.max(
              Number(runtime.correlation.configurationGeneration),
              recovered.publishedGeneration,
            ) + 1,
          );
    let closed = false;

    const graph: Services = {
      ...parent,
      ...parent.configurationSession(baseline),
    };
    const request = {
      ...productConfigurationLoadRequest(globals),
      ...(recovered ? { profile: recovered.profile } : {}),
    };
    const initial = await loadProductConfiguration(graph, request);
    if (initial.outcome.kind !== "published" && initial.outcome.kind !== "unchanged")
      throw new Error("profile-session-configuration-unavailable");
    const scope = {
      sessionId: String(runtime.correlation.sessionId),
      workspaceId: String(runtime.correlation.workspaceId),
    };
    let binding: ProductAdmissionBinding = {
      runtime,
      preferences: modelPreferencesFrom(initial.values),
      // Initial capture is installed below from the existing provider owner.
      catalog: null,
      generation: initial.generation,
    };
    const releases = new Set<() => Promise<void>>([async () => runtime.closeBindings()]);
    const scopedProviderOptions = (): ProductProviderConnectionOptions => ({
      ...providerOptions,
      ...(providerOptions.providerContinuations
        ? {
            providerContinuations: scopeProviderContinuations(
              providerOptions.providerContinuations,
              `${scope.sessionId}:${randomUUID()}`,
            ),
          }
        : {}),
    });
    const initialConnections = composeProductProviderConnections(graph, globals, {
      ...scopedProviderOptions(),
      configurationBinding: initial.values,
    });
    const initialProvider = await initialConnections.resolveSelected();
    let currentProvider = initialProvider;
    if (initialProvider.kind === "ready") {
      binding = {
        ...binding,
        catalog: initialProvider.session.catalog,
        runtime: compose(initial.outcome.record, initialConnections, initialProvider),
      };
      const initialRuntime = binding.runtime;
      releases.add(async () => {
        initialRuntime.closeBindings();
        await initialProvider.session.release();
      });
    }
    const resources = runtime.resources.openTask(String(initial.generation));
    const modelOwner: ProfileTransitionOwner = {
      id: "models-and-new-admissions",
      describe: () => ({
        owner: "models-and-new-admissions",
        required: true,
        availability: "available",
        applicationClass: "next-turn",
        preparation: "connection",
        cost: "unknown",
      }),
      async inspect(generation) {
        return {
          state: binding.generation === generation ? "applied" : "pending",
          generation: Number(binding.generation),
          code: binding.generation === generation ? "next-admission-bound" : "binding-retained",
        };
      },
      async prepare(candidate, _resources, signal) {
        if (candidate.record.generation === binding.generation)
          return {
            release: async () => {},
            acknowledge: async (generation) => ({
              state: "applied",
              generation,
              code: "binding-unchanged",
            }),
          };

        const connections = composeProductProviderConnections(graph, globals, {
          ...scopedProviderOptions(),
          configurationBinding: candidate.record.values,
        });
        const provider = await connections.resolveSelected(signal);
        if (provider.kind !== "ready") return { kind: "refused", code: provider.code };
        let nextRuntime: ProductAgentRuntime;
        try {
          nextRuntime = compose(candidate.record, connections, provider);
        } catch (error) {
          await provider.session.release();
          throw error;
        }
        const next = {
          runtime: nextRuntime,
          catalog: provider.session.catalog,
          preferences: modelPreferencesFrom(candidate.record.values),
          generation: candidate.record.generation,
        };
        let released = false;
        const release = async () => {
          if (released) return;
          released = true;
          releases.delete(release);
          next.runtime.closeBindings();
          await provider.session.release();
        };
        // A published but unacknowledged owner is retained for reconciliation
        // and still belongs to session shutdown.
        releases.add(release);
        return {
          release,
          async acknowledge(generation, current, abort) {
            if (abort.aborted || !current())
              return { state: "pending", generation: null, code: "stale-acknowledgement" };
            binding = next;
            currentProvider = provider;
            return { state: "applied", generation, code: "next-admission-bound" };
          },
        };
      },
    };
    const retainedOwners: ProfileTransitionOwner = {
      id: "existing-processes-and-session-storage",
      describe: () => ({
        owner: "existing-processes-and-session-storage",
        required: false,
        availability: "available",
        applicationClass: "application-restart",
        preparation: "none",
        cost: "none",
      }),
      async prepare(candidate) {
        const changed = candidate.changes.some(
          (change) =>
            !["models.", "providers.", "agents."].some((prefix) =>
              String(change.path).startsWith(prefix),
            ),
        );
        return {
          release: async () => {},
          acknowledge: async (generation) => ({
            state: changed ? "restart-required" : "applied",
            generation: changed ? Number(initial.generation) : generation,
            code: changed ? "existing-owner-retained" : "unchanged-inputs",
          }),
        };
      },
    };
    const packageOwner: ProfileTransitionOwner = {
      id: "optional-package-declarations",
      describe: (candidate) => ({
        owner: "optional-package-declarations",
        required: false,
        availability: candidate.record.issues.some((issue) => issue.kind === "package-unavailable")
          ? "unavailable"
          : "available",
        applicationClass: "next-operation",
        preparation: "none",
        cost: "none",
      }),
      prepare: async () => ({
        release: async () => {},
        acknowledge: async (generation) => ({
          state: "applied",
          generation,
          code: "declarations-available",
        }),
      }),
    };
    const service = composeProductProfileTransitions({
      graph,
      scope,
      request,
      resources,
      journal: runtime.journal,
      correlation: runtime.correlation,
      owners: [modelOwner, retainedOwners, packageOwner, ...additionalOwners],
      policyRevision: () => "user-profile-control-v1",
      // Model slash authorization is attached by its policy owner; absence denies it.
      authorize: (actor) => !closed && actor === "user",
    });
    const reload = startConfigurationReloadWatcher(graph, globals, {
      onInvalidation: service.transitions.invalidate,
    });
    const settings = () =>
      composeProductModelSettings(
        graph,
        {
          ...globals,
          profile: graph.loader.current()?.workingProfile?.id ?? globals.profile,
        },
        () => binding.preferences.roles.default ?? null,
        {
          async afterSave(revision, signal) {
            const current = service.current();
            const profile = graph.loader.current()?.workingProfile?.id ?? "default";
            const preview = await service.transitions.preview(
              {
                ...scope,
                profile,
                expectedGeneration: current.generation,
                expectedSources: current.sources,
                actor: "user",
              },
              signal,
            );
            if (preview.kind !== "preview") return null;
            const applied = await service.transitions.apply(
              {
                ...scope,
                actor: "user",
                candidateId: preview.candidateId,
                expectedGeneration: preview.expectedGeneration,
                savedFileRevision: revision,
              },
              signal,
            );
            return applied.kind === "receipt" ? applied.receipt : null;
          },
        },
      );
    const control = createProfileControl({
      ...service,
      scope,
      list: (signal) => runWorkingConfiguration(() => graph, { action: "list" }, globals, signal),
      async saveWorkspace(id, signal) {
        if (id !== null) {
          const preview = await service.transitions.preview(
            {
              ...scope,
              profile: id,
              expectedGeneration: service.current().generation,
              expectedSources: service.current().sources,
              actor: "user",
            },
            signal,
          );
          if (preview.kind !== "preview") return preview;
        }
        const saved = await workspaceProfilePreference(graph, signal, { profile: id });
        return saved.ok
          ? { kind: "workspace-preference-saved", ...saved.value, applies: "future-sessions" }
          : { kind: "refused", code: saved.error.code };
      },
      saveDefault: (id, signal) =>
        runWorkingConfiguration(() => graph, { action: "default", id }, globals, signal),
    });
    return {
      ...service,
      scope,
      control,
      get provider() {
        return currentProvider;
      },
      modelSettings: { execute: (input, signal) => settings().execute(input, signal) },
      capture: () => binding,
      close: async () => {
        closed = true;
        service.transitions.invalidate();
        reload.dispose();
        resources.close();
        await Promise.allSettled([...releases].map((release) => release()));
        releases.clear();
      },
    };
  };
}
