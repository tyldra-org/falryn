/** Inert agent definitions. Registration never authorizes execution. */
import { z } from "zod";
import {
  canonicalDigest,
  canonicalJson,
  freezeMetadata,
} from "../../domain/extensions/canonical.ts";
import {
  contributionIdentityV1Schema,
  digestSchema,
  identityText,
} from "../../domain/extensions/identity.ts";
import { processTaskArtifactSchema } from "../../domain/orchestration/process-task.ts";
import { resourceAmountsSchema } from "../../domain/orchestration/resource-admission.ts";
import { EFFECT_CLASSES } from "../../domain/orchestration/work.ts";
import { roleRouteBaseSchema } from "../../providers/configuration/policy-schema.ts";

export const MAX_AGENT_CONTEXT_BYTES = 64 * 1024;
export const MAX_AGENT_RESULT_BYTES = 64 * 1024;
export const MAX_AGENT_STEERING_BYTES = 8 * 1024;

/** The bounded JSON Schema subset accepted by definitions; executable expressions are excluded. */
const jsonSchema = z.record(z.string(), z.json()).superRefine((value, context) => {
  let nodes = 0;
  const visit = (schema: unknown, depth: number): boolean => {
    if (
      ++nodes > 256 ||
      depth > 16 ||
      schema === null ||
      typeof schema !== "object" ||
      Array.isArray(schema)
    )
      return false;
    const item = schema as Record<string, unknown>;
    const keys = new Set([
      "type",
      "properties",
      "required",
      "additionalProperties",
      "items",
      "enum",
      "description",
      "minLength",
      "maxLength",
      "minimum",
      "maximum",
      "minItems",
      "maxItems",
    ]);
    if (Object.keys(item).some((key) => !keys.has(key))) return false;
    if (
      !["object", "array", "string", "number", "integer", "boolean", "null"].includes(
        String(item.type),
      )
    )
      return false;
    if (item.type === "object") {
      if (
        item.additionalProperties !== false ||
        item.properties === null ||
        typeof item.properties !== "object" ||
        Array.isArray(item.properties)
      )
        return false;
      if (!Object.values(item.properties).every((child) => visit(child, depth + 1))) return false;
    }
    return item.type !== "array" || visit(item.items, depth + 1);
  };
  try {
    if (Buffer.byteLength(canonicalJson(value)) > MAX_AGENT_CONTEXT_BYTES || !visit(value, 0))
      throw new Error("invalid");
    z.fromJSONSchema(value);
  } catch {
    context.addIssue({ code: "custom", message: "unsupported-or-unbounded-agent-schema" });
  }
});

export const agentDefinitionSchema = z.strictObject({
  version: z.literal(1),
  identity: contributionIdentityV1Schema.refine(
    (value) => value.nativeKind === "agent" || value.nativeKind === "subagent",
  ),
  label: identityText,
  purpose: z.string().min(1).max(2048),
  instructions: z.string().min(1).max(MAX_AGENT_CONTEXT_BYTES),
  inputSchema: jsonSchema,
  resultSchema: jsonSchema,
  capabilities: z.strictObject({
    required: z.array(identityText).max(256),
    optional: z.array(identityText).max(256),
  }),
  effects: z.array(z.enum(EFFECT_CLASSES)).max(EFFECT_CLASSES.length),
  context: z.literal("selected-evidence"),
  workspace: z.literal("inherited"),
  modelRole: z.literal("subagents"),
  model: roleRouteBaseSchema.optional(),
  preset: z.enum(["small", "medium", "big", "default"]).optional(),
  limits: resourceAmountsSchema,
  concurrencyClass: z.literal("inherited"),
  nestedDelegation: z.boolean(),
  completionCriteria: z.array(z.string().min(1).max(1024)).min(1).max(32),
  cancellation: z.literal("propagate"),
});
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;
export type RegisteredAgent = {
  readonly definition: AgentDefinition;
  readonly digest: string;
  readonly id: string;
  readonly provenance: "built-in" | "user" | "extension";
  readonly availability: "available" | "disabled" | "unavailable";
  readonly reason: string | null;
};

/** Stable namespace/local identity for role settings; descriptor revisions remain separate. */
export function agentDefinitionId(definition: AgentDefinition): string {
  return `${definition.identity.namespace}:${definition.identity.localId}`;
}

export function decodeAgentDefinition(
  raw: unknown,
):
  | { readonly ok: true; readonly definition: AgentDefinition; readonly digest: string }
  | { readonly ok: false; readonly code: "invalid-agent-definition" } {
  try {
    const encoded = canonicalJson(raw);
    if (Buffer.byteLength(encoded) > MAX_AGENT_CONTEXT_BYTES)
      return { ok: false, code: "invalid-agent-definition" };
    const parsed = agentDefinitionSchema.safeParse(JSON.parse(encoded));
    if (!parsed.success) return { ok: false, code: "invalid-agent-definition" };
    const { identity, ...descriptor } = parsed.data;
    if (identity.descriptorDigest !== canonicalDigest(descriptor))
      return { ok: false, code: "invalid-agent-definition" };
    return {
      ok: true,
      definition: freezeMetadata(parsed.data),
      digest: canonicalDigest(parsed.data),
    };
  } catch {
    return { ok: false, code: "invalid-agent-definition" };
  }
}

export function validateAgentValue(
  schema: AgentDefinition["inputSchema"],
  value: unknown,
  maximum: number,
): boolean {
  try {
    return (
      Buffer.byteLength(canonicalJson(value)) <= maximum &&
      z.fromJSONSchema(schema).safeParse(value).success
    );
  } catch {
    return false;
  }
}

export const agentContextItemSchema = z.strictObject({
  id: identityText,
  source: identityText,
  generation: identityText,
  text: z.string().max(MAX_AGENT_CONTEXT_BYTES),
  digest: digestSchema,
  artifact: processTaskArtifactSchema.optional(),
});
export type AgentContextItem = z.infer<typeof agentContextItemSchema>;
