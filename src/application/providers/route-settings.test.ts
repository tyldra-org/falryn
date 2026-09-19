import { expect, test } from "bun:test";
import { resolveModelSelection } from "../../providers/configuration/model-selection.ts";
import { modelSelectionSchema } from "../../providers/configuration/model-selection-schema.ts";
import { bindNamedModelPreferences } from "../../providers/configuration/named-route-binding.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  roleRouteBaseSchema,
} from "../../providers/configuration/policy-schema.ts";
import { routeDefinition, routeFacts } from "../../providers/routing/named-route.fixtures.ts";
import {
  createModelSettingsService,
  type ModelSettingsSnapshot,
  type ModelSettingsStore,
} from "./model-settings.ts";

function fixture() {
  let writes = 0;
  let snapshot: ModelSettingsSnapshot = {
    preferences: EMPTY_MODEL_PREFERENCES,
    namedRoutes: [routeDefinition()],
    routeFacts: routeFacts(),
    generation: 3,
    fileRevision: "one",
    scope: "user",
    main: roleRouteBaseSchema.parse({
      providerProfileId: "one",
      providerId: "openai",
      modelId: "exact",
    }),
    definitions: [],
  };
  const store: ModelSettingsStore = {
    read: async () => snapshot,
    validateRoute: async () => ({ ok: true }),
    write: async (preferences, revision) => {
      if (revision !== snapshot.fileRevision) return { kind: "stale", code: "stale-settings" };
      writes++;
      snapshot = { ...snapshot, preferences, fileRevision: String(writes) };
      return { kind: "written", revision: String(writes) };
    },
    writeRoutes: async (definitions, revision) => {
      if (revision !== snapshot.fileRevision) return { kind: "stale", code: "stale-settings" };
      writes++;
      snapshot = { ...snapshot, namedRoutes: definitions, fileRevision: String(writes) };
      return { kind: "written", revision: String(writes) };
    },
    backup: async () => ({ ok: true, location: "backup" }),
  };
  return {
    service: createModelSettingsService(store),
    snapshot: () => snapshot,
    writes: () => writes,
    update: (patch: Partial<ModelSettingsSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
    },
  };
}
test("inspect, explain, simulate and validate share inert decisions and accumulate validation errors", async () => {
  const f = fixture();
  const inspect = await f.service.execute({ kind: "route-explain", id: "daily" });
  const simulate = await f.service.execute({ kind: "route-simulate", id: "daily", facts: [] });
  expect(inspect.kind === "route-inspection" && inspect.resolution).toEqual(
    simulate.kind === "route-inspection" && simulate.resolution,
  );
  const drained = await f.service.execute({
    kind: "route-simulate",
    id: "daily",
    facts: [{ target: routeDefinition().primary, lifecycle: "draining" }],
  });
  expect(
    drained.kind === "route-inspection" &&
      drained.resolution.receipt?.eligible[0]?.target.connectionId,
  ).toBe("two");
  const invalid = await f.service.execute({
    kind: "route-validate",
    definitions: [{ ...routeDefinition(), id: "", revision: -1 }],
  });
  expect(
    invalid.kind === "route-validation" && !invalid.ok && invalid.errors.length,
  ).toBeGreaterThanOrEqual(2);
  expect(f.writes()).toBe(0);
});
test("save revisions, cancellation, profile scope and reset preserve prior state", async () => {
  const f = fixture(),
    next = { ...routeDefinition(), revision: 2, label: "Daily" };
  const results = await Promise.all(
    [1, 2].map(() =>
      f.service.execute({ kind: "route-save", definitions: [next], expectedRevision: "one" }),
    ),
  );
  expect(results.filter((result) => result.kind === "route-written")).toHaveLength(1);
  expect(f.writes()).toBe(1);
  expect(
    await f.service.execute({
      kind: "route-save",
      definitions: [{ ...next, label: "Other" }],
      expectedRevision: "1",
    }),
  ).toMatchObject({ kind: "failed", code: "route-revision-must-advance" });
  expect(
    await f.service.execute(
      { kind: "route-reset", id: "daily", expectedRevision: "1" },
      AbortSignal.abort(),
    ),
  ).toMatchObject({ kind: "failed", code: "cancelled" });
  f.update({ scope: "profile" });
  expect(
    await f.service.execute({ kind: "route-reset", id: "daily", expectedRevision: "1" }),
  ).toMatchObject({ kind: "failed", code: "route-definitions-global-only" });
  f.update({ scope: "user", routeFacts: [] });
  expect(
    await f.service.execute({ kind: "route-reset", id: "daily", expectedRevision: "1" }),
  ).toMatchObject({ kind: "route-written", definitions: [] });
});
test("named role selections survive capture and recovery; removed references stay unavailable", async () => {
  const f = fixture();
  expect(
    await f.service.execute({
      kind: "edit",
      edit: {
        kind: "configure",
        target: { kind: "role", role: "plan" },
        route: { kind: "route", routeId: "daily" },
      },
      expectedRevision: "one",
    }),
  ).toMatchObject({ kind: "written" });
  const snapshot = f.snapshot();
  const preferences = bindNamedModelPreferences(
    snapshot.preferences,
    snapshot.namedRoutes ?? [],
    snapshot.routeFacts ?? [],
    3,
  );
  if (!snapshot.main) throw new Error("Missing fixture main");
  const selection = resolveModelSelection({
    preferences,
    main: snapshot.main,
    definitions: [],
    configurationGeneration: 3,
    target: { kind: "role", role: "plan" },
  });
  if (selection.kind !== "route") throw new Error("fixture");
  expect(selection.route.namedRoute?.routeId).toBe("daily");
  const restored = modelSelectionSchema.parse(JSON.parse(JSON.stringify(selection)));
  expect(restored.route.namedRoute).toEqual(selection.route.namedRoute);
  expect(Object.isFrozen(restored.route.namedRoute?.definition)).toBe(true);
  f.update({ namedRoutes: [] });
  const missing = await f.service.execute({
    kind: "inspect",
    target: { kind: "role", role: "plan" },
  });
  expect(missing.kind === "inspection" && missing.rows[0]?.selection).toMatchObject({
    availability: "unavailable",
  });
  expect(selection.route.namedRoute?.definitionRevision).toBe(1);
  expect(
    modelSelectionSchema.safeParse({
      ...selection,
      route: { ...selection.route, modelId: "other" },
    }).success,
  ).toBe(false);
});
