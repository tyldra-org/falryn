import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  resolveWorkflowValue,
  WORKFLOW_LIMITS,
  type WorkflowNode,
  workflowPath,
} from "../../domain/orchestration/workflow-definition.ts";
import type {
  WorkflowNodeRecord,
  WorkflowRecord,
} from "../../domain/orchestration/workflow-state.ts";

export const nodeSettled = (node: WorkflowNodeRecord) =>
  !["pending", "running", "waiting"].includes(node.state);
export function pendingWorkflowNode(
  template: string,
  itemKey: string | null = null,
  item: WorkflowNodeRecord["item"] = null,
): WorkflowNodeRecord {
  return {
    key: itemKey === null ? template : `map-${canonicalDigest([template, itemKey]).slice(7)}`,
    template,
    itemKey,
    item,
    state: "pending",
    attempts: 0,
    invocation: null,
    fingerprint: null,
    result: null,
    effect: "none",
    reason: null,
    question: null,
    observed: [],
    usage: {},
    startedAt: null,
    settledAt: null,
  };
}
export function workflowDependencies(
  record: WorkflowRecord,
  node: WorkflowNodeRecord,
): readonly WorkflowNodeRecord[] | null {
  const template = record.definition.nodes.find((candidate) => candidate.key === node.template);
  if (!template) return null;
  const dependencies: WorkflowNodeRecord[] = [];
  for (const key of template.dependencies) {
    if (!record.expanded.includes(key)) return null;
    const producer = record.definition.nodes.find((candidate) => candidate.key === key);
    const sameMap =
      node.itemKey !== null &&
      template.forEach &&
      producer?.forEach &&
      canonicalDigest(template.forEach) === canonicalDigest(producer.forEach);
    const nodes = record.nodes.filter(
      (candidate) => candidate.template === key && (!sameMap || candidate.itemKey === node.itemKey),
    );
    if (sameMap && nodes.length !== 1) return null;
    dependencies.push(...nodes);
  }
  return dependencies;
}
export function workflowInputs(
  template: WorkflowNode,
  record: WorkflowRecord,
  results: ReadonlyMap<string, unknown>,
  item: unknown,
) {
  return Object.fromEntries(
    Object.entries(template.input).map(([key, value]) => [
      key,
      resolveWorkflowValue(value, record.arguments, results, item),
    ]),
  );
}
export function expandWorkflow(
  record: WorkflowRecord,
  results: ReadonlyMap<string, unknown>,
): WorkflowRecord {
  const nodes = [...record.nodes];
  const expanded = [...record.expanded];
  for (const template of record.definition.nodes) {
    if (expanded.includes(template.key)) continue;
    if (!template.forEach) {
      nodes.push(pendingWorkflowNode(template.key));
      expanded.push(template.key);
      continue;
    }
    const source = template.forEach.source;
    if (source.from === "node" && !results.has(source.node)) continue;
    const items = resolveWorkflowValue(source, record.arguments, results);
    if (!Array.isArray(items) || items.length > template.forEach.maxItems)
      throw new Error("workflow-map-limit");
    const keys = new Set<string>();
    for (const item of items) {
      const key = workflowPath(item, template.forEach.key);
      if (
        (typeof key !== "string" && typeof key !== "number") ||
        String(key).length > 128 ||
        keys.has(String(key))
      )
        throw new Error("workflow-map-identity");
      keys.add(String(key));
      nodes.push(pendingWorkflowNode(template.key, String(key), item));
    }
    expanded.push(template.key);
  }
  if (nodes.length > WORKFLOW_LIMITS.nodes) throw new Error("workflow-expanded-node-limit");
  return { ...record, nodes, expanded };
}
