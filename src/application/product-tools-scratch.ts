/** Model-facing session scratch-resource tools (#848). */

import { z } from "zod";

import {
  type ConfigurationGeneration,
  conflictKey,
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  MAX_SCRATCH_LIST_LIMIT,
  MAX_SCRATCH_NAME_BYTES,
  MAX_SCRATCH_TEXT_BYTES,
  SCRATCH_MEDIA_TYPES,
  type SessionId,
  type ToolCatalog,
  type ToolInvocationOutcome,
  type ToolManifestDocument,
  type ToolRegistry,
  type ToolRegistryEntry,
} from "../domain/index.ts";
import type { ScratchResourcePort } from "./scratch-resources.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "./tool-call-loop.ts";

export const PRODUCT_SCRATCH_TOOLS_OWNER = "#848";

const scratchWriteInput = z
  .object({
    name: z.string().min(1).max(MAX_SCRATCH_NAME_BYTES),
    text: z.string().max(MAX_SCRATCH_TEXT_BYTES),
    mediaType: z.enum(SCRATCH_MEDIA_TYPES).default("text/plain"),
    expectedRevision: z.int().min(1).optional(),
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

const scratchReadInput = z
  .object({
    handle: z.string().min(1),
    revision: z.int().min(1).optional(),
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

const scratchListInput = z
  .object({ limit: z.int().min(1).max(MAX_SCRATCH_LIST_LIMIT).default(MAX_SCRATCH_LIST_LIMIT) })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

const scratchDiscardInput = z
  .object({ handle: z.string().min(1), expectedRevision: z.int().min(1) })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

const scratchMetadata = z
  .object({
    handle: z.string().min(1),
    name: z.string().min(1),
    status: z.enum(["active", "discarded"]),
    revision: z.int().min(1),
    digest: z.string().min(1),
    mediaType: z.enum(SCRATCH_MEDIA_TYPES),
    byteLength: z.int().min(0),
    createdAt: z.int().min(0),
    updatedAt: z.int().min(0),
  })
  .strict();

const scratchReadOutput = scratchMetadata.extend({ text: z.string() }).strict();
const scratchListOutput = z.object({ resources: z.array(scratchMetadata) }).strict();

function document(
  name: string,
  title: string,
  description: string,
  effect: ToolManifestDocument["effect"],
): ToolManifestDocument {
  return {
    namespace: "workspace",
    name,
    version: 1,
    source: "builtin",
    title,
    description,
    effect,
    capabilityKind: "filesystem",
    platforms: [],
    limits: defaultToolLimits({ maxInputBytes: MAX_SCRATCH_TEXT_BYTES + 4_096 }),
    concurrency: defaultConcurrencyContract({ maxPerWorkspace: 8 }),
    resultProjection: defaultProjectionContract({ modelMaxBytes: MAX_SCRATCH_TEXT_BYTES + 4_096 }),
  };
}

function mustEntry(result: ReturnType<typeof createToolRegistryEntry>): ToolRegistryEntry {
  if (!result.ok) throw new Error(`product scratch tool registration failed: ${result.error.code}`);
  return result.value;
}

function completed(output: Readonly<Record<string, unknown>>): ToolInvocationOutcome {
  return { status: "completed", output, effect: "completed" };
}

function failed(reason: string): ToolInvocationOutcome {
  return { status: "failed", reason, effect: "none" };
}

export type ProductScratchToolPorts = {
  readonly generation: ConfigurationGeneration;
  readonly scratch: ScratchResourcePort;
  readonly sessionId: SessionId;
};

export type ProductScratchTools = {
  readonly owner: typeof PRODUCT_SCRATCH_TOOLS_OWNER;
  readonly registry: ToolRegistry;
  readonly catalog: ToolCatalog;
  readonly runner: ToolRunnerPort;
  readonly toolNames: readonly string[];
};

export function composeProductScratchTools(ports: ProductScratchToolPorts): ProductScratchTools {
  const entries = [
    mustEntry(
      createToolRegistryEntry(
        document(
          "scratch_write",
          "Write scratch resource",
          "Create or revise session-scoped text without changing workspace files, Git, index, memory, or prompt context",
          "mutation",
        ),
        {
          inputSchema: scratchWriteInput,
          outputSchema: scratchMetadata,
          conflictKeysFor: (input) =>
            typeof input.name === "string"
              ? [conflictKey("scratch", `${ports.sessionId}/${input.name}`)]
              : [],
        },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "scratch_read",
          "Read scratch resource",
          "Read the exact current or specified revision of a session scratch resource",
          "observation",
        ),
        { inputSchema: scratchReadInput, outputSchema: scratchReadOutput },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "scratch_list",
          "List scratch resources",
          "List bounded scratch metadata for the current session without returning content",
          "observation",
        ),
        { inputSchema: scratchListInput, outputSchema: scratchListOutput },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "scratch_discard",
          "Discard scratch resource",
          "Tombstone a session scratch resource with stale-revision protection",
          "mutation",
        ),
        {
          inputSchema: scratchDiscardInput,
          outputSchema: scratchMetadata,
          conflictKeysFor: (input) =>
            typeof input.handle === "string" ? [conflictKey("scratch", input.handle)] : [],
        },
      ),
    ),
  ];
  const registryResult = createToolRegistry(ports.generation, entries);
  if (!registryResult.ok) {
    throw new Error(`product scratch tool registry failed: ${registryResult.error.code}`);
  }
  const registry = registryResult.value;

  const runner: ToolRunnerPort = {
    async execute(request: ToolRunnerRequest): Promise<ToolInvocationOutcome> {
      if (request.signal.aborted) return { status: "cancelled", effect: "none" };
      switch (request.toolName) {
        case "scratch_write": {
          const result = await ports.scratch.write(
            {
              sessionId: ports.sessionId,
              invocationId: request.invocationId,
              name: request.input.name,
              text: request.input.text,
              mediaType: request.input.mediaType,
              expectedRevision: request.input.expectedRevision,
            },
            request.signal,
          );
          return result.ok ? completed(result.value) : failed(result.error.code);
        }
        case "scratch_read": {
          const result = await ports.scratch.read(
            ports.sessionId,
            request.input.handle,
            request.input.revision,
            request.signal,
          );
          return result.ok ? completed(result.value) : failed(result.error.code);
        }
        case "scratch_list": {
          const result = ports.scratch.list(ports.sessionId, request.input.limit);
          return result.ok ? completed({ resources: result.value }) : failed(result.error.code);
        }
        case "scratch_discard": {
          const result = ports.scratch.discard(
            ports.sessionId,
            request.input.handle,
            request.input.expectedRevision,
            request.signal,
          );
          return result.ok ? completed(result.value) : failed(result.error.code);
        }
        default:
          return {
            status: "unavailable",
            reason: `unknown product scratch tool: ${request.toolName}`,
            effect: "none",
          };
      }
    },
  };

  return {
    owner: PRODUCT_SCRATCH_TOOLS_OWNER,
    registry,
    catalog: registry.catalog,
    runner,
    toolNames: entries.map((entry) => entry.descriptor.name),
  };
}
