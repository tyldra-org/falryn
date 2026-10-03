/**
 * Prepare relevant configured MCP servers before a turn (#1157).
 *
 * A server whose catalog is not current is connected (when needed) and discovered only when
 * the task names it or the user selected it, at most `serversPerTurn` servers within one
 * deadline. Disabled servers, explicit-only servers the user did not select, and irrelevant
 * servers start nothing. Preparation never submits a prompt, starts a model turn or calls a
 * tool; its receipt records discovery requests and transport/process starts separately.
 */
import type { McpConnection } from "../../domain/extensions/mcp.ts";
import {
  MCP_PREPARATION_LIMITS,
  type McpPreparationServer,
  mcpServerRelevant,
} from "../../domain/extensions/mcp-preparation.ts";
import type { McpCatalog } from "./mcp-catalog.ts";
import type { McpLifecycle } from "./mcp-lifecycle.ts";

export type McpPreparationPorts = {
  readonly lifecycle: Pick<McpLifecycle, "inspect" | "connect">;
  readonly catalog: Pick<McpCatalog, "summaries" | "discover">;
  readonly configuration: () => {
    readonly servers: readonly McpConnection[];
    readonly generation: number;
  };
};

export type McpPreparationRequest = {
  readonly task: string;
  /** Servers the user selected for this turn (`$` mentions). */
  readonly selectedServers: readonly string[];
  /** Stable per-turn identity; each preparation request extends it. */
  readonly requestId: string;
  readonly signal: AbortSignal;
  readonly now?: () => number;
};

export async function prepareMcpServers(
  ports: McpPreparationPorts,
  request: McpPreparationRequest,
): Promise<readonly McpPreparationServer[]> {
  const now = request.now ?? Date.now;
  const deadline = now() + MCP_PREPARATION_LIMITS.deadlineMs;
  const configuration = ports.configuration();
  const selected = new Set(request.selectedServers);
  const servers: McpPreparationServer[] = [];
  let prepared = 0;
  const row = (
    serverId: string,
    decision: McpPreparationServer["decision"],
    reason: string | null,
    extra: Partial<McpPreparationServer> = {},
  ): McpPreparationServer => ({
    serverId,
    decision,
    reason,
    origin: null,
    discoveryRequests: 0,
    transportStarts: 0,
    processStarts: 0,
    catalogGeneration: null,
    ...extra,
  });
  for (const server of configuration.servers.slice(0, MCP_PREPARATION_LIMITS.servers)) {
    const summary = ports.catalog.summaries().find((item) => item.serverId === server.id);
    const isSelected = selected.has(server.id);
    if (!server.enabled) {
      servers.push(row(server.id, "skipped", "disabled"));
      continue;
    }
    if (server.explicitOnly && !isSelected) {
      servers.push(row(server.id, "skipped", "explicit-only"));
      continue;
    }
    if (summary?.state === "current") {
      servers.push(
        row(server.id, "reused", null, { catalogGeneration: summary.catalogGeneration }),
      );
      continue;
    }
    if (!isSelected && !mcpServerRelevant(server, request.task)) {
      servers.push(row(server.id, "skipped", "not-relevant"));
      continue;
    }
    if (request.signal.aborted) {
      servers.push(row(server.id, "skipped", "cancelled"));
      continue;
    }
    if (prepared >= MCP_PREPARATION_LIMITS.serversPerTurn || now() >= deadline) {
      servers.push(row(server.id, "skipped", "preparation-limit"));
      continue;
    }
    prepared++;
    const origin = isSelected ? ("user" as const) : ("discovery" as const);
    const before = ports.lifecycle.inspect().find((item) => item.serverId === server.id);
    const call = {
      origin,
      requestId: `${request.requestId}:prepare:${server.id}`,
      deadline,
      signal: request.signal,
    };
    let failure: string | null = null;
    let discoveryRequests = 0;
    if (before?.state !== "available") {
      const connected = await ports.lifecycle.connect({
        ...call,
        serverId: server.id,
        configurationGeneration: configuration.generation,
      });
      if (connected.kind !== "completed") failure = connected.code;
    }
    if (failure === null) {
      const discovered = await ports.catalog.discover(server.id, call);
      discoveryRequests = discovered.requests;
      if (discovered.kind !== "completed") failure = discovered.code;
    }
    const after = ports.lifecycle.inspect().find((item) => item.serverId === server.id);
    const transportStarts = Math.max(
      0,
      (after?.transportGeneration ?? 0) - (before?.transportGeneration ?? 0),
    );
    const counts = {
      origin,
      discoveryRequests,
      transportStarts,
      processStarts: server.transport === "stdio" ? transportStarts : 0,
    };
    const current = ports.catalog.summaries().find((item) => item.serverId === server.id);
    servers.push(
      failure === null
        ? row(server.id, "prepared", null, {
            ...counts,
            catalogGeneration: current?.state === "current" ? current.catalogGeneration : null,
          })
        : row(server.id, "failed", failure.slice(0, 128), counts),
    );
  }
  return servers;
}
