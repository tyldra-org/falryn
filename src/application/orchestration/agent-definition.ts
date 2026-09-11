/** Inert agent definitions. Registration never authorizes execution. */
import { z } from "zod";
import { definitionValueSchema as jsonSchema } from "../../domain/orchestration/definition-values.ts";

export { validateDefinitionValue as validateAgentValue } from "../../domain/orchestration/definition-values.ts";

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

export const agentContextItemSchema = z.strictObject({
  id: identityText,
  source: identityText,
  generation: identityText,
  text: z.string().max(MAX_AGENT_CONTEXT_BYTES),
  digest: digestSchema,
  artifact: processTaskArtifactSchema.optional(),
});
export type AgentContextItem = z.infer<typeof agentContextItemSchema>;
