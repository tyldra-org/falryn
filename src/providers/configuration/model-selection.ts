/** Shared route inheritance for settings inspection and future admitted workload owners. */
import type { RoleRoute } from "./policy.ts";
import type { ModelPreferences } from "./policy-schema.ts";
import type { FastOption, ModelRole, SubagentPreset } from "./roles.ts";

export type DefinitionModelIdentity = {
  readonly id: string;
  readonly label: string;
  readonly revision: string;
  readonly schemaRevision: number;
  readonly provenance: "built-in" | "user" | "extension";
  readonly availability: "available" | "disabled" | "unavailable";
  readonly unavailableReason: string | null;
};
export type AgentModelDefinition = DefinitionModelIdentity & {
  readonly kind: "agent";
  readonly model?: RoleRoute;
  /** Admitted by the definition owner. Labels never assign presets. */
  readonly preset?: SubagentPreset | "default";
};
export type WorkflowModelNode =
  | { readonly kind: "model"; readonly key: string; readonly model?: RoleRoute }
  | {
      readonly kind: "agent";
      readonly key: string;
      readonly agentId: string;
      readonly model?: RoleRoute;
    }
  | { readonly kind: "deterministic"; readonly key: string };
export type WorkflowModelDefinition = DefinitionModelIdentity & {
  readonly kind: "workflow";
  readonly model?: RoleRoute;
  readonly nodes: readonly WorkflowModelNode[];
};
export type ModelDefinition = AgentModelDefinition | WorkflowModelDefinition;
export type ModelSelectionTarget =
  | { readonly kind: "role"; readonly role: ModelRole }
  | { readonly kind: "fast"; readonly option: FastOption }
  | { readonly kind: "preset"; readonly preset: SubagentPreset }
  | { readonly kind: "agent"; readonly id: string }
  | { readonly kind: "workflow"; readonly id: string }
  | { readonly kind: "step"; readonly id: string; readonly key: string };
export type ModelRouteSource = { readonly source: string; readonly route: RoleRoute };
export type ModelSelection = {
  readonly kind: "route";
  readonly route: RoleRoute;
  readonly source: string;
  readonly chain: readonly ModelRouteSource[];
  readonly policyRevision: number;
  readonly configurationGeneration: number;
  readonly definitions: readonly {
    readonly id: string;
    readonly revision: string;
    readonly schemaRevision: number;
  }[];
  readonly availability: "available" | "disabled" | "unavailable" | "incompatible";
  readonly reason: string | null;
};
export type ResolveModelSelectionInput = {
  readonly preferences: ModelPreferences;
  readonly main: RoleRoute;
  readonly configurationGeneration: number;
  readonly definitions: readonly ModelDefinition[];
  readonly target: ModelSelectionTarget;
  /** Supplied only after the caller has authorized a targeted override. */
  readonly authorizedOverride?: RoleRoute;
  readonly workflowRunDefault?: RoleRoute;
  /** Workload owner reports readiness; settings cannot manufacture a runner. */
  readonly fastAvailability?: Partial<Record<FastOption, "available" | "disabled" | "unavailable">>;
};

