/** Inert definitions share qualified contribution identities and model selection. */
import { freezeMetadata } from "../../domain/extensions/canonical.ts";
import {
  decodeWorkflowDefinition,
  type WorkflowDefinition,
} from "../../domain/orchestration/workflow-definition.ts";
import type {
  DefinitionModelIdentity,
  WorkflowModelDefinition,
  WorkflowModelNode,
} from "../../providers/configuration/model-selection.ts";
import {
  contributionIdentitySchema,
  roleRouteBaseSchema,
} from "../../providers/configuration/policy-schema.ts";

export type RegisteredWorkflow = DefinitionModelIdentity & {
  readonly definition: WorkflowDefinition;
  readonly digest: string;
};
export type WorkflowRegistration = {
  readonly definition: unknown;
  /** The admitted contribution owner supplies identity and provenance separately from file data. */
  readonly identity: Omit<DefinitionModelIdentity, "label" | "revision" | "schemaRevision">;
};

export function workflowModelDefinition(entry: RegisteredWorkflow): WorkflowModelDefinition {
  const model =
    entry.definition.model === undefined
      ? undefined
      : roleRouteBaseSchema.parse(entry.definition.model);
  const nodes: WorkflowModelNode[] = entry.definition.nodes.map((node) => {
    if (node.kind !== "model" && node.kind !== "agent")
      return { key: node.key, kind: "deterministic" };
    const route = node.model === undefined ? undefined : roleRouteBaseSchema.parse(node.model);
    const selected = route ? { model: route } : {};
    return node.kind === "agent"
      ? { key: node.key, kind: "agent", agentId: node.agentId, ...selected }
      : { key: node.key, kind: "model", ...selected };
  });
  return {
    id: entry.id,
    label: entry.label,
    revision: entry.revision,
    schemaRevision: entry.schemaRevision,
    provenance: entry.provenance,
    availability: entry.availability,
    unavailableReason: entry.unavailableReason,
    kind: "workflow",
    nodes,
    ...(model ? { model } : {}),
  };
}

export function createWorkflowRegistry(initial: readonly WorkflowRegistration[] = []) {
  const entries = new Map<string, RegisteredWorkflow>();
  let generation = 0;
  function register(input: WorkflowRegistration, expectedDigest: string | null) {
    const decoded = decodeWorkflowDefinition(input.definition);
    if (!decoded.ok) return decoded;
    const { definition, digest } = decoded;
    if (
      !contributionIdentitySchema.safeParse(input.identity.id).success ||
      definition.id !== input.identity.id ||
      (input.identity.provenance === "user" && !/^user[/:]/.test(definition.id)) ||
      (input.identity.provenance === "built-in" && !/^builtin[/:]/.test(definition.id)) ||
      (input.identity.provenance === "extension" && !/^package\//.test(definition.id))
    )
      return { ok: false as const, diagnostics: [{ path: "id", code: "workflow-owner-mismatch" }] };
    const models = [
      definition.model,
      ...definition.nodes.flatMap((node) =>
        node.kind === "model" || node.kind === "agent" ? [node.model] : [],
      ),
    ];
    if (
      models.some((model) => model !== undefined && !roleRouteBaseSchema.safeParse(model).success)
    )
      return {
        ok: false as const,
        diagnostics: [{ path: "model", code: "workflow-invalid-route" }],
      };
    if ((entries.get(definition.id)?.digest ?? null) !== expectedDigest)
      return {
        ok: false as const,
        diagnostics: [{ path: "id", code: "workflow-stale-definition" }],
      };
    const entry: RegisteredWorkflow = freezeMetadata({
      ...input.identity,
      definition,
      digest,
      label: definition.label,
      revision: digest,
      schemaRevision: 1,
    });
    entries.set(entry.id, entry);
    generation++;
    return { ok: true as const, value: entry };
  }
  for (const contribution of initial) {
    const result = register(contribution, null);
    if (!result.ok) throw new Error("workflow-registration-invalid");
  }
  return {
    generation: () => generation,
    register,
    resolve: (id: string) => entries.get(id) ?? null,
    page(search = "", offset = 0) {
      const query = search.slice(0, 256).toLowerCase();
      const found = [...entries.values()]
        .filter((entry) => `${entry.id} ${entry.label}`.toLowerCase().includes(query))
        .sort((a, b) => a.id.localeCompare(b.id));
      const start = Math.max(0, Math.trunc(offset));
      return {
        entries: found.slice(start, start + 50),
        nextOffset: start + 50 < found.length ? start + 50 : null,
        total: found.length,
      };
    },
    models: (): readonly WorkflowModelDefinition[] =>
      [...entries.values()].map(workflowModelDefinition),
  };
}
export type WorkflowRegistry = ReturnType<typeof createWorkflowRegistry>;
