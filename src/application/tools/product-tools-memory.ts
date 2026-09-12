/**
 * Product memory tools (#720): admit and recall.
 *
 * Registers trusted builtins over {@link createMemoryAdmission} and
 * {@link createMemoryRecall}. Turn-end admission orchestration lives in
 * {@link composeProductMemoryTurn}.
 */

import { z } from "zod";

import { EVIDENCE_TRUSTS } from "../../domain/context/index.ts";
import {
  type ConfigurationGeneration,
  MAX_IDENTIFIER_LENGTH,
} from "../../domain/foundation/index.ts";
import {
  HARD_MEMORY_RECALL_MAX,
  MAX_MEMORY_CONTENT_BYTES,
  MAX_MEMORY_LOCATOR_BYTES,
  MAX_MEMORY_PROVENANCE,
  MAX_MEMORY_PROVENANCE_LOCATOR_BYTES,
  MAX_MEMORY_RECALL_QUERY_BYTES,
  MAX_MEMORY_SUBJECT_BYTES,
  MAX_MEMORY_SUPERSEDES,
  MEMORY_KINDS,
  MEMORY_ORIGINS,
  MEMORY_RECORD_VERSION,
  MEMORY_SENSITIVITIES,
  MEMORY_SOURCE_KINDS,
} from "../../domain/memory/index.ts";
import type {
  ToolCatalog,
  ToolInvocationOutcome,
  ToolRegistry,
  ToolRegistryEntry,
} from "../../domain/tools/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  type ToolManifestDocument,
} from "../../domain/tools/index.ts";
import { createMemoryAdmission, type MemoryAdmissionPort } from "../memory/memory-admission.ts";
import { createMemoryRecall, type MemoryRecallPort } from "../memory/memory-recall.ts";
import { createMemoryRecords, type MemoryRecords } from "../memory/memory-record.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "../runtime/tool-call-loop.ts";

export const PRODUCT_MEMORY_TOOLS_OWNER = "#720";

const openObject = z.record(z.string(), z.unknown()) as z.ZodType<
  Readonly<Record<string, unknown>>
>;

const memoryIdentity = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(/^[!-~]+$/u);
const memoryTimestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
const memoryLocator = z
  .string()
  .min(1)
  .max(MAX_MEMORY_LOCATOR_BYTES)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: memory locators reject NUL exactly as the domain codec does.
  .regex(/^[^\x00]+$/u);

const memoryScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user") }).strict(),
  z.object({ kind: z.literal("workspace"), workspaceId: memoryIdentity }).strict(),
  z
    .object({
      kind: z.enum(["repository", "branch", "worktree", "agent"]),
      workspaceId: memoryIdentity,
      locator: memoryLocator,
    })
    .strict(),
  z.object({ kind: z.enum(["provider", "collection"]), locator: memoryLocator }).strict(),
]);

const memoryProvenanceEntry = z
  .object({
    origin: z.enum(MEMORY_ORIGINS),
    locator: z
      .string()
      .min(1)
      .max(MAX_MEMORY_PROVENANCE_LOCATOR_BYTES)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: provenance locators reject NUL exactly as the domain codec does.
      .regex(/^[^\x00]+$/u),
    eventId: memoryIdentity.optional(),
  })
  .strict();

const memoryRecord = z
  .object({
    memoryId: memoryIdentity,
    schemaVersion: z.literal(MEMORY_RECORD_VERSION).optional(),
    generation: z.int().min(1).optional(),
    scope: memoryScope,
    kind: z.enum(MEMORY_KINDS),
    subject: z.string().min(1).max(MAX_MEMORY_SUBJECT_BYTES),
    content: z.string().min(1).max(MAX_MEMORY_CONTENT_BYTES),
    provenance: z.array(memoryProvenanceEntry).min(1).max(MAX_MEMORY_PROVENANCE),
    confidence: z.int().min(0).max(100),
    sensitivity: z.enum(MEMORY_SENSITIVITIES).optional(),
    createdAt: memoryTimestamp,
    reviewAfter: memoryTimestamp.nullish(),
    expiresAt: memoryTimestamp.nullish(),
    supersedes: z.array(memoryIdentity).max(MAX_MEMORY_SUPERSEDES).optional(),
    cancelled: z.boolean().optional(),
  })
  .strict();

const memoryAdmitInput = z
  .object({
    record: memoryRecord,
    context: z
      .object({
        sourceKind: z.enum(MEMORY_SOURCE_KINDS),
        sourceTrust: z.enum(EVIDENCE_TRUSTS),
        workspaceId: memoryIdentity,
        priors: z.array(memoryRecord).optional(),
        cancelled: z.boolean().optional(),
      })
      .strict(),
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

const memoryRecallInput = z
  .object({
    workspaceId: memoryIdentity,
    query: z
      .string()
      .max(MAX_MEMORY_RECALL_QUERY_BYTES)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: recall queries reject NUL exactly as the domain parser does.
      .regex(/^[^\x00]*$/u)
      .nullish(),
    destination: z.enum(MEMORY_SENSITIVITIES).optional(),
    now: z.string().min(1).optional(),
    maxResults: z.int().min(1).max(HARD_MEMORY_RECALL_MAX).optional(),
    pinnedIds: z.array(memoryIdentity).optional(),
    cancelled: z.boolean().optional(),
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

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
  readonly records?: MemoryRecords;
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
  const store = ports.records ?? createMemoryRecords();
  const admission = ports.admission ?? createMemoryAdmission(store);
  const recall = ports.recall ?? createMemoryRecall(store);

  const entries = [
    mustEntry(
      createToolRegistryEntry(
        document("memory_admit", "Admit memory", "Admit a memory record under policy", "mutation"),
        { inputSchema: memoryAdmitInput, outputSchema: openObject },
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
        { inputSchema: memoryRecallInput, outputSchema: openObject },
      ),
    ),
  ];
  const registryResult = createToolRegistry(ports.generation, entries);
  if (!registryResult.ok) {
    throw new Error(`product memory registry failed: ${registryResult.error.code}`);
  }
  const registry = registryResult.value;

  const runner: ToolRunnerPort = {
    hasBinding: (id) => registry.resolveByCapabilityId(id) !== null,
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
