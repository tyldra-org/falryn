import { describe, expect, test } from "bun:test";

import { modelId, providerId } from "../domain/identity.ts";
import type { ModelCatalog } from "./discovery.ts";
import { DEFAULT_INTENT_ROLE_MAP, type ModelPolicy, resolveIntentRole } from "./policy.ts";
import { parseModelPolicy } from "./policy-schema.ts";
import { WORK_INTENTS } from "./roles.ts";
import {
  modelMatchesRequirements,
  type RoutedCatalogEntry,
  resolveModelRoute,
  resolveNextFallback,
} from "./routing.ts";

const primary = providerId.from("primary");
const secondary = providerId.from("secondary");
const fast = modelId.from("fast-model");
const deep = modelId.from("deep-model");
const vision = modelId.from("vision-model");
const weak = modelId.from("text-only");

function catalogFor(models: ModelCatalog["models"], generation = 1): ModelCatalog {
  return {
    generation,
    provenance: "static-config",
    fetchedAt: null,
    expiresAt: null,
    models,
  };
}

function samplePolicy(overrides?: {
  readonly visionUse?: "fallback" | "always" | "off";
  readonly withFallback?: boolean;
}): ModelPolicy {
  const parsed = parseModelPolicy({
    roles: {
      default: {
        providerId: primary,
        modelId: deep,
        reasoning: "balanced",
        fallbacks: overrides?.withFallback ? [{ providerId: secondary, modelId: fast }] : [],
        budgets: { attempts: 2 },
      },
      fast: {
        providerId: primary,
        modelId: fast,
        reasoning: "minimal",
      },
      deep: {
        providerId: primary,
        modelId: deep,
        reasoning: "deep",
      },
      plan: {
        providerId: primary,
        modelId: deep,
        reasoning: "balanced",
      },
      vision: {
        providerId: primary,
        modelId: vision,
        reasoning: "provider-default",
        use: overrides?.visionUse ?? "fallback",
      },
      advisor: {
        providerId: secondary,
        modelId: deep,
        use: "explicit",
      },
      compact: {
        providerId: primary,
        modelId: fast,
        use: "evaluated",
      },
    },
  });
  if (!parsed.ok) {
    throw new Error(parsed.error.message);
  }
  return parsed.value;
}

function catalogs(): readonly RoutedCatalogEntry[] {
  return [
    {
      providerId: primary,
      catalog: catalogFor([
        {
          modelId: fast,
          modalities: ["text"],
          tools: true,
          streaming: true,
          reasoning: false,
          contextTokens: 8_000,
          outputTokens: 2_000,
        },
        {
          modelId: deep,
          modalities: ["text"],
          tools: true,
          streaming: true,
          reasoning: true,
          contextTokens: 128_000,
          outputTokens: 16_000,
        },
        {
          modelId: vision,
          modalities: ["text", "image"],
          tools: true,
          streaming: true,
          reasoning: false,
          contextTokens: 64_000,
          outputTokens: 4_000,
        },
        {
          modelId: weak,
          modalities: ["text"],
          tools: false,
          streaming: false,
          reasoning: false,
          contextTokens: 1_000,
          outputTokens: 256,
        },
      ]),
    },
    {
      providerId: secondary,
      catalog: catalogFor(
        [
          {
            modelId: fast,
            modalities: ["text"],
            tools: true,
            streaming: true,
            reasoning: false,
            contextTokens: 8_000,
            outputTokens: 2_000,
          },
          {
            modelId: deep,
            modalities: ["text"],
            tools: true,
            streaming: true,
            reasoning: true,
            contextTokens: 200_000,
            outputTokens: 16_000,
          },
        ],
        3,
      ),
    },
  ];
}

