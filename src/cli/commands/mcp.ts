import { z } from "zod";
import { MCP_DEADLINE_MS, type McpOutcome, type McpSnapshot } from "../../domain/extensions/mcp.ts";
import { NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import type { OwnedProcessRegistry } from "../../integrations/process/host-owned-process-registry.ts";
import { createHostManagedServicePort } from "../../integrations/process/host-process-sessions/managed-service.ts";
import type { GlobalOptions } from "../options.ts";
import { mcpConfiguration } from "../runtime/mcp-configuration.ts";
import { composeProductMcp } from "../runtime/product-mcp.ts";
import { createProductSandbox } from "../runtime/sandbox-configuration.ts";
import type { ServiceProvider } from "../runtime/services.ts";
import { standaloneEnvironment } from "../runtime/standalone-environment.ts";
import { resultFor } from "./shared.ts";

export const mcpArgumentsSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("inspect") }),
  z.strictObject({ action: z.literal("probe"), serverId: z.string().min(1).max(64) }),
]);
export type McpArguments = z.infer<typeof mcpArgumentsSchema>;
export type McpPayload = {
  readonly connections: readonly McpSnapshot[];
  readonly probe: McpOutcome | null;
};
export async function runMcp(
  services: ServiceProvider,
  args: McpArguments,
  globals: GlobalOptions,
  signal = new AbortController().signal,
  ownedProcesses?: OwnedProcessRegistry,
) {
  const graph = services();
  const environment = await standaloneEnvironment(graph, globals, signal, ownedProcesses);
  const record = graph.loader.current();
  if (!record) {
    environment.close();
    throw new Error("mcp-configuration-unavailable");
  }
  const sandbox = createProductSandbox({
    values: () => record.values,
    configuration: () => record,
    generation: () => Number(record.generation),
    now: () => Number(graph.clock.now()),
    workspaceRoot: graph.workspaceRoot,
  });
  const mcp = composeProductMcp({
    identity: crypto.randomUUID(),
    generation: record.generation,
    services: createHostManagedServicePort({
      sandbox,
      ...(ownedProcesses ? { ownedProcesses } : {}),
    }),
    context: environment.context,
    environment: graph.environment,
    configuration: () => ({ values: record.values, generation: Number(record.generation), record }),
    async authorize(requestSignal) {
      const trust = await graph.workspaceTrust.resolve(undefined, requestSignal);
      return trust.status === "accepted" || trust.status === "empty";
    },
  });
  try {
    let probe: McpOutcome | null = null;
    if (args.action === "probe") {
      const connection = mcpConfiguration(
        record.values,
        Number(record.generation),
        record,
      ).servers.find((entry) => entry.id === args.serverId);
      if (connection?.transport === "stdio") await environment.control.execute("reload", signal);
      const identity = crypto.randomUUID();
      const admitted = await environment.resources.execute<McpOutcome>({
        operation: identity,
        attempt: identity,
        generation: environment.resources.generation,
        inputBytes: args.serverId.length,
        amounts: { operations: 1, requests: 1, bufferedBytes: 1024 * 1024 },
        signal,
        unit: {
          id: workUnitId(identity),
          effect: "external",
          priority: "interactive",
          conflictKeys: [],
          dependencies: [],
          deadline: null,
          expectedOutputBytes: 4096,
          retry: NO_RETRY,
          scopeId: null,
        },
        async run(admittedSignal) {
          const result = await sandbox.run(
            {
              invocationId: identity,
              capabilityId: "mcp.probe",
              source: "builtin",
              catalogGeneration: Number(record.generation),
              policyGeneration: Number(record.generation),
              inputFingerprint: args.serverId,
              effect: "external",
              confirmationId: null,
              resourceTaskId: environment.resources.id,
              expiresAt: Date.now() + MCP_DEADLINE_MS,
            },
            () =>
              mcp.lifecycle.connect({
                serverId: args.serverId,
                configurationGeneration: Number(record.generation),
                origin: "user",
                requestId: identity,
                deadline: Date.now() + MCP_DEADLINE_MS,
                signal: admittedSignal,
              }),
          );
          const stopped = await mcp.close();
          const terminated = stopped.every((item) => item.kind === "completed");
          return {
            value: result.value,
            terminated,
            observedEffect: !terminated
              ? "uncertain"
              : result.value.kind === "completed"
                ? "completed"
                : result.value.effect,
          };
        },
      });
      probe =
        admitted.kind === "completed"
          ? admitted.value
          : {
              kind: "denied",
              code: "mcp-resource-admission-denied",
              effect: "none",
              snapshot: null,
            };
    }
    const stopped = await mcp.close();
    const payload: McpPayload = { connections: mcp.lifecycle.inspect(), probe };
    const uncertain = stopped.some((result) => result.kind !== "completed");
    return resultFor(
      "mcp",
      payload,
      [],
      uncertain || (probe && probe.kind !== "completed")
        ? {
            kind: "failed",
            effect: uncertain
              ? "uncertain"
              : probe?.kind !== "completed"
                ? (probe?.effect ?? "none")
                : "none",
          }
        : { kind: "completed" },
      {
        intent: args.action === "probe" ? "mutate" : "none",
        observed: uncertain
          ? "uncertain"
          : probe?.kind === "completed"
            ? "completed"
            : (probe?.effect ?? "none"),
      },
    );
  } finally {
    await mcp.close();
    environment.close();
  }
}
