/** Serializable workflow data. A validated definition remains inert until host admission. */
import { z } from "zod";
import { canonicalDigest, canonicalJson, freezeMetadata } from "../extensions/canonical.ts";
import { identityText } from "../extensions/identity.ts";
import { definitionValueSchema, validateDefinitionValue } from "./definition-values.ts";
import { findDependencyCycle } from "./dependency-graph.ts";
import { resourceAmountsSchema } from "./resource-admission.ts";
import { EFFECT_CLASSES } from "./work.ts";
import { taskListSelectionSchema } from "./workflow-task-list.ts";

export const WORKFLOW_LIMITS = Object.freeze({
  nodes: 256,
  edges: 1024,
  definitionBytes: 1_048_576,
  valueBytes: 65_536,
  checkpointBytes: 4_194_304,
  retries: 2,
  concurrency: 4,
  page: 50,
});
export const workflowKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const pathSchema = z.array(z.union([z.string().max(128), z.int().nonnegative()])).max(16);
export const workflowValueSchema = z.discriminatedUnion("from", [
  z.strictObject({ from: z.literal("literal"), value: z.json() }),
  z.strictObject({ from: z.literal("arguments"), path: pathSchema.default([]) }),
  z.strictObject({
    from: z.literal("node"),
    node: workflowKeySchema,
    path: pathSchema.default([]),
  }),
  z.strictObject({ from: z.literal("item"), path: pathSchema.default([]) }),
]);
export type WorkflowValue = z.infer<typeof workflowValueSchema>;
const common = {
  key: workflowKeySchema,
  dependencies: z.array(workflowKeySchema).max(WORKFLOW_LIMITS.nodes).default([]),
  input: z.record(workflowKeySchema, workflowValueSchema).default({}),
  resultSchema: definitionValueSchema,
  resultPath: pathSchema.default([]),
  onFailure: z.enum(["stop", "continue"]).default("stop"),
  retries: z.int().min(0).max(WORKFLOW_LIMITS.retries).default(0),
  limits: resourceAmountsSchema.default({}),
  forEach: z
    .strictObject({
      source: workflowValueSchema,
      key: pathSchema.min(1),
      maxItems: z.int().min(1).max(WORKFLOW_LIMITS.nodes),
    })
    .optional(),
  when: z.strictObject({ value: workflowValueSchema, equals: z.json() }).optional(),
};
// The provider owner validates this optional routing value before registration/admission.
// Keeping it as data here avoids making the domain import provider configuration policy.
const model = z.record(z.string(), z.json()).optional();
export const workflowNodeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...common,
    kind: z.literal("action"),
    capability: identityText,
    effect: z.enum(EFFECT_CLASSES),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("agent"),
    agentId: identityText,
    capabilities: z.array(identityText).max(256),
    effects: z.array(z.enum(EFFECT_CLASSES)).max(4),
    model,
  }),
  z.strictObject({
    ...common,
    kind: z.literal("model"),
    instruction: z.string().min(1).max(16384),
    model,
  }),
  z.strictObject({
    ...common,
    kind: z.literal("question"),
    request: z.record(z.string(), z.json()),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("condition"),
    value: workflowValueSchema,
    equals: z.json(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal("join"),
    policy: z.enum(["all", "settled"]).default("all"),
  }),
]);
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;
export const workflowDefinitionSchema = z.strictObject({
  version: z.literal(1),
  id: identityText,
  label: z.string().min(1).max(256),
  description: z.string().max(2048).default(""),
  argumentsSchema: definitionValueSchema,
  nodes: z.array(workflowNodeSchema).min(1).max(WORKFLOW_LIMITS.nodes),
  outputs: z.record(workflowKeySchema, workflowValueSchema),
  model,
  limits: resourceAmountsSchema.default({}),
  concurrency: z.int().min(1).max(WORKFLOW_LIMITS.concurrency).default(4),
  taskList: taskListSelectionSchema.optional(),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowDiagnostic = { readonly path: string; readonly code: string };
export type DecodedWorkflow =
  | { readonly ok: true; readonly definition: WorkflowDefinition; readonly digest: string }
  | { readonly ok: false; readonly diagnostics: readonly WorkflowDiagnostic[] };

export function workflowReferences(node: WorkflowNode): readonly WorkflowValue[] {
  return [
    ...Object.values(node.input),
    ...(node.forEach ? [node.forEach.source] : []),
    ...(node.when ? [node.when.value] : []),
    ...(node.kind === "condition" ? [node.value] : []),
  ];
}

export function decodeWorkflowDefinition(raw: unknown): DecodedWorkflow {
  const diagnostics: WorkflowDiagnostic[] = [];
  const report = (path: string, code: string) => {
    if (diagnostics.length < 64) diagnostics.push({ path, code });
  };
  try {
    if (Buffer.byteLength(canonicalJson(raw)) > WORKFLOW_LIMITS.definitionBytes)
      return { ok: false, diagnostics: [{ path: "$", code: "definition-byte-limit" }] };
    const parsed = workflowDefinitionSchema.safeParse(raw);
    if (!parsed.success)
      return {
        ok: false,
        diagnostics: parsed.error.issues
          .slice(0, 64)
          .map((issue) => ({ path: issue.path.join("."), code: issue.code })),
      };
    const definition = parsed.data;
    const nodes = new Map<string, WorkflowNode>();
    for (const node of definition.nodes) {
      if (nodes.has(node.key)) report(node.key, "duplicate-node");
      nodes.set(node.key, node);
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(node.key) ||
        ["constructor", "prototype", "__proto__"].includes(node.key)
      )
        report(node.key, "invalid-stable-node-key");
      if (new Set(node.dependencies).size !== node.dependencies.length)
        report(node.key, "duplicate-dependency");
      if (node.retries > 0 && (node.kind !== "action" || node.effect !== "observation"))
        report(node.key, "retry-requires-observation");
      if (node.forEach?.source.from === "item") report(node.key, "recursive-expansion");
    }
    if (
      definition.nodes.reduce((count, node) => count + node.dependencies.length, 0) >
      WORKFLOW_LIMITS.edges
    )
      report("nodes", "edge-limit");
    for (const node of definition.nodes) {
      for (const dependency of node.dependencies)
        if (!nodes.has(dependency)) report(node.key, "missing-dependency");
      for (const reference of workflowReferences(node)) {
        if (reference.from === "node" && !node.dependencies.includes(reference.node))
          report(node.key, "undeclared-result-dependency");
        if (reference.from === "item" && !node.forEach) report(node.key, "item-outside-map");
      }
    }
    for (const [key, reference] of Object.entries(definition.outputs)) {
      if (reference.from === "node" && !nodes.has(reference.node))
        report(`outputs.${key}`, "missing-node");
      if (reference.from === "item") report(`outputs.${key}`, "item-outside-map");
    }
    if (findDependencyCycle(nodes.keys(), (key) => nodes.get(key)?.dependencies ?? []))
      report("nodes", "dependency-cycle");
    return diagnostics.length > 0
      ? { ok: false, diagnostics }
      : { ok: true, definition: freezeMetadata(definition), digest: canonicalDigest(definition) };
  } catch {
    return { ok: false, diagnostics: [{ path: "$", code: "invalid-definition" }] };
  }
}

/** Exact own-property traversal, with no expression evaluator or prototype lookup. */
export function workflowPath(value: unknown, path: readonly (string | number)[]): unknown {
  for (const segment of path) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, segment) ||
      ["__proto__", "prototype", "constructor"].includes(String(segment))
    )
      throw new Error("workflow-value-unavailable");
    value = Reflect.get(value, segment);
  }
  return value;
}

export function resolveWorkflowValue(
  reference: WorkflowValue,
  argumentsValue: unknown,
  results: ReadonlyMap<string, unknown>,
  item?: unknown,
): unknown {
  if (reference.from === "literal") return reference.value;
  const source =
    reference.from === "arguments"
      ? argumentsValue
      : reference.from === "item"
        ? item
        : results.get(reference.node);
  if (source === undefined) throw new Error("workflow-result-unavailable");
  return workflowPath(source, reference.path);
}

export function validWorkflowArguments(definition: WorkflowDefinition, value: unknown): boolean {
  return validateDefinitionValue(definition.argumentsSchema, value, WORKFLOW_LIMITS.valueBytes);
}
