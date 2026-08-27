/**
 * Strict product language-server and debug-adapter tools (#805).
 *
 * Concrete operations are grouped behind closed schemas and adapt the existing
 * supervisors. The supervisors remain the protocol owners; this module owns
 * registration and dispatch through the unified product gateway.
 */

import type {
  ConfigurationGeneration,
  FileSystemPort,
  LocalPath,
  ToolCatalog,
  ToolInvocationOutcome,
  ToolRegistry,
  ToolRegistryEntry,
} from "../domain/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  fileUriToAbsolutePath,
  localPath,
  managedServiceId,
} from "../domain/index.ts";
import type { DebugAdapterSupervisor } from "./debug-adapter.ts";
import type { LanguageServerSupervisor } from "./language-server.ts";
import { dapToolDefinitions } from "./product-language-tools/dap.ts";
import { lspToolDefinitions } from "./product-language-tools/lsp.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "./tool-call-loop.ts";
import { createWorkspacePathBinder } from "./workspace-path.ts";

export const PRODUCT_LANGUAGE_TOOLS_OWNER = "#805";

export type ProductLanguageToolPorts = {
  readonly generation: ConfigurationGeneration;
  readonly languageServers: LanguageServerSupervisor;
  /**
   * Live composition configures the supervisor to trust its caller because
   * #786's gateway is the sole policy and confirmation boundary.
   */
  readonly debugAdapters: DebugAdapterSupervisor;
  readonly fileSystem?: FileSystemPort;
  readonly workspaceRoot?: LocalPath;
};

export type ProductLanguageTools = {
  readonly owner: typeof PRODUCT_LANGUAGE_TOOLS_OWNER;
  readonly registry: ToolRegistry;
  readonly catalog: ToolCatalog;
  readonly runner: ToolRunnerPort;
  readonly toolNames: readonly string[];
  /** Resynchronize open documents and collect bounded diagnostics after writes. */
  afterWorkspaceMutation(signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>>;
};

function mustEntry(result: ReturnType<typeof createToolRegistryEntry>): ToolRegistryEntry {
  if (!result.ok) {
    throw new Error(`product language tool registration failed: ${result.error.code}`);
  }
  return result.value;
}

/** Compose the complete strict LSP/DAP product operation set. */
export function composeProductLanguageTools(ports: ProductLanguageToolPorts): ProductLanguageTools {
  const definitions = [
    ...lspToolDefinitions(ports.languageServers),
    ...dapToolDefinitions(ports.debugAdapters),
  ];
  const entries = definitions.map((definition) =>
    mustEntry(
      createToolRegistryEntry(definition.document, {
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        ...(definition.effectFor === undefined ? {} : { effectFor: definition.effectFor }),
      }),
    ),
  );
  const registryResult = createToolRegistry(ports.generation, entries);
  if (!registryResult.ok) {
    throw new Error(`product language tool registry failed: ${registryResult.error.code}`);
  }
  const registry = registryResult.value;
  const byName = new Map(definitions.map((definition) => [definition.document.name, definition]));
  const activeLanguageServers = new Set<string>();
  const workspacePathBinder =
    ports.fileSystem === undefined ? null : createWorkspacePathBinder(ports.fileSystem);

  const runner: ToolRunnerPort = {
    async execute(request: ToolRunnerRequest): Promise<ToolInvocationOutcome> {
      if (request.signal.aborted) {
        return { status: "cancelled", effect: "none" };
      }
      const definition = byName.get(request.toolName);
      if (definition === undefined) {
        return {
          status: "unavailable",
          reason: `unknown product language tool: ${request.toolName}`,
          effect: "none",
        };
      }
      const parsed = definition.inputSchema.safeParse(request.input);
      if (!parsed.success) {
        return { status: "malformed", reason: "malformed-input", effect: "none" };
      }
      const outcome = await definition.execute({ ...request, input: parsed.data });
      if (
        outcome.status === "completed" &&
        request.toolName.startsWith("lsp_") &&
        typeof parsed.data.serviceId === "string"
      ) {
        if (request.toolName === "lsp_shutdown") {
          activeLanguageServers.delete(parsed.data.serviceId);
        } else {
          activeLanguageServers.add(parsed.data.serviceId);
        }
      }
      return outcome;
    },
  };

  const afterWorkspaceMutation = async (
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>> => {
    if (ports.fileSystem === undefined || ports.workspaceRoot === undefined) {
      return { status: "unavailable", reason: "workspace-filesystem-not-bound" };
    }
    const servers: Array<Readonly<Record<string, unknown>>> = [];
    for (const serviceIdText of activeLanguageServers) {
      if (signal?.aborted === true) {
        return { status: "cancelled", servers };
      }
      const serviceId = managedServiceId.from(serviceIdText);
      const snapshot = ports.languageServers.snapshot(serviceId);
      if (snapshot === null || (snapshot.state !== "ready" && snapshot.state !== "degraded")) {
        servers.push({ serviceId: serviceIdText, status: "unavailable" });
        continue;
      }
      const documents: Array<Readonly<Record<string, unknown>>> = [];
      for (const tracked of snapshot.openDocuments) {
        const decoded = fileUriToAbsolutePath(tracked.uri);
        if (!decoded.ok) {
          documents.push({ uri: tracked.uri, status: "invalid-uri" });
          continue;
        }
        const bound = await workspacePathBinder?.bind(ports.workspaceRoot, decoded.value, signal);
        if (bound === undefined || !bound.ok) {
          documents.push({
            uri: tracked.uri,
            status: `path-${bound?.error.code ?? "unavailable"}`,
          });
          continue;
        }
        const current = ports.languageServers.document(serviceId, tracked.uri);
        const read = await ports.fileSystem.readText(
          localPath(bound.value.resolved),
          4 * 1_024 * 1_024,
          signal,
        );
        if (!read.ok) {
          if (read.error.code === "not-found") {
            const closed = await ports.languageServers.closeDocument(
              serviceId,
              snapshot.generation,
              { uri: tracked.uri },
            );
            documents.push({
              uri: tracked.uri,
              status: closed.ok ? "closed-missing" : "close-failed",
            });
          } else {
            documents.push({ uri: tracked.uri, status: `read-${read.error.code}` });
          }
          continue;
        }
        if (current !== null && current.text === read.value) {
          documents.push({
            uri: tracked.uri,
            status: "unchanged",
            diagnostics: ports.languageServers.diagnostics(serviceId, tracked.uri),
          });
          continue;
        }
        const changed = await ports.languageServers.changeDocument(serviceId, snapshot.generation, {
          uri: tracked.uri,
          version: tracked.version + 1,
          contentChanges: [{ kind: "full", text: read.value }],
        });
        if (!changed.ok) {
          documents.push({ uri: tracked.uri, status: `change-${changed.error.code}` });
          continue;
        }
        const saved = await ports.languageServers.saveDocument(serviceId, snapshot.generation, {
          uri: tracked.uri,
          text: read.value,
        });
        documents.push({
          uri: tracked.uri,
          status: saved.ok ? "synchronized" : `save-${saved.error.code}`,
          diagnostics: ports.languageServers.diagnostics(serviceId, tracked.uri),
        });
      }
      servers.push({
        serviceId: serviceIdText,
        generation: Number(snapshot.generation),
        status: "completed",
        documents,
      });
    }
    return { status: "completed", servers };
  };

  return {
    owner: PRODUCT_LANGUAGE_TOOLS_OWNER,
    registry,
    catalog: registry.catalog,
    runner,
    toolNames: entries.map((entry) => entry.descriptor.name),
    afterWorkspaceMutation,
  };
}