describe("model policy", () => {
  test("default intent map covers every work intent", () => {
    for (const intent of WORK_INTENTS) {
      expect(DEFAULT_INTENT_ROLE_MAP[intent]).toBeDefined();
    }
  });

  test("parseModelPolicy fills intent defaults and role budgets", () => {
    const policy = samplePolicy();
    expect(policy.intents).toEqual(DEFAULT_INTENT_ROLE_MAP);
    expect(policy.roles.default.fallbacks).toEqual([]);
    expect(policy.roles.default.budgets.attempts).toBe(2);
    expect(resolveIntentRole(policy, "planning")).toBe("plan");
    expect(resolveIntentRole(policy, "read")).toBe("fast");
  });

  test("parseModelPolicy rejects unknown role keys", () => {
    const result = parseModelPolicy({
      roles: {
        default: { providerId: "p", modelId: "m" },
        mystery: { providerId: "p", modelId: "m" },
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe("invalid-model-policy");
  });
});

describe("compatibility", () => {
  test("modelMatchesRequirements enforces modalities and tools", () => {
    const primaryCatalog = catalogs()[0];
    expect(primaryCatalog).toBeDefined();
    if (primaryCatalog === undefined) {
      return;
    }
    const capability = primaryCatalog.catalog.models.find((m) => m.modelId === weak);
    expect(capability).toBeDefined();
    if (capability === undefined) {
      return;
    }
    expect(modelMatchesRequirements(capability, { tools: true })).toBe(false);
    expect(modelMatchesRequirements(capability, { modalities: ["image"] })).toBe(false);
    expect(modelMatchesRequirements(capability, { modalities: ["text"] })).toBe(true);
  });
});

describe("resolveModelRoute", () => {
  test("maps intent to role and selects primary route", () => {
    const outcome = resolveModelRoute({
      policy: samplePolicy(),
      catalogs: catalogs(),
      intent: "coding",
    });
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    expect(outcome.receipt.role).toBe("default");
    expect(outcome.receipt.intent).toBe("coding");
    expect(outcome.receipt.selectionReason).toBe("intent-mapped-role");
    expect(outcome.receipt.providerId).toBe(primary);
    expect(outcome.receipt.modelId).toBe(deep);
    expect(outcome.receipt.reasoning).toBe("balanced");
    expect(outcome.receipt.fallbackPosition).toBe(0);
    expect(outcome.receipt.catalogGeneration).toBe(1);
  });

  test("honors explicit provider/model when compatible", () => {
    const outcome = resolveModelRoute({
      policy: samplePolicy(),
      catalogs: catalogs(),
      intent: "coding",
      explicit: { providerId: primary, modelId: fast },
      required: { tools: true },
    });
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    expect(outcome.receipt.selectionReason).toBe("explicit-selection");
    expect(outcome.receipt.modelId).toBe(fast);
  });

  test("refuses disabled vision role", () => {
    const outcome = resolveModelRoute({
      policy: samplePolicy({ visionUse: "off" }),
      catalogs: catalogs(),
      intent: "visualUnderstanding",
      required: { modalities: ["image"] },
    });
    expect(outcome).toEqual({
      kind: "role-disabled",
      role: "vision",
      intent: "visualUnderstanding",
    });
  });

  test("skips incompatible primary and selects ordered fallback", () => {
    // Force primary deep to fail tools? deep has tools. Use required reasoning on
    // a policy whose primary lacks reasoning — re-parse with fast as default.
    const parsed = parseModelPolicy({
      roles: {
        default: {
          providerId: primary,
          modelId: weak,
          reasoning: "minimal",
          fallbacks: [{ providerId: secondary, modelId: fast }],
        },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const outcome = resolveModelRoute({
      policy: parsed.value,
      catalogs: catalogs(),
      intent: "coding",
      required: { tools: true, streaming: true },
    });
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    expect(outcome.receipt.selectionReason).toBe("fallback");
    expect(outcome.receipt.fallbackPosition).toBe(1);
    expect(outcome.receipt.providerId).toBe(secondary);
    expect(outcome.receipt.modelId).toBe(fast);
    expect(outcome.receipt.catalogGeneration).toBe(3);
  });

  test("resolveNextFallback never revisits the previous route", () => {
    const policy = samplePolicy({ withFallback: true });
    const first = resolveModelRoute({
      policy,
      catalogs: catalogs(),
      role: "default",
    });
    expect(first.kind).toBe("selected");
    if (first.kind !== "selected") {
      return;
    }
    const second = resolveNextFallback(
      { policy, catalogs: catalogs(), role: "default" },
      first.receipt,
    );
    expect(second.kind).toBe("selected");
    if (second.kind !== "selected") {
      return;
    }
    expect(second.receipt.selectionReason).toBe("fallback");
    expect(second.receipt.providerId).toBe(secondary);
    expect(second.receipt.modelId).toBe(fast);
    expect(second.receipt.fallbackPosition).toBe(1);

    const third = resolveNextFallback(
      { policy, catalogs: catalogs(), role: "default" },
      second.receipt,
    );
    expect(third.kind).toBe("no-eligible-route");
    if (third.kind !== "no-eligible-route") {
      return;
    }
    expect(third.code).toBe("fallback-exhausted");
  });

  test("detects recursive fallback when visited already contains the candidate", () => {
    const policy = samplePolicy({ withFallback: true });
    const outcome = resolveModelRoute({
      policy,
      catalogs: catalogs(),
      role: "default",
      visited: new Set([`${primary}\0${deep}`]),
    });
    expect(outcome.kind).toBe("no-eligible-route");
    if (outcome.kind !== "no-eligible-route") {
      return;
    }
    expect(outcome.code).toBe("fallback-recursion");
  });

  test("reports no-compatible-model when requirements cannot be met", () => {
    const outcome = resolveModelRoute({
      policy: samplePolicy(),
      catalogs: catalogs(),
      intent: "visualUnderstanding",
      required: { modalities: ["audio"] },
    });
    expect(outcome.kind).toBe("no-eligible-route");
    if (outcome.kind !== "no-eligible-route") {
      return;
    }
    expect(outcome.code).toBe("no-compatible-model");
  });

  test("reports role-unconfigured when optional role is missing", () => {
    const parsed = parseModelPolicy({
      roles: {
        default: { providerId: primary, modelId: deep },
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const outcome = resolveModelRoute({
      policy: parsed.value,
      catalogs: catalogs(),
      intent: "planning",
    });
    expect(outcome).toEqual({
      kind: "role-unconfigured",
      role: "plan",
      intent: "planning",
    });
  });
});
