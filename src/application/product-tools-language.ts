/**
 * Product language-server and DAP tools (#714).
 *
 * Registers builtins that adapt {@link LanguageServerSupervisor} and
 * {@link DebugAdapterSupervisor}. Session identity is model-supplied
 * serviceId/generation; hosts must already own the managed-service graph.
 */

import { z } from "zod";

import type {
  ConfigurationGeneration,
  ManagedServiceId,
  ServiceGeneration,
  ToolCatalog,
  ToolInvocationOutcome,
  ToolRegistry,
  ToolRegistryEntry,
} from "../domain/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  managedServiceId,
  serviceGeneration,
  type ToolManifestDocument,
} from "../domain/index.ts";
import type { DebugAdapterSupervisor } from "./debug-adapter.ts";
import type { LanguageServerSupervisor } from "./language-server.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "./tool-call-loop.ts";

export const PRODUCT_LANGUAGE_TOOLS_OWNER = "#714";

const openObject = z.record(z.string(), z.unknown()) as z.ZodType<
  Readonly<Record<string, unknown>>
>;

function document(
  name: string,
  title: string,
  description: string,
  effect: ToolManifestDocument["effect"],
  capabilityKind: ToolManifestDocument["capabilityKind"],
): ToolManifestDocument {
  return {
    namespace: "workspace",
    name,
    version: 1,
    source: "builtin",
    title,
    description,
    effect,
    capabilityKind,
    platforms: [],
    limits: defaultToolLimits({ defaultTimeoutMs: 60_000 }),
    concurrency: defaultConcurrencyContract({ maxPerWorkspace: 2 }),
    resultProjection: defaultProjectionContract(),
  };
}

function mustEntry(result: ReturnType<typeof createToolRegistryEntry>): ToolRegistryEntry {
  if (!result.ok) {
    throw new Error(`product language tool registration failed: ${result.error.code}`);
  }
  return result.value;
}

function jsonRecord(value: unknown): Readonly<Record<string, unknown>> {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    return { ok: false, reason: "unserializable" };
  }
  const parsed: unknown = JSON.parse(encoded);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { value: parsed as unknown };
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function failed(code: string): ToolInvocationOutcome {
  return { status: "failed", reason: code, effect: "none" };
}

function completed(value: unknown): ToolInvocationOutcome {
  return { status: "completed", output: jsonRecord(value), effect: "completed" };
}

function errorCode(error: { readonly code?: string; readonly kind?: string }): string {
  if (typeof error.code === "string") {
    return error.code;
  }
  if (typeof error.kind === "string") {
    return error.kind;
  }
  return "failed";
}

function parseSession(input: Readonly<Record<string, unknown>>):
  | {
      readonly ok: true;
      readonly serviceId: ManagedServiceId;
      readonly generation: ServiceGeneration;
    }
  | { readonly ok: false; readonly reason: string } {
  if (typeof input.serviceId !== "string" || typeof input.generation !== "number") {
    return { ok: false, reason: "malformed-input" };
  }
  try {
    return {
      ok: true,
      serviceId: managedServiceId.from(input.serviceId),
      generation: serviceGeneration.from(input.generation),
    };
  } catch {
    return { ok: false, reason: "malformed-input" };
  }
}

export type ProductLanguageToolPorts = {
  readonly generation: ConfigurationGeneration;
  readonly languageServers: LanguageServerSupervisor;
  readonly debugAdapters: DebugAdapterSupervisor;
};

export type ProductLanguageTools = {
  readonly owner: typeof PRODUCT_LANGUAGE_TOOLS_OWNER;
  readonly registry: ToolRegistry;
  readonly catalog: ToolCatalog;
  readonly runner: ToolRunnerPort;
  readonly toolNames: readonly string[];
};

/**
 * Compose builtin LSP / DAP tools.
 */
