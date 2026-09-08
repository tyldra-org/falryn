import { expect, test } from "bun:test";
import { modelId, providerId } from "../../domain/foundation/index.ts";
import { previewModelPolicyMigration } from "./policy-migration.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  modelPreferencesSchema,
  roleRouteBaseSchema,
} from "./policy-schema.ts";

const route = (modelId: string) =>
  roleRouteBaseSchema.parse({ providerProfileId: "account", providerId: "test", modelId });
const legacy = {
  roles: {
    default: route("old-main"),
    compact: {
      ...route("compact"),
      reasoning: "deep",
      use: "off",
      fallbacks: [
        {
          providerProfileId: "other",
          providerId: providerId.from("test"),
          modelId: modelId.from("fallback"),
        },
      ],
      budgets: { attempts: 2 },
    },
    "fast-read": route("old-read"),
    "fast-edit": route("old-edit"),
    commit: route("old-commit"),
  },
};

test("migration preserves the original, main route, exact fallback/thinking/use, and reports four retirements", () => {
  const current = modelPreferencesSchema.parse({
    ...EMPTY_MODEL_PREFERENCES,
    roles: { default: route("main") },
  });
  const preview = previewModelPolicyMigration(legacy, current);
  expect(preview.kind).toBe("preview");
  if (preview.kind !== "preview") return;
  expect(preview.original).toEqual(legacy);
  expect(preview.unresolved).toEqual([]);
  expect(preview.candidate.roles.default?.modelId).toBe(modelId.from("main"));
  expect(preview.candidate.roles.fast?.default).toBeUndefined();
  for (const option of ["memory", "compaction"] as const) {
    expect(preview.candidate.roles.fast?.options?.[option]?.modelId).toBe(modelId.from("compact"));
    expect(preview.candidate.roles.fast?.options?.[option]?.reasoning).toBe("deep");
    expect(preview.candidate.roles.fast?.options?.[option]?.fallbacks).toEqual(
      legacy.roles.compact.fallbacks,
    );
    expect(preview.candidate.roles.fast?.use?.[option]).toBe("off");
  }
  expect(preview.changes.filter((change) => change.kind === "retired")).toHaveLength(3);
  expect(preview.changes.some((change) => change.path === "roles.fast.options.compaction")).toBe(
    true,
  );
  expect(current.roles.fast).toBeUndefined();
});
test("custom memory/compression maps preserve their old effective route and custom ordinary maps need a decision", () => {
  const source = {
    ...legacy,
    roles: { ...legacy.roles, plan: route("plan") },
    intents: { memory: "plan", compression: "default", read: "plan" },
  };
  const preview = previewModelPolicyMigration(source, EMPTY_MODEL_PREFERENCES);
  if (preview.kind !== "preview") throw new Error("Expected preview");
  expect(preview.unresolved).toEqual(["intents.read"]);
  expect(preview.candidate.roles.fast?.options?.memory?.modelId).toBe(modelId.from("plan"));
  expect(preview.candidate.roles.fast?.options?.compaction?.modelId).toBe(modelId.from("old-main"));
  const accepted = previewModelPolicyMigration(source, EMPTY_MODEL_PREFERENCES, {
    "intents.read": "normalize",
  });
  expect(accepted.kind === "preview" && accepted.unresolved).toEqual([]);
});
test("conflicts never discard current choices without an explicit decision", () => {
  const current = modelPreferencesSchema.parse({
    ...EMPTY_MODEL_PREFERENCES,
    roles: { fast: { options: { memory: route("new-memory") }, use: { memory: "evaluated" } } },
  });
  const preview = previewModelPolicyMigration(legacy, current);
  if (preview.kind !== "preview") throw new Error("Expected preview");
  expect(preview.unresolved).toContain("roles.fast.options.memory");
  expect(preview.candidate.roles.fast?.options?.memory?.modelId).toBe(modelId.from("new-memory"));
  const accepted = previewModelPolicyMigration(legacy, current, {
    "roles.fast.options.memory": "use-legacy",
  });
  expect(
    accepted.kind === "preview" && accepted.candidate.roles.fast?.options?.memory?.modelId,
  ).toBe(modelId.from("compact"));
  const retained = previewModelPolicyMigration(legacy, current, {
    "roles.fast.options.memory": "keep-current",
  });
  expect(retained.kind === "preview" && retained.candidate.roles.fast?.use?.memory).toBe(
    "evaluated",
  );
});
test("unconfigured legacy helpers remain disabled and proposed nested groups move independently", () => {
  const preview = previewModelPolicyMigration(
    {
      roles: {
        default: route("old"),
        fast: {
          default: route("fast"),
          subagents: {
            default: route("agents"),
            agents: { "user:custom": { route: route("custom") } },
          },
          workflows: { default: route("workflow") },
        },
      },
    },
    EMPTY_MODEL_PREFERENCES,
  );
  if (preview.kind !== "preview") throw new Error("Expected preview");
  expect(preview.candidate.roles.fast?.use).toEqual({ compaction: "off", memory: "off" });
  expect(preview.candidate.roles.subagents?.default?.modelId).toBe(modelId.from("agents"));
  expect(preview.candidate.roles.subagents?.agents?.["user:custom"]?.route?.modelId).toBe(
    modelId.from("custom"),
  );
  expect(preview.candidate.roles.workflows?.default?.modelId).toBe(modelId.from("workflow"));
  expect(
    modelPreferencesSchema.safeParse({
      ...EMPTY_MODEL_PREFERENCES,
      roles: { fast: { subagents: {} } },
    }).success,
  ).toBe(false);
});

test("development Fast options retain their route and enablement without inheriting compact defaults", () => {
  const preview = previewModelPolicyMigration(
    {
      roles: {
        default: route("main"),
        fast: {
          default: route("cheap"),
          options: { memory: route("memory") },
          use: { memory: "evaluated", compaction: "off" },
        },
      },
    },
    EMPTY_MODEL_PREFERENCES,
  );
  if (preview.kind !== "preview") throw new Error("Expected preview");
  expect(preview.unresolved).toEqual([]);
  expect(String(preview.candidate.roles.fast?.options?.memory?.modelId)).toBe("memory");
  expect(preview.candidate.roles.fast?.use).toEqual({ memory: "evaluated", compaction: "off" });
  expect(preview.candidate.roles.subagents).toBeUndefined();
});