/** One immutable binding; this is selection, not execution or permission admission. */
export function resolveModelSelection(
  input: ResolveModelSelectionInput,
): ModelSelection | { readonly kind: "no-model" } {
  const {
    preferences: { roles },
    target,
  } = input;
  const chain: ModelRouteSource[] = [];
  const definitions: ModelSelection["definitions"][number][] = [];
  let availability: ModelSelection["availability"] = "available";
  let reason: string | null = null;
  const add = (source: string, route: RoleRoute | undefined): void => {
    if (route !== undefined) chain.push({ source, route: snapshotRoute(route) });
  };
  const unavailable = (message: string): void => {
    availability = "unavailable";
    reason = message;
  };
  const record = (
    definition: ModelDefinition,
    saved?: {
      readonly definitionRevision?: string | undefined;
      readonly schemaRevision?: number | undefined;
    },
  ): void => {
    definitions.push({
      id: definition.id,
      revision: definition.revision,
      schemaRevision: definition.schemaRevision,
    });
    if (definition.availability !== "available") {
      availability = definition.availability;
      reason = definition.unavailableReason ?? "The definition has no available runner.";
    }
    if (
      (saved?.definitionRevision !== undefined &&
        saved.definitionRevision !== definition.revision) ||
      (saved?.schemaRevision !== undefined && saved.schemaRevision !== definition.schemaRevision)
    ) {
      availability = "incompatible";
      reason = "Saved preferences require review against the changed definition revision.";
    }
  };
  const agent = (id: string): void => {
    const saved = roles.subagents?.agents?.[id];
    const definition = input.definitions.find(
      (entry): entry is AgentModelDefinition => entry.kind === "agent" && entry.id === id,
    );
    add(`agent:${id}`, saved?.route);
    if (definition === undefined)
      unavailable("Agent definition is not registered; its preferences are retained.");
    else {
      record(definition, saved);
      add(`agent-definition:${id}`, definition.model);
    }
    const preset = saved?.preset ?? definition?.preset ?? "default";
    if (preset !== "default") add(`subagents.preset:${preset}`, roles.subagents?.presets?.[preset]);
    add("subagents.default", roles.subagents?.default);
  };

  // A deterministic node cannot acquire a model even from a targeted override.
  if (target.kind === "step") {
    const workflow = input.definitions.find(
      (entry): entry is WorkflowModelDefinition =>
        entry.kind === "workflow" && entry.id === target.id,
    );
    if (workflow?.nodes.find((node) => node.key === target.key)?.kind === "deterministic")
      return { kind: "no-model" };
  }
  add("invocation", input.authorizedOverride);
  switch (target.kind) {
    case "role": {
      const { role } = target;
      if (role === "fast" || role === "subagents" || role === "workflows")
        add(`${role}.default`, roles[role]?.default);
      else if (role !== "default") add(role, roles[role]);
      if (role === "subagents" || role === "workflows" || role === "fast")
        unavailable(
          "Choose an actual workload or registered definition to inspect execution readiness.",
        );
      if (
        (role === "vision" || role === "advisor") &&
        (roles[role] === undefined || roles[role]?.use === "off")
      ) {
        availability = "disabled";
        reason = "The role is unconfigured or disabled.";
      }
      break;
    }
    case "fast":
      add(`fast.options:${target.option}`, roles.fast?.options?.[target.option]);
      add("fast.default", roles.fast?.default);
      availability = input.fastAvailability?.[target.option] ?? "unavailable";
      reason =
        availability === "available"
          ? null
          : "The workload owner has not supplied an available runner.";
      if (
        (target.option === "memory" || target.option === "compaction") &&
        roles.fast?.use?.[target.option] !== "evaluated"
      ) {
        availability = "disabled";
        reason = "Model-assisted use is off; a route assignment does not enable it.";
      }
      break;
    case "preset":
      add(`subagents.preset:${target.preset}`, roles.subagents?.presets?.[target.preset]);
      add("subagents.default", roles.subagents?.default);
      unavailable("A preset is a preference; it does not identify or launch a workload.");
      break;
    case "agent":
      agent(target.id);
      break;
    case "workflow":
    case "step": {
      const saved = roles.workflows?.definitions?.[target.id];
      const definition = input.definitions.find(
        (entry): entry is WorkflowModelDefinition =>
          entry.kind === "workflow" && entry.id === target.id,
      );
      if (definition === undefined)
        unavailable("Workflow definition is not registered; its preferences are retained.");
      else record(definition, saved);
      if (target.kind === "step") {
        add(`workflow-step:${target.id}:${target.key}`, saved?.steps?.[target.key]);
        const node = definition?.nodes.find((entry) => entry.key === target.key);
        if (node === undefined) unavailable("The stable template step is not registered.");
        else if (node.kind !== "deterministic") {
          add(`node-definition:${target.id}:${target.key}`, node.model);
          if (node.kind === "agent") {
            agent(node.agentId);
            break;
          }
        }
      }
      add("workflow-run", input.workflowRunDefault);
      add(`workflow:${target.id}`, saved?.default);
      add(`workflow-definition:${target.id}`, definition?.model);
      add("workflows.default", roles.workflows?.default);
      break;
    }
  }
  add("main", input.main);
  const winner = chain[0];
  if (winner === undefined) throw new Error("A captured main route is required.");
  return Object.freeze({
    kind: "route",
    route: winner.route,
    source: winner.source,
    chain: Object.freeze(chain.map((entry) => Object.freeze(entry))),
    policyRevision: input.preferences.revision,
    configurationGeneration: input.configurationGeneration,
    definitions: Object.freeze(definitions.map((entry) => Object.freeze(entry))),
    availability,
    reason,
  });
}

function snapshotRoute(route: RoleRoute): RoleRoute {
  return Object.freeze({
    ...route,
    budgets: Object.freeze({ ...route.budgets }),
    fallbacks: Object.freeze(route.fallbacks.map((fallback) => Object.freeze({ ...fallback }))),
  });
}

/** Saved missing definitions remain visible. Names do not merge identities. */
export function modelDefinitionPage(input: {
  readonly definitions: readonly ModelDefinition[];
  readonly preferences: ModelPreferences;
  readonly kind: "agent" | "workflow";
  readonly search?: string;
  readonly offset?: number;
  readonly limit?: number;
}): {
  readonly entries: readonly { readonly id: string; readonly definition: ModelDefinition | null }[];
  readonly nextOffset: number | null;
  readonly total: number;
} {
  const saved =
    input.kind === "agent"
      ? input.preferences.roles.subagents?.agents
      : input.preferences.roles.workflows?.definitions;
  const catalog = new Map(
    input.definitions
      .filter((entry) => entry.kind === input.kind)
      .map((entry) => [entry.id, entry]),
  );
  const query = (input.search ?? "").slice(0, 256).toLowerCase();
  const ids = [...new Set([...catalog.keys(), ...Object.keys(saved ?? {})])]
    .filter(
      (id) =>
        id.toLowerCase().includes(query) || catalog.get(id)?.label.toLowerCase().includes(query),
    )
    .sort();
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));
  const limit = Math.min(50, Math.max(1, Math.trunc(input.limit ?? 50)));
  return {
    entries: ids
      .slice(offset, offset + limit)
      .map((id) => ({ id, definition: catalog.get(id) ?? null })),
    nextOffset: offset + limit < ids.length ? offset + limit : null,
    total: ids.length,
  };
}
