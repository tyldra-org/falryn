/** Product Read orchestration for artifact-backed Loom recovery (#814). */

import { createHash } from "node:crypto";
import { z } from "zod";

import {
  admitEvidenceCandidate,
  type ConfigurationGeneration,
  type EvidenceCandidate,
  type LoomProjectionRequest,
  type WorkspaceFileRead,
  type WorkspaceIndexPort,
  type WorkspaceReadLimits,
  type WorkspaceReadManyItem,
  type WorkspaceReadRange,
  type WorkspaceReadTarget,
} from "../domain/index.ts";
import type { LoomPort } from "./loom.ts";
import { loomProjectionToEvidence } from "./loom.ts";
import { composeProductLoomContext } from "./product-loom.ts";
import { projectIndexedRead } from "./product-read-outline.ts";
import { containsRedactableSecret, redactText } from "./redaction.ts";
import type { WorkspaceReader } from "./workspace-read.ts";

export const PRODUCT_READ_OWNER = "#814";
export const MAX_PRODUCT_READ_CANDIDATES = 32;
export const DEFAULT_PRODUCT_READ_LOOM_BYTES = 4 * 1_024;
export const PRODUCT_READ_OUTPUT_MODES = ["loom", "raw"] as const;

export type ProductReadOutputMode = (typeof PRODUCT_READ_OUTPUT_MODES)[number];

const encoder = new TextEncoder();

const lineRange = z
  .object({
    kind: z.literal("line"),
    range: z.object({ start: z.int().min(1), end: z.int().min(1) }).strict(),
  })
  .strict();

const byteRange = z
  .object({
    kind: z.literal("byte"),
    range: z.object({ start: z.int().min(0), end: z.int().min(0) }).strict(),
  })
  .strict();

const workspaceRange = z.discriminatedUnion("kind", [lineRange, byteRange]);
const outputMode = z.enum(PRODUCT_READ_OUTPUT_MODES).default("loom");

const readLimits = z
  .object({
    maxFileBytes: z.int().positive().optional(),
    maxAggregateBytes: z.int().positive().optional(),
    maxConcurrency: z.int().positive().optional(),
    maxExpansionBytes: z.int().positive().optional(),
    maxExpansionChunkBytes: z.int().positive().optional(),
    maxStaleRetries: z.int().min(0).optional(),
  })
  .strict();

const pathRead = z
  .object({
    path: z.string().min(1),
    range: workspaceRange.optional(),
    limits: readLimits.optional(),
    outputMode,
  })
  .strict();

const manyRead = z
  .object({
    targets: z
      .array(z.object({ path: z.string().min(1), range: workspaceRange.optional() }).strict())
      .min(1),
    limits: readLimits.optional(),
    outputMode,
  })
  .strict();

const recoveryHandle = z
  .object({
    manifestId: z.string().min(1),
    artifactId: z.string().min(1),
    owner: z.literal("#719").optional(),
    digest: z.string().min(1).optional(),
    byteLength: z.int().min(0).optional(),
    via: z.literal("loom-manifest").optional(),
    claimsExactSource: z.boolean().optional(),
    origin: z.string().min(1).optional().nullable(),
    projections: z
      .tuple([
        z.literal("range"),
        z.literal("head-tail"),
        z.literal("search-hits"),
        z.literal("exact"),
      ])
      .readonly()
      .optional(),
    lineage: z
      .object({
        invocationId: z.string().min(1),
        captureId: z.string().min(1),
        stream: z.enum(["stdout", "stderr"]),
        encoding: z.enum(["utf-8", "binary"]),
        availability: z.literal("available"),
      })
      .strict()
      .optional(),
  })
  .strict();

const exactProjection = z
  .object({ kind: z.literal("exact"), maxBytes: z.int().positive().optional() })
  .strict();
const rangeProjection = z
  .object({
    kind: z.literal("range"),
    offset: z.int().min(0).optional(),
    length: z.int().min(0).optional(),
    maxBytes: z.int().positive().optional(),
  })
  .strict();
const headTailProjection = z
  .object({
    kind: z.literal("head-tail"),
    headBytes: z.int().min(0).optional(),
    tailBytes: z.int().min(0).optional(),
    maxBytes: z.int().positive().optional(),
  })
  .strict();
const searchHitsProjection = z
  .object({
    kind: z.literal("search-hits"),
    query: z.string().min(1),
    maxHits: z.int().positive().optional(),
    contextBytes: z.int().min(0).optional(),
    maxBytes: z.int().positive().optional(),
  })
  .strict();

