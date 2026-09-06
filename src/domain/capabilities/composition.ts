/** Bounded data-only capability graphs. Native owners retain all execution authority. */
import { z } from "zod";
import { EFFECT_CLASSES } from "../orchestration/work.ts";

export const MAX_COMPOSITION_NODES = 64;
export const MAX_COMPOSITION_EDGES = 128;
export const MAX_COMPOSITION_BYTES = 256 * 1024;
export const MAX_TRANSFER_BYTES = 64 * 1024;
export const MAX_COMPOSITION_DURATION_MS = 30 * 60 * 1000;
const identifier = z.string().min(1).max(128);
const key = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !["__proto__", "prototype", "constructor"].includes(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);

export const compositionGraphSchema = z.strictObject({
  version: z.literal(1),
  id: identifier,
  generation: z.int().nonnegative(),
  maxConcurrent: z.int().min(1).max(16).default(4),
  timeoutMs: z.int().min(1).max(MAX_COMPOSITION_DURATION_MS).default(MAX_COMPOSITION_DURATION_MS),
  nodes: z
    .array(
      z.strictObject({
        id: identifier,
        capabilityId: identifier,
        capabilityVersion: z.int().min(1),
        effect: z.enum(EFFECT_CLASSES),
        input: z.record(z.string(), z.unknown()),
        dependencies: z.array(identifier).max(MAX_COMPOSITION_EDGES).default([]),
        transfers: z
          .array(
            z.strictObject({
              from: identifier,
              path: z.array(key).max(16),
              target: key,
            }),
          )
          .max(MAX_COMPOSITION_EDGES)
          .default([]),
      }),
    )
    .min(1)
    .max(MAX_COMPOSITION_NODES),
});
export type CompositionGraph = z.output<typeof compositionGraphSchema>;
export type CompositionNode = CompositionGraph["nodes"][number];

/** Durable receipts contain digests and topology, never input or result bytes. */
export const compositionProvenanceSchema = z.strictObject({
  version: z.literal(1),
  graphId: digest,
  graphDigest: digest,
  nodeId: digest,
  bindingDigest: digest,
  dependencies: z.array(digest).max(MAX_COMPOSITION_NODES),
  topology: z
    .array(
      z.strictObject({
        nodeId: digest,
        dependencies: z.array(digest).max(MAX_COMPOSITION_NODES),
        status: z
          .enum([
            "completed",
            "failed",
            "cancelled",
            "timed-out",
            "uncertain",
            "denied",
            "unavailable",
            "malformed",
            "partial",
          ])
          .optional(),
      }),
    )
    .max(MAX_COMPOSITION_NODES),
});
export type CompositionProvenance = z.output<typeof compositionProvenanceSchema>;

/** Reject cycles, non-JSON values and excessive nesting before serialization or schema recursion. */
export function boundedJson(value: unknown, maximum: number): string | null {
  let units = 0;
  const ancestors = new Set<object>();
  function visit(item: unknown, depth: number): boolean {
    if (depth > 32 || ++units > maximum) return false;
    if (item === null || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item === "string") {
      units += item.length;
      return units <= maximum;
    }
    if (typeof item !== "object" || ancestors.has(item)) return false;
    if (Object.getOwnPropertySymbols(item).length !== 0) return false;
    if (Array.isArray(item) && item.length > maximum) return false;
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return false;
    ancestors.add(item);
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (Array.isArray(item) && name === "length") continue;
      if (
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        ["__proto__", "prototype", "constructor"].includes(name)
      )
        return false;
      units += name.length;
      if (!visit(descriptor.value, depth + 1)) return false;
    }
    ancestors.delete(item);
    return true;
  }
  try {
    if (!visit(value, 0)) return null;
    const encoded = JSON.stringify(value);
    return encoded !== undefined && new TextEncoder().encode(encoded).length <= maximum
      ? encoded
      : null;
  } catch {
    return null;
  }
}

export function parseCompositionGraph(
  value: unknown,
):
  | { readonly ok: true; readonly graph: CompositionGraph }
  | { readonly ok: false; readonly reason: string } {
  const encoded = boundedJson(value, MAX_COMPOSITION_BYTES);
  if (encoded === null) return { ok: false, reason: "composition-input-bound" };
  const parsed = compositionGraphSchema.safeParse(JSON.parse(encoded));
  if (!parsed.success) return { ok: false, reason: "malformed-composition" };
  const graph = parsed.data;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  if (nodes.size !== graph.nodes.length) return { ok: false, reason: "duplicate-composition-node" };
  let edges = 0;
  for (const node of graph.nodes) {
    edges += node.dependencies.length + node.transfers.length;
    if (
      edges > MAX_COMPOSITION_EDGES ||
      new Set(node.dependencies).size !== node.dependencies.length
    )
      return { ok: false, reason: "composition-edge-bound" };
    if (new Set(node.transfers.map((transfer) => transfer.target)).size !== node.transfers.length)
      return { ok: false, reason: "duplicate-transfer-target" };
    if (
      node.dependencies.some((id) => !nodes.has(id)) ||
      node.transfers.some((transfer) => !node.dependencies.includes(transfer.from))
    )
      return { ok: false, reason: "unknown-composition-dependency" };
  }
  const settled = new Set<string>();
  while (settled.size < nodes.size) {
    const ready = graph.nodes.filter(
      (node) => !settled.has(node.id) && node.dependencies.every((id) => settled.has(id)),
    );
    if (ready.length === 0) return { ok: false, reason: "composition-cycle" };
    for (const node of ready) settled.add(node.id);
  }
  return { ok: true, graph };
}