export function composeProductLanguageTools(ports: ProductLanguageToolPorts): ProductLanguageTools {
  const entries: ToolRegistryEntry[] = [
    mustEntry(
      createToolRegistryEntry(
        document(
          "lsp_start",
          "Start language server",
          "Start a managed language server",
          "mutation",
          "lsp",
        ),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("lsp_hover", "LSP hover", "Hover at a document position", "observation", "lsp"),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "lsp_definition",
          "LSP definition",
          "Go to definition at a document position",
          "observation",
          "lsp",
        ),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "lsp_references",
          "LSP references",
          "Find references at a document position",
          "observation",
          "lsp",
        ),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "lsp_diagnostics",
          "LSP diagnostics",
          "Read published diagnostics for a document URI",
          "observation",
          "lsp",
        ),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "lsp_shutdown",
          "Shutdown language server",
          "Shut down a language server",
          "mutation",
          "lsp",
        ),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "dap_start",
          "Start debug adapter",
          "Start a managed DAP adapter",
          "mutation",
          "dap",
        ),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("dap_launch", "DAP launch", "Launch a debug target", "mutation", "dap"),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "dap_set_breakpoints",
          "DAP breakpoints",
          "Set breakpoints on a source",
          "mutation",
          "dap",
        ),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "dap_stack_trace",
          "DAP stack",
          "Read a stopped thread stack",
          "observation",
          "dap",
        ),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document("dap_continue", "DAP continue", "Continue a stopped thread", "mutation", "dap"),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "dap_disconnect",
          "DAP disconnect",
          "Disconnect a debug session",
          "mutation",
          "dap",
        ),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
  ];

  const registryResult = createToolRegistry(ports.generation, entries);
  if (!registryResult.ok) {
    throw new Error(`product language tool registry failed: ${registryResult.error.code}`);
  }
  const registry = registryResult.value;
  const lsp = ports.languageServers;
  const dap = ports.debugAdapters;

  const runner: ToolRunnerPort = {
    async execute(request: ToolRunnerRequest): Promise<ToolInvocationOutcome> {
      if (request.signal.aborted) {
        return { status: "cancelled", effect: "none" };
      }
      const input = request.input;
      switch (request.toolName) {
        case "lsp_start": {
          const result = await lsp.start(input as never, request.signal);
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "lsp_hover": {
          const session = parseSession(input);
          if (!session.ok) {
            return failed(session.reason);
          }
          if (
            typeof input.uri !== "string" ||
            typeof input.line !== "number" ||
            typeof input.character !== "number"
          ) {
            return failed("malformed-input");
          }
          const result = await lsp.hover(
            session.serviceId,
            session.generation,
            {
              uri: input.uri,
              position: { line: input.line, character: input.character },
            },
            request.signal,
          );
          return result.ok ? completed({ hover: result.value }) : failed(errorCode(result.error));
        }
        case "lsp_definition": {
          const session = parseSession(input);
          if (!session.ok) {
            return failed(session.reason);
          }
          if (
            typeof input.uri !== "string" ||
            typeof input.line !== "number" ||
            typeof input.character !== "number"
          ) {
            return failed("malformed-input");
          }
          const result = await lsp.definition(
            session.serviceId,
            session.generation,
            {
              uri: input.uri,
              position: { line: input.line, character: input.character },
            },
            request.signal,
          );
          return result.ok
            ? completed({ locations: result.value })
            : failed(errorCode(result.error));
        }
        case "lsp_references": {
          const session = parseSession(input);
          if (!session.ok) {
            return failed(session.reason);
          }
          if (
            typeof input.uri !== "string" ||
            typeof input.line !== "number" ||
            typeof input.character !== "number"
          ) {
            return failed("malformed-input");
          }
          const result = await lsp.references(
            session.serviceId,
            session.generation,
            {
              uri: input.uri,
              position: { line: input.line, character: input.character },
              includeDeclaration:
                typeof input.includeDeclaration === "boolean" ? input.includeDeclaration : true,
            },
            request.signal,
          );
          return result.ok
            ? completed({ locations: result.value })
            : failed(errorCode(result.error));
        }
        case "lsp_diagnostics": {
          if (typeof input.serviceId !== "string" || typeof input.uri !== "string") {
            return failed("malformed-input");
          }
          try {
            const diagnostics = lsp.diagnostics(managedServiceId.from(input.serviceId), input.uri);
            return completed({ diagnostics });
          } catch {
            return failed("malformed-input");
          }
        }
        case "lsp_shutdown": {
          const session = parseSession(input);
          if (!session.ok) {
            return failed(session.reason);
          }
          const result = await lsp.shutdown(session.serviceId, session.generation, request.signal);
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "dap_start": {
          const result = await dap.start(input as never, request.signal);
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "dap_launch": {
          const session = parseSession(input);
          if (!session.ok) {
            return failed(session.reason);
          }
          const result = await dap.launch(
            session.serviceId,
            session.generation,
            input as never,
            request.signal,
          );
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "dap_set_breakpoints": {
          const session = parseSession(input);
          if (!session.ok) {
            return failed(session.reason);
          }
          const result = await dap.setBreakpoints(
            session.serviceId,
            session.generation,
            input as never,
            request.signal,
          );
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "dap_stack_trace": {
          const session = parseSession(input);
          if (!session.ok) {
            return failed(session.reason);
          }
          if (typeof input.threadId !== "number" || typeof input.stoppedGeneration !== "number") {
            return failed("malformed-input");
          }
          const result = await dap.stackTrace(
            session.serviceId,
            session.generation,
            {
              threadId: input.threadId,
              stoppedGeneration: input.stoppedGeneration,
              ...(typeof input.startFrame === "number" ? { startFrame: input.startFrame } : {}),
              ...(typeof input.levels === "number" ? { levels: input.levels } : {}),
            },
            request.signal,
          );
          return result.ok ? completed({ frames: result.value }) : failed(errorCode(result.error));
        }
        case "dap_continue": {
          const session = parseSession(input);
          if (!session.ok) {
            return failed(session.reason);
          }
          if (typeof input.threadId !== "number" || typeof input.stoppedGeneration !== "number") {
            return failed("malformed-input");
          }
          const result = await dap.continueExecution(
            session.serviceId,
            session.generation,
            { threadId: input.threadId, stoppedGeneration: input.stoppedGeneration },
            request.signal,
          );
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        case "dap_disconnect": {
          const session = parseSession(input);
          if (!session.ok) {
            return failed(session.reason);
          }
          const result = await dap.disconnect(session.serviceId, session.generation, {
            signal: request.signal,
          });
          return result.ok ? completed(result.value) : failed(errorCode(result.error));
        }
        default:
          return {
            status: "unavailable",
            reason: `unknown product language tool: ${request.toolName}`,
            effect: "none",
          };
      }
    },
  };

  return {
    owner: PRODUCT_LANGUAGE_TOOLS_OWNER,
    registry,
    catalog: registry.catalog,
    runner,
    toolNames: entries.map((entry) => entry.descriptor.name),
  };
}
