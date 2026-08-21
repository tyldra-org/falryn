/**
 * Product memory tools (#720): admit and recall.
 *
 * Registers trusted builtins over {@link createMemoryAdmission} and
 * {@link createMemoryRecall}. Turn-end admission orchestration lives in
 * {@link composeProductMemoryTurn}.
 */

import { z } from "zod";

import type {
  ConfigurationGeneration,
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
  type ToolManifestDocument,
} from "../domain/index.ts";
import { createMemoryAdmission, type MemoryAdmissionPort } from "./memory-admission.ts";
import { createMemoryRecall, type MemoryRecallPort } from "./memory-recall.ts";
import { createMemoryRecords } from "./memory-record.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "./tool-call-loop.ts";

export const PRODUCT_MEMORY_TOOLS_OWNER = "#720";

const openObject = z.record(z.string(), z.unknown()) as z.ZodType<
  Readonly<Record<string, unknown>>
>;

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
    capabilityKind: "other",
    platforms: [],
    limits: defaultToolLimits({ defaultTimeoutMs: 10_000 }),
    concurrency: defaultConcurrencyContract({ maxPerWorkspace: 4 }),
    resultProjection: defaultProjectionContract(),
  };
}

function mustEntry(result: ReturnType<typeof createToolRegistryEntry>): ToolRegistryEntry {
  if (!result.ok) {
    throw new Error(`product memory tool registration failed: ${result.error.code}`);
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

export type ProductMemoryToolPorts = {
  readonly generation: ConfigurationGeneration;
  readonly admission?: MemoryAdmissionPort;
  readonly recall?: MemoryRecallPort;
};

export type ProductMemoryTools = {
  readonly owner: typeof PRODUCT_MEMORY_TOOLS_OWNER;
  readonly registry: ToolRegistry;
  readonly catalog: ToolCatalog;
  readonly runner: ToolRunnerPort;
  readonly toolNames: readonly string[];
  readonly admission: MemoryAdmissionPort;
  readonly recall: MemoryRecallPort;
};

/**
 * Compose builtin memory admit/recall tools.
 */
export function composeProductMemoryTools(ports: ProductMemoryToolPorts): ProductMemoryTools {
  const store = createMemoryRecords();
  const admission = ports.admission ?? createMemoryAdmission(store);
  const recall = ports.recall ?? createMemoryRecall(store);

  const entries = [
    mustEntry(
      createToolRegistryEntry(
        document("memory_admit", "Admit memory", "Admit a memory record under policy", "mutation"),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
    mustEntry(
      createToolRegistryEntry(
        document(
          "memory_recall",
          "Recall memory",
          "Recall memory records for the turn",
          "observation",
        ),
        { inputSchema: openObject, outputSchema: openObject },
      ),
    ),
  ];
  const registryResult = createToolRegistry(ports.generation, entries);
  if (!registryResult.ok) {
    throw new Error(`product memory registry failed: ${registryResult.error.code}`);
  }
  const registry = registryResult.value;

  const runner: ToolRunnerPort = {
    async execute(request: ToolRunnerRequest): Promise<ToolInvocationOutcome> {
      switch (request.toolName) {
        case "memory_admit": {
          const input = request.input.record;
          const context = request.input.context;
          if (
            input === null ||
            typeof input !== "object" ||
            context === null ||
            typeof context !== "object"
          ) {
            return failed("malformed-input");
          }
          const admitted = admission.admit(input as never, context as never, request.signal);
          if (!admitted.ok) {
            return failed(admitted.error.code);
          }
          return completed({
            owner: PRODUCT_MEMORY_TOOLS_OWNER,
            admission: admitted.value,
          });
        }
        case "memory_recall": {
          const recalled = recall.recall(request.input as never, request.signal);
          if (!recalled.ok) {
            return failed(recalled.error.code);
          }
          return completed({
            owner: PRODUCT_MEMORY_TOOLS_OWNER,
            recall: recalled.value,
          });
        }
        default:
          return {
            status: "unavailable",
            reason: `unknown memory tool: ${request.toolName}`,
            effect: "none",
          };
      }
    },
  };

  return {
    owner: PRODUCT_MEMORY_TOOLS_OWNER,
    registry,
    catalog: registry.catalog,
    runner,
    toolNames: entries.map((entry) => entry.descriptor.name),
    admission,
    recall,
  };
}
