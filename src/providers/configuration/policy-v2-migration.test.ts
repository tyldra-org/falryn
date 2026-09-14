import { expect, test } from "bun:test";
import { previewModelPolicyMigration, readStoredModelPreferences } from "./policy-migration.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  modelPreferencesSchema,
  roleRouteBaseSchema,
} from "./policy-schema.ts";
import { FAST_OPTIONS } from "./roles.ts";
import { modelSettingsEditSchema } from "./settings-actions.ts";

const route = (modelId: string) =>
  roleRouteBaseSchema.parse({
    providerProfileId: "account",
    providerId: "test",
    modelId,
    reasoning: "deep",
    processing: { mode: "fast" },
    budgets: { attempts: 2, cost: 100 },
    fallbacks: [{ providerProfileId: "backup", providerId: "test", modelId: "permitted" }],
  });
const previous = {
  ...EMPTY_MODEL_PREFERENCES,
  schemaVersion: 2,
  revision: 7,
  processing: { mode: "standard" as const },
  roles: {
    default: route("main"),
    fast: {
      default: route("fast"),
      options: {
        ...Object.fromEntries(FAST_OPTIONS.map((option) => [option, route(option)])),
        compaction: route("retired"),
      },
      use: { memory: "off", compaction: "evaluated" },
    },
    subagents: { default: route("agents") },
    workflows: { default: route("workflows") },
  },
  intents: { ...EMPTY_MODEL_PREFERENCES.intents, compression: "fast" },
};

test("version 2 reads are inert projections and retirement preserves every registered unrelated setting", () => {
  const source = structuredClone(previous);
  const projected = readStoredModelPreferences(source);
  expect(source).toEqual(previous);
  expect(projected.schemaVersion).toBe(3);
  expect(projected.roles.default).toEqual(previous.roles.default);
  expect(projected.processing).toEqual(previous.processing);
  expect(projected.roles.fast?.default).toEqual(previous.roles.fast.default);
  for (const option of FAST_OPTIONS)
    expect(projected.roles.fast?.options?.[option]).toEqual(route(option));
  expect(projected.roles.fast?.use).toEqual({ memory: "off" });
  expect(projected.roles.subagents).toEqual(previous.roles.subagents);
  expect(projected.roles.workflows).toEqual(previous.roles.workflows);
  expect(JSON.stringify(projected)).not.toContain("compaction");
  const preview = previewModelPolicyMigration(source, projected);
  if (preview.kind !== "preview") throw new Error(preview.message);
  expect(preview.unresolved).toEqual([]);
  expect(preview.candidate).toEqual(projected);
  expect(preview.original).toEqual(previous);
  expect(
    preview.changes.filter((change) => change.kind === "retired").map((change) => change.path),
  ).toEqual(["roles.fast.options.compaction", "roles.fast.use.compaction"]);
});

test("conflicting current choices and main are preserved until an explicit migration decision", () => {
  const current = modelPreferencesSchema.parse({
    ...EMPTY_MODEL_PREFERENCES,
    roles: {
      default: route("current-main"),
      fast: {
        default: route("current-fast"),
        options: { memory: route("current-memory") },
        use: { memory: "evaluated" },
      },
    },
  });
  const preview = previewModelPolicyMigration(previous, current);
  if (preview.kind !== "preview") throw new Error(preview.message);
  expect(preview.unresolved).toEqual([
    "roles.fast.default",
    "roles.fast.options.memory",
    "roles.fast.use.memory",
  ]);
  expect(preview.candidate.roles.default).toEqual(current.roles.default);
  expect(preview.candidate.roles.fast?.options?.memory).toEqual(
    current.roles.fast?.options?.memory,
  );
  const decided = previewModelPolicyMigration(
    previous,
    current,
    Object.fromEntries(preview.unresolved.map((path) => [path, "keep-current"])),
  );
  expect(decided.kind === "preview" && decided.unresolved).toEqual([]);
  expect(decided.kind === "preview" && decided.candidate.roles.fast?.use).toEqual({
    memory: "evaluated",
  });
});

test("unknown versions and independently unregistered shapes refuse; new edits cannot recreate retired settings", () => {
  for (const source of [
    { ...previous, schemaVersion: 99 },
    {
      ...previous,
      roles: {
        ...previous.roles,
        fast: {
          ...previous.roles.fast,
          options: { ...previous.roles.fast.options, "session-title": route("not-registered") },
        },
      },
    },
    {
      ...previous,
      roles: {
        ...previous.roles,
        fast: {
          ...previous.roles.fast,
          use: { ...previous.roles.fast.use, "code-understanding": "evaluated" },
        },
      },
    },
  ]) {
    const original = structuredClone(source);
    expect(previewModelPolicyMigration(source, EMPTY_MODEL_PREFERENCES).kind).toBe("invalid");
    expect(() => readStoredModelPreferences(source)).toThrow();
    expect(source).toEqual(original);
  }
  expect(modelPreferencesSchema.safeParse(previous).success).toBe(false);
  expect(
    modelSettingsEditSchema.safeParse({ kind: "use", option: "compaction", use: "off" }).success,
  ).toBe(false);
  expect(
    modelSettingsEditSchema.safeParse({
      kind: "configure",
      target: { kind: "fast", option: "compaction" },
      route: route("retired"),
    }).success,
  ).toBe(false);
});
