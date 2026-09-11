/** Resolve model references at dispatch, before the existing protocol owner acts. */
import { z } from "zod";
import { managedServiceId } from "../../../domain/foundation/index.ts";
import type { DebugAdapterSupervisor } from "../../debugging/debug-adapter.ts";
import type { LanguageServerSupervisor } from "../../language/language-server.ts";
import {
  configurationReferenceSchema,
  EMPTY_LANGUAGE_SERVICES,
  type LanguageServiceConfiguration,
  languageConfigurationDigest,
} from "./configuration.ts";
import {
  completed,
  failed,
  type ProductLanguageToolDefinition,
  resultOutputSchema,
  toolDocument,
  unavailable,
} from "./contracts.ts";

export function bindLanguageToolReferences(options: {
  readonly definitions: readonly ProductLanguageToolDefinition[];
  readonly configuration?: () => LanguageServiceConfiguration;
  readonly workspaceRoot?: string;
  readonly languageServers: LanguageServerSupervisor;
  readonly debugAdapters: DebugAdapterSupervisor;
}) {
  const bindings = new Map<string, string>();
  const mutations = new Set<string>();
  const snapshot = (name: string, id: string) =>
    name.startsWith("lsp_")
      ? options.languageServers.snapshot(managedServiceId.from(id))
      : options.debugAdapters.snapshot(managedServiceId.from(id));
  const catalog = () => {
    try {
      const configuration = options.configuration?.() ?? {
        generation: 0,
        services: EMPTY_LANGUAGE_SERVICES,
      };
      return {
        generation: configuration.generation,
        languageServers: configuration.services.languageServers.filter(
          (item) => item.workspaceRoot === options.workspaceRoot,
        ),
        debugAdapters: configuration.services.debugAdapters.filter(
          (item) => item.workspaceRoot === options.workspaceRoot,
        ),
      };
    } catch {
      return null;
    }
  };
  const discovery = (kind: "lsp" | "dap"): ProductLanguageToolDefinition => ({
    document: toolDocument({
      name: `${kind}_configurations`,
      title: kind === "lsp" ? "Configured language servers" : "Configured debug adapters",
      description: `Discover user-authorized ${kind} startup references for this workspace. Start the service, then use its returned generation and negotiated capabilities.`,
      effect: "observation",
      capabilityKind: kind,
    }),
    inputSchema: z.object({}).strict(),
    outputSchema: resultOutputSchema,
    execute: async () => {
      const current = catalog();
      if (current === null) return unavailable("service-configuration-unavailable");
      const services = kind === "lsp" ? current.languageServers : current.debugAdapters;
      return completed(
        services.map((service) => ({
          serviceId: service.serviceId,
          configurationDigest: languageConfigurationDigest({
            generation: current.generation,
            service,
          }),
          state: snapshot(`${kind}_status`, service.serviceId)?.state ?? "not-started",
          ...("targets" in service
            ? { targets: service.targets.map((target) => ({ id: target.id, kind: target.kind })) }
            : {}),
        })),
      );
    },
  });
  const definitions = options.definitions.map((definition): ProductLanguageToolDefinition => {
    const name = definition.document.name;
    const starts = name === "lsp_start" || name === "lsp_restart" || name === "dap_start";
    const targets = name === "dap_launch" || name === "dap_attach";
    const inputSchema = starts
      ? name === "lsp_restart"
        ? configurationReferenceSchema
            .extend({ generation: z.number().int().nonnegative() })
            .strict()
        : configurationReferenceSchema
      : targets
        ? configurationReferenceSchema
            .extend({
              generation: z.number().int().nonnegative(),
              targetId: z.string().min(1).max(256),
            })
            .strict()
        : definition.inputSchema;
    return {
      ...definition,
      inputSchema,
      document: {
        ...definition.document,
        description: starts
          ? `${definition.document.description}. Use a reference from ${name.startsWith("lsp_") ? "lsp" : "dap"}_configurations; executable and initialization options are user-owned.`
          : targets
            ? `${definition.document.description}. Use an authorized targetId from dap_configurations.`
            : definition.document.description,
      },
      async execute(request) {
        const id = request.input.serviceId;
        if (typeof id !== "string") return failed("malformed-input");
        const before = snapshot(name, id);
        if (
          before &&
          options.workspaceRoot !== undefined &&
          before.key.workspaceRoot !== options.workspaceRoot
        )
          return unavailable("service-workspace-mismatch");
        const cleanup = name === "lsp_shutdown" || name === "dap_disconnect";
        const current = cleanup ? { generation: 0, ...EMPTY_LANGUAGE_SERVICES } : catalog();
        if (current === null) return unavailable("service-configuration-unavailable");
        const service = (
          name.startsWith("lsp_") ? current.languageServers : current.debugAdapters
        ).find((item) => item.serviceId === id);
        const digest =
          service === undefined
            ? null
            : languageConfigurationDigest({ generation: current.generation, service });
        if (starts || targets) {
          if (service === undefined) return unavailable("service-configuration-not-found");
          if (request.input.configurationDigest !== digest)
            return unavailable("stale-service-configuration");
        }
        if (!starts && !cleanup && bindings.has(id) && bindings.get(id) !== digest)
          return unavailable("stale-service-configuration");
        let input = request.input;
        if (starts && service !== undefined) {
          input = {
            ...service,
            configurationGeneration: current.generation,
            ...(name === "lsp_restart" ? { generation: request.input.generation } : {}),
          };
          const { targets: _targets, ...startInput } = input;
          input = startInput;
        }
        if (targets) {
          const adapter = current.debugAdapters.find((item) => item.serviceId === id);
          const target = adapter?.targets.find(
            (item) =>
              item.id === input.targetId &&
              item.kind === (name === "dap_launch" ? "launch" : "attach"),
          );
          if (target === undefined) return unavailable("debug-target-configuration-not-found");
          input = {
            serviceId: id,
            generation: input.generation,
            configuration: target.configuration,
            ...(name === "dap_launch" && target.noDebug !== undefined
              ? { noDebug: target.noDebug }
              : {}),
          };
        }
        const mutation = request.effect !== "observation";
        if (mutations.has(id)) return unavailable("service-operation-in-progress");
        if (mutation) mutations.add(id);
        const documents = name.startsWith("lsp_")
          ? options.languageServers.snapshot(managedServiceId.from(id))?.openDocuments
          : undefined;
        try {
          const outcome = await definition.execute({ ...request, input });
          if (outcome.status === "failed") {
            if (outcome.reason === "target-start-uncertain")
              return {
                status: "uncertain",
                effect: "uncertain",
                recoveryHint:
                  "Inspect the existing debug target before disconnecting or starting a replacement adapter.",
              };
            if (outcome.reason === "cancelled")
              return { status: "cancelled", effect: mutation ? "uncertain" : "none" };
            if (outcome.reason.endsWith("-timeout"))
              return { status: "timed-out", effect: mutation ? "uncertain" : "none" };
          }
          if (outcome.status === "completed" && starts && digest !== null) bindings.set(id, digest);
          if (outcome.status === "completed" && cleanup) bindings.delete(id);
          if (outcome.status === "completed" && !mutation && before !== null) {
            const after = snapshot(name, id);
            if (after === null || after.generation !== before.generation)
              return unavailable("stale-service-generation");
            if (name !== "lsp_status" && after.state !== "ready" && after.state !== "degraded")
              return unavailable("service-not-ready");
            if (bindings.has(id)) {
              const latest = catalog();
              const configured = (
                name.startsWith("lsp_") ? latest?.languageServers : latest?.debugAdapters
              )?.find((item) => item.serviceId === id);
              if (
                latest === null ||
                configured === undefined ||
                languageConfigurationDigest({
                  generation: latest.generation,
                  service: configured,
                }) !== digest
              )
                return unavailable("stale-service-configuration");
            }
            if (
              documents !== undefined &&
              JSON.stringify(documents) !==
                JSON.stringify(
                  options.languageServers.snapshot(managedServiceId.from(id))?.openDocuments,
                )
            )
              return unavailable("stale-document");
            if (
              "session" in before &&
              "session" in after &&
              before.session.stopped?.generation !== after.session.stopped?.generation
            )
              return unavailable("stale-debug-stop-generation");
          }
          return outcome;
        } finally {
          if (mutation) mutations.delete(id);
        }
      },
    };
  });
  return [discovery("lsp"), discovery("dap"), ...definitions];
}
