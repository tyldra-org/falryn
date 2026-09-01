/** Product adapter from registry/tool metadata to the pure opportunity planner. */

import { createHash } from "node:crypto";
import { z } from "zod";

import {
  type CapabilityFamily,
  type CapabilityHealthSnapshot,
  type CapabilityId,
  type CapabilityRegistry,
  type EffectiveExecutionPolicy,
  type ModelCapabilityBrief,
  planCapabilityOpportunities,
  type ToolRegistry,
} from "../domain/index.ts";
import type { WorkIntent } from "../providers/index.ts";
import { isClosedProductToolSchema, measureProductToolSchema } from "./product-tool-schema.ts";

const RAW_PROTOCOL_ESCAPES = new Set(["run_process", "run_shell"]);

export type ProductOpportunityPlanOptions = {
  readonly task?: string;
  readonly intent?: WorkIntent;
  readonly preferredCapabilityIds?: readonly CapabilityId[];
  readonly selectionLimit?: number;
  readonly schemaTokenBudget?: number;
};

export function productOpportunityIntentFamilies(
  intent: WorkIntent | undefined,
): readonly CapabilityFamily[] {
  switch (intent) {
    case "coding":
      return ["search", "read", "edit", "run"];
    case "read":
    case "planning":
    case "independentCritique":
      return ["search", "read"];
    case "toolRouting":
    case "compression":
      return ["capability"];
    case "fastEdit":
      return ["read", "edit"];
    case "deepReview":
      return ["search", "read", "run"];
    case "verification":
      return ["read", "run"];
    case "visualUnderstanding":
      return ["read", "browser", "computer"];
    case "memory":
      return ["read", "capability"];
    case undefined:
      return [];
  }
}

function schemaFacts(
  capabilityId: CapabilityId,
  tools: ToolRegistry,
): { readonly eligible: boolean; readonly tokens: number } {
  const tool = tools.resolveByCapabilityId(capabilityId);
  if (tool === null) return { eligible: true, tokens: 0 };
  const schema = z.toJSONSchema(tool.manifest.inputSchema) as Readonly<Record<string, unknown>>;
  return {
    eligible: isClosedProductToolSchema(schema) || RAW_PROTOCOL_ESCAPES.has(tool.manifest.name),
    tokens: measureProductToolSchema(schema).tokensEstimated,
  };
}

export function createProductOpportunityPlan(
  registry: CapabilityRegistry,
  tools: ToolRegistry,
  health: CapabilityHealthSnapshot,
  policy: EffectiveExecutionPolicy,
  options: ProductOpportunityPlanOptions = {},
): ModelCapabilityBrief {
  if (registry.generation !== tools.generation || registry.generation !== health.generation) {
    throw new Error("opportunity planner generations do not match");
  }
  const task = options.task ?? "";
  const taskFingerprint = createHash("sha256").update(task).digest("hex").slice(0, 24);
  return planCapabilityOpportunities({
    task,
    taskFingerprint,
    policy,
    health,
    candidates: registry.entries.map((entry, order) => {
      const schema = schemaFacts(entry.capabilityId, tools);
      return {
        capabilityId: entry.capabilityId,
        name: entry.name,
        title: entry.title,
        summary: entry.summary,
        kind: entry.kind,
        family: entry.family,
        source: entry.source,
        effect: entry.effect,
        costClass: entry.routing.costClass,
        latencyClass: entry.routing.latencyClass,
        schemaTokensEstimated: schema.tokens,
        modelSchemaEligible: schema.eligible,
        order,
      };
    }),
    intentFamilies: productOpportunityIntentFamilies(options.intent),
    ...(options.preferredCapabilityIds === undefined
      ? {}
      : { preferredCapabilityIds: options.preferredCapabilityIds }),
    ...(options.selectionLimit === undefined ? {} : { selectionLimit: options.selectionLimit }),
    ...(options.schemaTokenBudget === undefined
      ? {}
      : { schemaTokenBudget: options.schemaTokenBudget }),
  });
}
