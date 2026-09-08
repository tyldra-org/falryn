import { describe, expect, test } from "bun:test";
import {
  type AgentModelDefinition,
  type ModelDefinition,
  type ModelSelectionTarget,
  modelDefinitionPage,
  resolveModelSelection,
  type WorkflowModelDefinition,
} from "./model-selection.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  type ModelPreferences,
  modelPreferencesSchema,
  roleRouteBaseSchema,
} from "./policy-schema.ts";
import { FAST_OPTIONS, MODEL_ROLES } from "./roles.ts";
import { editModelPreferences } from "./settings-actions.ts";

const route = (modelId: string) =>
  roleRouteBaseSchema.parse({ providerProfileId: "account", providerId: "test", modelId });
const main = route("main");
const agent: AgentModelDefinition = {
  kind: "agent",
  id: "builtin:explorer",
  label: "Explorer",
  revision: "v1",
  schemaRevision: 1,
  provenance: "built-in",
  availability: "available",
  unavailableReason: null,
  preset: "small",
};
const workflow: WorkflowModelDefinition = {
  kind: "workflow",
  id: "user:review",
  label: "Review",
  revision: "v1",
  schemaRevision: 1,
  provenance: "user",
  availability: "available",
  unavailableReason: null,
  nodes: [
    { kind: "model", key: "synthesize" },
    { kind: "agent", key: "inspect", agentId: agent.id },
    { kind: "deterministic", key: "join" },
  ],
};
function resolve(
  preferences: ModelPreferences,
  target: ModelSelectionTarget,
  definitions: readonly ModelDefinition[] = [agent, workflow],
) {
  return resolveModelSelection({
    preferences,
    main,
    configurationGeneration: 7,
    target,
    definitions,
  });
}
function model(selection: ReturnType<typeof resolve>): string | null {
  return selection.kind === "route" ? selection.route.modelId : null;
}
const preferences = (roles: unknown) =>
  modelPreferencesSchema.parse({ ...EMPTY_MODEL_PREFERENCES, roles });

