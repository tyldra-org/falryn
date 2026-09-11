import { expect, test } from "bun:test";
import { simpleWorkflow } from "../../domain/orchestration/workflow.fixtures.ts";
import { resolveModelSelection } from "../../providers/configuration/model-selection.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  roleRouteBaseSchema,
} from "../../providers/configuration/policy-schema.ts";
import { createWorkflowRegistry } from "./workflow-registry.ts";

test("workflow identities cannot impersonate another owner and editing preserves captured definitions", () => {
  const registry = createWorkflowRegistry();
  const identity = {
    id: "user/test:checks",
    provenance: "user" as const,
    availability: "available" as const,
    unavailableReason: null,
  };
  const registered = registry.register({ identity, definition: simpleWorkflow() }, null);
  if (!registered.ok) throw new Error("missing definition");
  expect(
    registry.register(
      {
        identity: { ...identity, id: "builtin:checks" },
        definition: { ...simpleWorkflow(), id: "builtin:checks" },
      },
      null,
    ).ok,
  ).toBe(false);
  expect(
    registry.register({ identity, definition: { ...simpleWorkflow(), label: "Changed" } }, null).ok,
  ).toBe(false);
  expect(
    registry.register(
      { identity, definition: { ...simpleWorkflow(), label: "Changed" } },
      registered.value.digest,
    ).ok,
  ).toBe(true);
  expect(registered.value.label).toBe("Checks");
  expect(registry.resolve(identity.id)?.label).toBe("Changed");
});
test("registered nodes feed the shared model resolver and targeted/run defaults retain precedence", () => {
  const registry = createWorkflowRegistry();
  const identity = {
    id: "user/test:checks",
    provenance: "user" as const,
    availability: "available" as const,
    unavailableReason: null,
  };
  const route = (modelId: string) =>
    roleRouteBaseSchema.parse({ providerProfileId: "account", providerId: "test", modelId });
  const registered = registry.register(
    {
      identity,
      definition: {
        ...simpleWorkflow(),
        model: route("definition"),
        nodes: [
          {
            key: "model",
            kind: "model",
            instruction: "Interpret",
            resultSchema: { type: "string" },
          },
        ],
        outputs: {},
      },
    },
    null,
  );
  expect(registered.ok).toBe(true);
  const request = {
    preferences: EMPTY_MODEL_PREFERENCES,
    main: route("main"),
    configurationGeneration: 1,
    definitions: registry.models(),
    target: { kind: "step" as const, id: identity.id, key: "model" },
  };
  expect(resolveModelSelection(request)).toMatchObject({ route: { modelId: "definition" } });
  expect(resolveModelSelection({ ...request, workflowRunDefault: route("run") })).toMatchObject({
    route: { modelId: "run" },
  });
  expect(
    resolveModelSelection({
      ...request,
      workflowRunDefault: route("run"),
      authorizedOverride: route("target"),
    }),
  ).toMatchObject({ route: { modelId: "target" } });
});