const recoveryRead = z
  .object({
    recovery: recoveryHandle,
    projection: z.discriminatedUnion("kind", [
      exactProjection,
      rangeProjection,
      headTailProjection,
      searchHitsProjection,
    ]),
  })
  .strict();

const productReadSchema = z.union([pathRead, manyRead, recoveryRead]);

export const productReadInputSchema = productReadSchema as z.ZodType<
  Readonly<Record<string, unknown>>
>;

type ParsedReadInput = z.infer<typeof productReadSchema>;

export type ProductReadResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: string };

export type ProductReadCoordinator = {
  execute(
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<ProductReadResult>;
  candidates(): readonly EvidenceCandidate[];
  invalidate(): number;
};

export type ProductReadCoordinatorOptions = {
  readonly reader: WorkspaceReader;
  readonly loom: LoomPort | null;
  readonly workspaceRoot: Parameters<WorkspaceReader["read"]>[0];
  readonly workspaceId: string | null;
  readonly sessionId: string | null;
  readonly generation: ConfigurationGeneration;
  readonly index?: WorkspaceIndexPort | null;
};

function stableId(prefix: string, values: readonly string[]): string {
  const hash = createHash("sha256");
  for (const value of values) {
    hash.update(value);
    hash.update("\0");
  }
  return `${prefix}-${hash.digest("hex").slice(0, 32)}`;
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function redactProjectionText(value: string): string {
  return value
    .split("\n")
    .map((line) =>
      containsRedactableSecret(line) ? redactText(line, Number.MAX_SAFE_INTEGER) : line,
    )
    .join("\n");
}

function errorCode(error: {
  readonly code?: string;
  readonly kind?: string;
  readonly field?: unknown;
}): string {
  const code = typeof error.code === "string" ? error.code : error.kind;
  const field = typeof error.field === "string" ? `:${error.field}` : "";
  return `${code ?? "failed"}${field}`;
}

function defaultProjection(artifactId: string): LoomProjectionRequest {
  const half = DEFAULT_PRODUCT_READ_LOOM_BYTES / 2;
  return {
    kind: "head-tail",
    member: artifactId,
    headBytes: half,
    tailBytes: half,
    maxBytes: DEFAULT_PRODUCT_READ_LOOM_BYTES,
  };
}

function requestedProjection(
  artifactId: string,
  projection: Extract<ParsedReadInput, { readonly recovery: unknown }>["projection"],
): LoomProjectionRequest {
  return { ...projection, member: artifactId } as LoomProjectionRequest;
}

function compactReadMetadata(read: WorkspaceFileRead): Readonly<Record<string, unknown>> {
  return {
    kind: read.kind,
    byteLength: read.byteLength,
    requestedTarget: read.requestedTarget,
    resolvedTarget: read.resolvedTarget,
    revision: read.revision,
    digest: read.digest,
    completeness: read.completeness,
    fidelity: read.fidelity,
    encoding: read.encoding,
    newline: read.newline,
    range: read.range,
    actualRange: read.actualRange,
    diagnostics: read.diagnostics,
  };
}

export function createProductReadCoordinator(
  options: ProductReadCoordinatorOptions,
): ProductReadCoordinator {
  const evidence = new Map<string, EvidenceCandidate>();
  const manifestOrigins = new Map<string, string>();
  const productLoom =
    options.loom === null ? null : composeProductLoomContext({ loom: options.loom });

  const publish = (candidate: EvidenceCandidate): void => {
    evidence.delete(candidate.id);
    evidence.set(candidate.id, candidate);
    while (evidence.size > MAX_PRODUCT_READ_CANDIDATES) {
      const oldest = evidence.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      evidence.delete(oldest);
    }
  };

  const projectRead = async (
    read: WorkspaceFileRead,
    mode: ProductReadOutputMode,
    signal: AbortSignal,
  ): Promise<ProductReadResult> => {
    if (mode === "raw") {
      return { ok: true, value: read };
    }
    if (read.expansion === null || options.loom === null || productLoom === null) {
      return { ok: true, value: read };
    }
    if (options.workspaceId === null || options.sessionId === null) {
      return { ok: true, value: read };
    }
    const manifestId = stableId("loom-read", [
      options.workspaceId,
      options.sessionId,
      read.expansion.artifactId,
      read.expansion.digest,
      String(options.generation),
    ]);
    const adopted = await options.loom.adopt(
      {
        id: manifestId,
        workspaceId: options.workspaceId,
        sessionId: options.sessionId,
        generation: String(options.generation),
        members: [{ artifactId: read.expansion.artifactId, summary: read.bound.logical }],
      },
      signal,
    );
    if (!adopted.ok) {
      return signal.aborted ? { ok: false, error: "cancelled" } : { ok: true, value: read };
    }
    manifestOrigins.set(manifestId, read.bound.logical);
    while (manifestOrigins.size > MAX_PRODUCT_READ_CANDIDATES) {
      const oldest = manifestOrigins.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      manifestOrigins.delete(oldest);
    }
    if (options.index !== undefined && options.index !== null) {
      const snapshot = await options.index.snapshot(options.workspaceRoot, signal);
      if (signal.aborted) {
        return { ok: false, error: "cancelled" };
      }
      if (snapshot.ok) {
        const indexed = projectIndexedRead(read, snapshot.value, DEFAULT_PRODUCT_READ_LOOM_BYTES);
        if (indexed !== null) {
          const redacted = containsRedactableSecret(indexed.text);
          const text = redacted ? redactProjectionText(indexed.text) : indexed.text;
          const evidenceId = stableId("evidence-read", [
            manifestId,
            indexed.generation,
            indexed.kind,
          ]);
          const admitted = admitEvidenceCandidate({
            id: evidenceId,
            sourceKind: "file",
            origin: read.bound.logical,
            workspaceId: options.workspaceId,
            payload: { kind: "inline", text },
            estimatedTokens: Math.max(1, Math.ceil(utf8Bytes(text) / 4)),
            freshness: "indexed",
            sensitivity: "user-content",
            trust: "adapter-declared",
            fidelity: "deterministic-transform",
            retrievalCost: 1,
            expansion: read.expansion,
            lineage: [
              `index:${indexed.schema}`,
              indexed.generation,
              indexed.kind,
              "loom-artifact",
              ...(redacted ? ["redacted"] : []),
            ],
          });
          if (admitted.ok) {
            publish(admitted.value);
            return {
              ok: true,
              value: productLoom.attachArtifactRecovery(
                {
                  ...compactReadMetadata(read),
                  content: text,
                  projection: {
                    kind: indexed.kind,
                    fidelity: "deterministic-transform",
                    freshness: "indexed",
                    sourceBytes: indexed.sourceBytes,
                    outputBytes: utf8Bytes(text),
                    complete: false,
                    selectedLines: indexed.selectedLines,
                    omissions: indexed.omissions,
                    indexGeneration: indexed.generation,
                    indexSchema: indexed.schema,
                  },
                },
                manifestId,
                read.expansion,
                read.bound.logical,
              ),
            };
          }
        }
      }
    }
    const evidenceId = stableId("evidence-read", [manifestId, "head-tail"]);
    const retrieved = await options.loom.retrieve(
      {
        id: evidenceId,
        manifestId,
        expectedWorkspaceId: options.workspaceId,
        expectedSessionId: options.sessionId,
        generation: String(options.generation),
        projection: defaultProjection(read.expansion.artifactId),
      },
      signal,
    );
    if (!retrieved.ok) {
      return signal.aborted ? { ok: false, error: "cancelled" } : { ok: true, value: read };
    }
    const admitted = loomProjectionToEvidence({
      projection: retrieved.value,
      workspaceId: options.workspaceId,
      sourceKind: "file",
      origin: read.bound.logical,
    });
    if (!admitted.ok) {
      return { ok: true, value: read };
    }
    publish(admitted.value);
    return {
      ok: true,
      value: productLoom.attachRecovery(
        {
          ...compactReadMetadata(read),
          content: retrieved.value.text,
          projection: {
            kind: retrieved.value.projection,
            fidelity: retrieved.value.fidelity,
            freshness: retrieved.value.freshness,
            offset: retrieved.value.offset,
            byteLength: retrieved.value.byteLength,
            sourceBytes: retrieved.value.sourceBytes,
            complete: retrieved.value.complete,
            omissions: retrieved.value.omissions,
          },
        },
        manifestId,
        retrieved.value,
        read.bound.logical,
      ),
    };
  };

  const projectMany = async (
    items: readonly WorkspaceReadManyItem[],
    mode: ProductReadOutputMode,
    signal: AbortSignal,
  ): Promise<ProductReadResult> => {
    const projected: unknown[] = [];
    for (const item of items) {
      if (signal.aborted) {
        return { ok: false, error: "cancelled" };
      }
      if (item.status !== "read") {
        projected.push(item);
        continue;
      }
      const next = await projectRead(item.value, mode, signal);
      if (!next.ok) {
        projected.push({ index: item.index, status: "failed", error: next.error });
        continue;
      }
      projected.push({ index: item.index, status: "read", value: next.value });
    }
    return { ok: true, value: projected };
  };

  const recover = async (
    input: Extract<ParsedReadInput, { readonly recovery: unknown }>,
    signal: AbortSignal,
  ): Promise<ProductReadResult> => {
    if (options.loom === null || productLoom === null) {
      return { ok: false, error: "loom-unavailable" };
    }
    if (options.workspaceId === null || options.sessionId === null) {
      return { ok: false, error: "loom-scope-unavailable" };
    }
    const projection = requestedProjection(input.recovery.artifactId, input.projection);
    const manifest = options.loom.get(input.recovery.manifestId);
    const persistedOrigin =
      manifest?.members.find((member) => member.artifactId === input.recovery.artifactId)
        ?.summary ?? null;
    const origin = manifestOrigins.get(input.recovery.manifestId) ?? persistedOrigin;
    if (
      origin !== null &&
      input.recovery.origin !== null &&
      input.recovery.origin !== undefined &&
      input.recovery.origin !== origin
    ) {
      return { ok: false, error: "loom-origin-mismatch" };
    }
    const evidenceId = stableId("evidence-recovery", [
      input.recovery.manifestId,
      input.recovery.artifactId,
      JSON.stringify(input.projection),
    ]);
    const retrieved = await options.loom.retrieve(
      {
        id: evidenceId,
        manifestId: input.recovery.manifestId,
        expectedWorkspaceId: options.workspaceId,
        expectedSessionId: options.sessionId,
        generation: String(options.generation),
        projection,
      },
      signal,
    );
    if (!retrieved.ok) {
      return { ok: false, error: `loom-retrieve:${errorCode(retrieved.error)}` };
    }
    const admitted = loomProjectionToEvidence({
      projection: retrieved.value,
      workspaceId: options.workspaceId,
      ...(origin === null ? {} : { sourceKind: "file" as const, origin }),
    });
    if (!admitted.ok) {
      return { ok: false, error: `loom-evidence:${errorCode(admitted.error)}` };
    }
    publish(admitted.value);
    return {
      ok: true,
      value: productLoom.attachRecovery(
        {
          content: retrieved.value.text,
          recoveryLineage: input.recovery.lineage ?? null,
          projection: {
            kind: retrieved.value.projection,
            fidelity: retrieved.value.fidelity,
            freshness: retrieved.value.freshness,
            offset: retrieved.value.offset,
            byteLength: retrieved.value.byteLength,
            sourceBytes: retrieved.value.sourceBytes,
            complete: retrieved.value.complete,
            omissions: retrieved.value.omissions,
            hits: retrieved.value.hits,
          },
        },
        input.recovery.manifestId,
        retrieved.value,
        origin ?? undefined,
      ),
    };
  };

  return {
    async execute(input, signal) {
      if (signal.aborted) {
        return { ok: false, error: "cancelled" };
      }
      const parsed = productReadSchema.safeParse(input);
      if (!parsed.success) {
        return { ok: false, error: "malformed-input" };
      }
      if ("recovery" in parsed.data) {
        return recover(parsed.data, signal);
      }
      if ("targets" in parsed.data) {
        const targets = parsed.data.targets as readonly WorkspaceReadTarget[];
        const result = await options.reader.readMany(
          options.workspaceRoot,
          targets,
          parsed.data.limits as Partial<WorkspaceReadLimits> | undefined,
          signal,
        );
        if (!result.ok) {
          return { ok: false, error: errorCode(result.error) };
        }
        const items = await projectMany(result.value.items, parsed.data.outputMode, signal);
        return items.ok
          ? {
              ok: true,
              value: {
                items: items.value,
                aggregateBytes: result.value.aggregateBytes,
                completeness: result.value.completeness,
                limitReached: result.value.limitReached,
              },
            }
          : items;
      }
      const result = await options.reader.read(
        options.workspaceRoot,
        parsed.data.path,
        parsed.data.range as WorkspaceReadRange | undefined,
        parsed.data.limits as Partial<WorkspaceReadLimits> | undefined,
        signal,
      );
      return result.ok
        ? projectRead(result.value, parsed.data.outputMode, signal)
        : { ok: false, error: errorCode(result.error) };
    },
    candidates() {
      return [...evidence.values()];
    },
    invalidate() {
      const removed = evidence.size;
      evidence.clear();
      manifestOrigins.clear();
      options.loom?.invalidate({ all: true });
      return removed;
    },
  };
}