describe("shared model-role selection", () => {
  test("saved definition and stable-step limits reject excess and unsafe identities", () => {
    const agents = Object.fromEntries(
      Array.from({ length: 1001 }, (_, n) => [`user:agent-${n}`, { route: main }]),
    );
    expect(
      modelPreferencesSchema.safeParse({
        ...EMPTY_MODEL_PREFERENCES,
        roles: { subagents: { agents } },
      }).success,
    ).toBe(false);
    const steps = Object.fromEntries(Array.from({ length: 257 }, (_, n) => [`step-${n}`, main]));
    expect(
      modelPreferencesSchema.safeParse({
        ...EMPTY_MODEL_PREFERENCES,
        roles: { workflows: { definitions: { "user:flow": { steps } } } },
      }).success,
    ).toBe(false);
    for (const key of ["constructor", "prototype", "__proto__"]) {
      expect(
        modelPreferencesSchema.safeParse({
          ...EMPTY_MODEL_PREFERENCES,
          roles: { workflows: { definitions: { "user:flow": { steps: { [key]: main } } } } },
        }).success,
      ).toBe(false);
    }
  });
  test("new schemas retire executable roles and enforce ordinary main-model intent", () => {
    expect(MODEL_ROLES).toEqual([
      "default",
      "fast",
      "subagents",
      "workflows",
      "vision",
      "plan",
      "advisor",
    ]);
    for (const role of ["compact", "commit", "fast-read", "fast-edit"]) {
      expect(
        modelPreferencesSchema.safeParse({
          ...EMPTY_MODEL_PREFERENCES,
          roles: { [role]: route("old") },
        }).success,
      ).toBe(false);
    }
    expect(
      modelPreferencesSchema.safeParse({
        ...EMPTY_MODEL_PREFERENCES,
        intents: { ...EMPTY_MODEL_PREFERENCES.intents, read: "fast" },
      }).success,
    ).toBe(false);
  });
  test("all six Fast options inherit, override, reset and retain explicit children", () => {
    for (const option of FAST_OPTIONS) {
      const target = { kind: "fast", option } as const;
      const parent = preferences({ fast: { default: route("fast") } });
      expect(model(resolve(parent, target))).toBe("fast");
      const child = editModelPreferences(parent, {
        kind: "configure",
        target,
        route: route("child"),
      });
      const changedParent = editModelPreferences(child, {
        kind: "configure",
        target: { kind: "role", role: "fast" },
        route: route("new-parent"),
      });
      expect(model(resolve(changedParent, target))).toBe("child");
      const reset = editModelPreferences(changedParent, { kind: "reset", target });
      expect(model(resolve(reset, target))).toBe("new-parent");
      expect(
        model(
          resolve(
            editModelPreferences(reset, { kind: "reset", target: { kind: "role", role: "fast" } }),
            target,
          ),
        ),
      ).toBe("main");
      const override = resolveModelSelection({
        preferences: parent,
        main,
        target,
        definitions: [],
        configurationGeneration: 8,
        authorizedOverride: route("invoked"),
      });
      expect(model(override)).toBe("invoked");
      expect(override.kind === "route" && override.availability).not.toBe("available");
    }
  });
  test("model replacement uses provider-default thinking and leaves memory off", () => {
    const old = preferences({ fast: { default: { ...route("old"), reasoning: "max" } } });
    const changed = editModelPreferences(old, {
      kind: "configure",
      target: { kind: "fast", option: "memory" },
      route: route("new"),
    });
    const selected = resolve(changed, { kind: "fast", option: "memory" });
    expect(selected.kind === "route" && selected.route.reasoning).toBe("provider-default");
    expect(selected.kind === "route" && selected.availability).toBe("disabled");
  });
  test("agent precedence is targeted, saved, definition, preset, role, main", () => {
    const configured = preferences({
      fast: { default: route("never") },
      subagents: {
        default: route("role"),
        presets: { small: route("preset") },
        agents: { [agent.id]: { route: route("saved") } },
      },
    });
    const declared = { ...agent, model: route("definition") };
    const target = { kind: "agent", id: agent.id } as const;
    const invoked = resolveModelSelection({
      preferences: configured,
      main,
      configurationGeneration: 7,
      target,
      definitions: [declared],
      authorizedOverride: route("targeted"),
    });
    expect(model(invoked)).toBe("targeted");
    expect(model(resolve(configured, target, [declared]))).toBe("saved");
    const reset = editModelPreferences(configured, { kind: "reset", target });
    expect(model(resolve(reset, target, [declared]))).toBe("definition");
    expect(model(resolve(reset, target))).toBe("preset");
    const withoutPreset = editModelPreferences(reset, {
      kind: "reset",
      target: { kind: "preset", preset: "small" },
    });
    expect(model(resolve(withoutPreset, target))).toBe("role");
    const withoutRole = editModelPreferences(withoutPreset, {
      kind: "reset",
      target: { kind: "role", role: "subagents" },
    });
    expect(model(resolve(withoutRole, target))).toBe("main");
  });
  test("membership edits preserve explicit models and reset restores admitted preference", () => {
    const initial = preferences({
      subagents: {
        presets: { small: route("small"), big: route("big") },
        agents: { [agent.id]: { route: route("saved") } },
      },
    });
    const member = editModelPreferences(initial, {
      kind: "membership",
      id: agent.id,
      preset: "big",
    });
    expect(model(resolve(member, { kind: "agent", id: agent.id }))).toBe("saved");
    const resetRoute = editModelPreferences(member, {
      kind: "reset",
      target: { kind: "agent", id: agent.id },
    });
    expect(model(resolve(resetRoute, { kind: "agent", id: agent.id }))).toBe("big");
    const resetMembership = editModelPreferences(resetRoute, {
      kind: "membership",
      id: agent.id,
      preset: null,
    });
    expect(model(resolve(resetMembership, { kind: "agent", id: agent.id }))).toBe("small");
  });
  test("workflow model nodes use workflow precedence while agent nodes use agent precedence", () => {
    const configured = preferences({
      fast: { default: route("never") },
      subagents: { default: route("agent-role") },
      workflows: {
        default: route("workflow-role"),
        definitions: {
          [workflow.id]: {
            default: route("saved-workflow"),
            steps: { synthesize: route("saved-step") },
          },
        },
      },
    });
    const declared = {
      ...workflow,
      model: route("definition-workflow"),
      nodes: workflow.nodes.map((node) =>
        node.kind === "model" ? { ...node, model: route("node") } : node,
      ),
    };
    const target = { kind: "step", id: workflow.id, key: "synthesize" } as const;
    expect(model(resolve(configured, target, [agent, declared]))).toBe("saved-step");
    const reset = editModelPreferences(configured, { kind: "reset", target });
    expect(model(resolve(reset, target, [agent, declared]))).toBe("node");
    expect(
      model(
        resolveModelSelection({
          preferences: reset,
          main,
          configurationGeneration: 7,
          target,
          definitions: [agent, workflow],
          workflowRunDefault: route("run"),
        }),
      ),
    ).toBe("run");
    expect(model(resolve(reset, target))).toBe("saved-workflow");
    expect(model(resolve(configured, { kind: "step", id: workflow.id, key: "inspect" }))).toBe(
      "agent-role",
    );
    expect(
      resolveModelSelection({
        preferences: configured,
        main,
        configurationGeneration: 7,
        target: { kind: "step", id: workflow.id, key: "join" },
        definitions: [workflow],
        authorizedOverride: route("cannot-call"),
      }),
    ).toEqual({ kind: "no-model" });
  });
  test("bindings survive parent edits and restart; removed and changed definitions fail closed", () => {
    const configured = preferences({
      subagents: {
        default: route("before"),
        agents: { [agent.id]: { definitionRevision: "v1", schemaRevision: 1 } },
      },
    });
    const bound = resolve(configured, { kind: "agent", id: agent.id });
    if (configured.roles.subagents === undefined) throw new Error("Expected agent settings");
    configured.roles.subagents.default = route("after");
    expect(model(bound)).toBe("before");
    expect(
      model(
        resolve(modelPreferencesSchema.parse(JSON.parse(JSON.stringify(configured))), {
          kind: "agent",
          id: agent.id,
        }),
      ),
    ).toBe("after");
    const removed = resolve(configured, { kind: "agent", id: agent.id }, []);
    expect(removed.kind === "route" && removed.availability).toBe("unavailable");
    const changed = resolve(configured, { kind: "agent", id: agent.id }, [
      { ...agent, revision: "v2" },
    ]);
    expect(changed.kind === "route" && changed.availability).toBe("incompatible");
  });
  test("catalogs preserve same-name identities, missing entries, and bounded pagination", () => {
    const definitions = Array.from(
      { length: 60 },
      (_, n): AgentModelDefinition => ({
        ...agent,
        id: `extension:agent-${n}`,
        label: "Explorer",
        provenance: "extension",
      }),
    );
    const configured = preferences({
      subagents: { agents: { "removed:agent": { route: route("saved") } } },
    });
    const page = modelDefinitionPage({ definitions, preferences: configured, kind: "agent" });
    expect(page.total).toBe(61);
    expect(page.entries).toHaveLength(50);
    expect(page.nextOffset).toBe(50);
    const removed = modelDefinitionPage({
      definitions,
      preferences: configured,
      kind: "agent",
      search: "removed",
    });
    expect(removed.entries).toEqual([{ id: "removed:agent", definition: null }]);
    expect(
      model(resolve(configured, { kind: "agent", id: "extension:agent-0" }, definitions)),
    ).toBe("main");
  });
});
