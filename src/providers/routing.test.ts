import { describe, expect, test } from "bun:test";

import { instant } from "../domain/clock.ts";
import { modelId, providerId } from "../domain/identity.ts";
import type { ModelCatalog } from "./discovery.ts";
import { unknownModelCapability } from "./model-capability.ts";
import { providerModelIdentityKey } from "./model-identity.ts";
import {
  DEFAULT_INTENT_ROLE_MAP,
  type ModelPolicy,
  type ReasoningEffort,
  resolveIntentRole,
} from "./policy.ts";
import { parseModelPolicy } from "./policy-schema.ts";
import {
  defaultRequirementsForIntent,
  intentPrefersReasoningEffort,
  reasoningEffortForRoute,
  resolveSpecializedRole,
} from "./role-support.ts";
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
const deterministicDestination = "falryn:deterministic:default";

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
  readonly reasoning?: ReasoningEffort;
}): ModelPolicy {
  const parsed = parseModelPolicy({
    roles: {
      default: {
        providerProfileId: "primary-profile",
        providerId: primary,
        modelId: deep,
        reasoning: overrides?.reasoning ?? "balanced",
        fallbacks: overrides?.withFallback
          ? [{ providerProfileId: "secondary-profile", providerId: secondary, modelId: fast }]
          : [],
        budgets: { attempts: 2 },
      },
      "fast-read": {
        providerProfileId: "primary-profile",
        providerId: primary,
        modelId: fast,
        reasoning: "minimal",
      },
      "fast-edit": {
        providerProfileId: "primary-profile",
        providerId: primary,
        modelId: fast,
        reasoning: "minimal",
      },
      commit: {
        providerProfileId: "primary-profile",
        providerId: primary,
        modelId: deep,
        reasoning: "balanced",
      },
      plan: {
        providerProfileId: "primary-profile",
        providerId: primary,
        modelId: deep,
        reasoning: "balanced",
      },
      vision: {
        providerProfileId: "primary-profile",
        providerId: primary,
        modelId: vision,
        reasoning: "provider-default",
        use: overrides?.visionUse ?? "fallback",
      },
      advisor: {
        providerProfileId: "secondary-profile",
        providerId: secondary,
        modelId: deep,
        use: "explicit",
      },
      compact: {
        providerProfileId: "primary-profile",
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
      profileId: "primary-profile",
      adapterKind: "deterministic",
      destinationId: deterministicDestination,
      requestInputModalities: ["text", "image"],
      requestResponseDensityControls: ["low", "high"],
      catalog: catalogFor([
        {
          schemaVersion: 1,
          modelId: fast,
          displayName: null,
          inputModalities: ["text"],
          outputModalities: ["text"],
          tools: "supported",
          structuredOutput: "supported",
          streaming: "supported",
          reasoning: "unsupported",
          reasoningControls: [],
          completeness: "complete",
          availability: "available",
          provenance: ["profile-declaration"],
          contextTokens: 8_000,
          outputTokens: 2_000,
        },
        {
          schemaVersion: 1,
          modelId: deep,
          displayName: null,
          inputModalities: ["text"],
          outputModalities: ["text"],
          tools: "supported",
          structuredOutput: "supported",
          streaming: "supported",
          reasoning: "supported",
          reasoningControls: ["balanced"],
          responseDensityControls: ["low", "medium"],
          completeness: "complete",
          availability: "available",
          provenance: ["profile-declaration"],
          contextTokens: 128_000,
          outputTokens: 16_000,
        },
        {
          schemaVersion: 1,
          modelId: vision,
          displayName: null,
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
          tools: "supported",
          structuredOutput: "supported",
          streaming: "supported",
          reasoning: "unsupported",
          reasoningControls: [],
          completeness: "complete",
          availability: "available",
          provenance: ["profile-declaration"],
          contextTokens: 64_000,
          outputTokens: 4_000,
        },
        {
          schemaVersion: 1,
          modelId: weak,
          displayName: null,
          inputModalities: ["text"],
          outputModalities: ["text"],
          tools: "unsupported",
          structuredOutput: "unsupported",
          streaming: "unsupported",
          reasoning: "unsupported",
          reasoningControls: [],
          completeness: "complete",
          availability: "available",
          provenance: ["profile-declaration"],
          contextTokens: 1_000,
          outputTokens: 256,
        },
      ]),
    },
    {
      providerId: secondary,
      profileId: "secondary-profile",
      adapterKind: "deterministic",
      destinationId: deterministicDestination,
      requestInputModalities: ["text"],
      catalog: catalogFor(
        [
          {
            schemaVersion: 1,
            modelId: fast,
            displayName: null,
            inputModalities: ["text"],
            outputModalities: ["text"],
            tools: "supported",
            structuredOutput: "supported",
            streaming: "supported",
            reasoning: "unsupported",
            reasoningControls: [],
            completeness: "complete",
            availability: "available",
            provenance: ["profile-declaration"],
            contextTokens: 8_000,
            outputTokens: 2_000,
          },
          {
            schemaVersion: 1,
            modelId: deep,
            displayName: null,
            inputModalities: ["text"],
            outputModalities: ["text"],
            tools: "supported",
            structuredOutput: "supported",
            streaming: "supported",
            reasoning: "supported",
            reasoningControls: ["balanced"],
            completeness: "complete",
            availability: "available",
            provenance: ["profile-declaration"],
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
    expect(resolveIntentRole(policy, "read")).toBe("fast-read");
  });

  test("parseModelPolicy rejects unknown role keys", () => {
    const result = parseModelPolicy({
      roles: {
        default: { providerProfileId: "profile", providerId: "p", modelId: "m" },
        mystery: { providerProfileId: "profile", providerId: "p", modelId: "m" },
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

  test("unknown support fails closed for required features and output constraints", () => {
    const capability = unknownModelCapability(modelId.from("unknown-model"), {
      availability: "available",
    });
    expect(modelMatchesRequirements(capability, {})).toBe(true);
    expect(modelMatchesRequirements(capability, { tools: true })).toBe(false);
    expect(modelMatchesRequirements(capability, { structuredOutput: true })).toBe(false);
    expect(modelMatchesRequirements(capability, { outputModalities: ["text"] })).toBe(false);
    expect(modelMatchesRequirements(capability, { minOutputTokens: 1 })).toBe(false);
  });

  test("checks input, output, and provider-native reasoning controls independently", () => {
    const capability = {
      ...unknownModelCapability(modelId.from("multimodal"), { availability: "available" }),
      inputModalities: ["text", "audio", "video", "document"] as const,
      outputModalities: ["text", "audio"] as const,
      reasoning: "supported" as const,
      reasoningControls: ["low", "high"] as const,
    };

    expect(
      modelMatchesRequirements(capability, {
        modalities: ["audio", "video", "document"],
        outputModalities: ["audio"],
        reasoning: true,
        reasoningControls: ["high"],
      }),
    ).toBe(true);
    expect(modelMatchesRequirements(capability, { outputModalities: ["video"] })).toBe(false);
    expect(modelMatchesRequirements(capability, { reasoningControls: ["medium"] })).toBe(false);
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
    expect(outcome.receipt.providerProfileId).toBe("primary-profile");
    expect(outcome.receipt.providerAdapterKind).toBe("deterministic");
    expect(outcome.receipt.providerDestinationId).toBe(deterministicDestination);
    expect(outcome.receipt.modelId).toBe(deep);
    expect(outcome.receipt.reasoning).toBe("balanced");
    expect(outcome.receipt.reasoningControl).toBe("balanced");
    expect(outcome.receipt.responseDensityControls).toEqual(["low"]);
    expect(outcome.receipt.fallbackPosition).toBe(0);
    expect(outcome.receipt.catalogGeneration).toBe(1);
  });

  test("selects only a cache mechanism shared by the exact model and adapter", () => {
    const googleCatalogs = catalogs().map((entry) =>
      entry.providerId === primary
        ? {
            ...entry,
            adapterKind: "google" as const,
            destinationId: "sha-256:google-default",
            catalog: {
              ...entry.catalog,
              models: entry.catalog.models.map((capability) =>
                capability.modelId === deep
                  ? {
                      ...capability,
                      promptCacheModes: ["implicit-prefix", "google-explicit-resource"] as const,
                      promptCacheMinimumInputTokens: 4096,
                    }
                  : capability,
              ),
            },
          }
        : entry,
    );
    const selected = resolveModelRoute({
      policy: samplePolicy(),
      catalogs: googleCatalogs,
      intent: "coding",
    });
    expect(selected.kind).toBe("selected");
    if (selected.kind !== "selected") {
      return;
    }
    expect(selected.receipt.promptCacheMode).toBe("google-explicit-resource");
    expect(selected.receipt.promptCacheMinimumInputTokens).toBe(4096);

    const incompatible = resolveModelRoute({
      policy: samplePolicy(),
      catalogs: googleCatalogs.map((entry) =>
        entry.providerId === primary ? { ...entry, adapterKind: "openai" as const } : entry,
      ),
      intent: "coding",
    });
    expect(incompatible.kind).toBe("selected");
    if (incompatible.kind === "selected") {
      expect(incompatible.receipt.promptCacheMode).toBeNull();
    }
  });

  test("selects max only when the adapter and model advertise max", () => {
    const maxCatalogs = catalogs().map((entry) =>
      entry.providerId === primary
        ? {
            ...entry,
            adapterKind: "openai" as const,
            destinationId: "sha-256:openai-default",
            catalog: {
              ...entry.catalog,
              models: entry.catalog.models.map((capability) =>
                capability.modelId === deep
                  ? { ...capability, reasoningControls: ["max"] }
                  : capability,
              ),
            },
          }
        : entry,
    );
    const selected = resolveModelRoute({
      policy: samplePolicy({ reasoning: "max" }),
      catalogs: maxCatalogs,
      intent: "coding",
    });
    expect(selected.kind).toBe("selected");
    if (selected.kind !== "selected") {
      return;
    }
    expect(selected.receipt.reasoning).toBe("max");
    expect(selected.receipt.reasoningControl).toBe("max");

    const deepRequest = resolveModelRoute({
      policy: samplePolicy({ reasoning: "deep" }),
      catalogs: maxCatalogs,
      intent: "coding",
    });
    expect(deepRequest.kind).toBe("selected");
    if (deepRequest.kind === "selected") {
      expect(deepRequest.receipt.reasoning).toBe("deep");
      expect(deepRequest.receipt.reasoningControl).toBeNull();
    }

    const unsupported = resolveModelRoute({
      policy: samplePolicy({ reasoning: "max" }),
      catalogs: catalogs(),
      intent: "coding",
    });
    expect(unsupported).toEqual({
      kind: "no-eligible-route",
      role: "default",
      intent: "coding",
      code: "no-compatible-model",
    });
  });

  test("maps portable effort to exact Command Code route controls", () => {
    const commandCodeCatalogs = catalogs().map((entry) =>
      entry.providerId === primary
        ? {
            ...entry,
            adapterKind: "commandcode" as const,
            destinationId: "sha-256:commandcode-default",
            catalog: {
              ...entry.catalog,
              models: entry.catalog.models.map((capability) =>
                capability.modelId === deep
                  ? {
                      ...capability,
                      reasoningControls: ["low", "high", "max"],
                    }
                  : capability,
              ),
            },
          }
        : entry,
    );

    for (const [reasoning, expected] of [
      ["minimal", "low"],
      ["balanced", null],
      ["deep", "high"],
      ["max", "max"],
    ] as const) {
      const selected = resolveModelRoute({
        policy: samplePolicy({ reasoning }),
        catalogs: commandCodeCatalogs,
        intent: "coding",
      });
      expect(selected.kind).toBe("selected");
      if (selected.kind === "selected") {
        expect(selected.receipt.reasoningControl).toBe(expected);
      }
    }
  });

  test("does not route from an expired remote catalog generation", () => {
    const expired = catalogs().map((entry) =>
      entry.providerId === primary
        ? { ...entry, catalog: { ...entry.catalog, expiresAt: instant(10) } }
        : entry,
    );
    const outcome = resolveModelRoute({
      policy: samplePolicy(),
      catalogs: expired,
      intent: "coding",
      now: instant(10),
    });

    expect(outcome).toEqual({
      kind: "no-eligible-route",
      role: "default",
      intent: "coding",
      code: "no-compatible-model",
    });
  });

  test("honors explicit provider/model when compatible", () => {
    const outcome = resolveModelRoute({
      policy: samplePolicy(),
      catalogs: catalogs(),
      intent: "coding",
      explicit: { providerProfileId: "primary-profile", providerId: primary, modelId: fast },
      required: { tools: true },
    });
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    expect(outcome.receipt.selectionReason).toBe("explicit-selection");
    expect(outcome.receipt.modelId).toBe(fast);
  });

  test("selects the exact profile when two profiles expose the same provider model", () => {
    const [primaryCatalog] = catalogs();
    expect(primaryCatalog).toBeDefined();
    if (primaryCatalog === undefined) {
      return;
    }
    const duplicateProfile = {
      ...primaryCatalog,
      profileId: "personal-profile",
      destinationId: "falryn:deterministic:personal",
      catalog: { ...primaryCatalog.catalog, generation: 9 },
    };

    const outcome = resolveModelRoute({
      policy: samplePolicy(),
      catalogs: [primaryCatalog, duplicateProfile],
      intent: "coding",
      explicit: {
        providerProfileId: "personal-profile",
        providerId: primary,
        modelId: deep,
      },
    });

    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    expect(outcome.receipt.providerProfileId).toBe("personal-profile");
    expect(outcome.receipt.providerDestinationId).toBe("falryn:deterministic:personal");
    expect(outcome.receipt.catalogGeneration).toBe(9);
  });

  test("requires provider profile identity in policy configuration", () => {
    const result = parseModelPolicy({
      roles: {
        default: { providerId: primary, modelId: deep },
      },
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "invalid-model-policy", path: "roles.default.providerProfileId" },
    });
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

  test("rejects a model modality the selected adapter cannot transport", () => {
    const textOnly = catalogs().map((entry) =>
      entry.providerId === primary
        ? { ...entry, requestInputModalities: ["text"] as const }
        : entry,
    );
    const outcome = resolveModelRoute({
      policy: samplePolicy(),
      catalogs: textOnly,
      intent: "visualUnderstanding",
      required: { modalities: ["image"] },
    });
    expect(outcome).toEqual({
      kind: "no-eligible-route",
      role: "vision",
      intent: "visualUnderstanding",
      code: "no-compatible-model",
    });
  });

  test("skips incompatible primary and selects ordered fallback", () => {
    // Force primary deep to fail tools? deep has tools. Use required reasoning on
    // a policy whose primary lacks reasoning — re-parse with fast as default.
    const parsed = parseModelPolicy({
      roles: {
        default: {
          providerProfileId: "primary-profile",
          providerId: primary,
          modelId: weak,
          reasoning: "minimal",
          fallbacks: [
            {
              providerProfileId: "secondary-profile",
              providerId: secondary,
              modelId: fast,
            },
          ],
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
      visited: new Set([
        providerModelIdentityKey({
          providerProfileId: "primary-profile",
          providerId: primary,
          modelId: deep,
        }),
      ]),
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

  test("inherits the default route when a standard job role is not overridden", () => {
    const parsed = parseModelPolicy({
      roles: {
        default: { providerProfileId: "primary-profile", providerId: primary, modelId: deep },
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
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    expect(outcome.receipt.role).toBe("plan");
    expect(outcome.receipt.modelId).toBe(deep);
    expect(outcome.receipt.reasoning).toBe("provider-default");
  });
});

describe("specialized role support", () => {
  test("defaultRequirementsForIntent covers fast-edit, read, and vision", () => {
    expect(defaultRequirementsForIntent("fastEdit")).toEqual({
      tools: true,
      streaming: true,
    });
    expect(defaultRequirementsForIntent("read")).toEqual({ streaming: true });
    expect(defaultRequirementsForIntent("visualUnderstanding")).toEqual({
      modalities: ["image"],
    });
    expect(intentPrefersReasoningEffort("planning")).toBe(true);
    expect(intentPrefersReasoningEffort("deepReview")).toBe(true);
    expect(intentPrefersReasoningEffort("fastEdit")).toBe(false);
  });

  test("read and fastEdit map to distinct fast roles with requirement defaults", () => {
    const read = resolveModelRoute({
      policy: samplePolicy(),
      catalogs: catalogs(),
      intent: "read",
    });
    expect(read.kind).toBe("selected");
    if (read.kind !== "selected") {
      return;
    }
    expect(read.receipt.role).toBe("fast-read");
    expect(read.receipt.modelId).toBe(fast);
    expect(read.receipt.requiredCapabilities).toEqual({ streaming: true });
    expect(read.receipt.reasoning).toBe("minimal");

    const edit = resolveModelRoute({
      policy: samplePolicy(),
      catalogs: catalogs(),
      intent: "fastEdit",
    });
    expect(edit.kind).toBe("selected");
    if (edit.kind !== "selected") {
      return;
    }
    expect(edit.receipt.role).toBe("fast-edit");
    expect(edit.receipt.requiredCapabilities).toEqual({ tools: true, streaming: true });
  });

  test("reasoning remains route configuration rather than a model role", () => {
    const deepOutcome = resolveModelRoute({
      policy: samplePolicy(),
      catalogs: catalogs(),
      intent: "deepReview",
    });
    expect(deepOutcome.kind).toBe("selected");
    if (deepOutcome.kind !== "selected") {
      return;
    }
    expect(deepOutcome.receipt.role).toBe("default");
    expect(deepOutcome.receipt.reasoning).toBe("balanced");
    expect(deepOutcome.receipt.requiredCapabilities.reasoning).toBe(true);
    expect(reasoningEffortForRoute(samplePolicy().roles.default)).toBe("balanced");

    const planOutcome = resolveModelRoute({
      policy: samplePolicy(),
      catalogs: catalogs(),
      intent: "planning",
    });
    expect(planOutcome.kind).toBe("selected");
    if (planOutcome.kind !== "selected") {
      return;
    }
    expect(planOutcome.receipt.role).toBe("plan");
    expect(planOutcome.receipt.reasoning).toBe("balanced");
  });

  test("vision use always selects vision for visualUnderstanding", () => {
    const outcome = resolveModelRoute({
      policy: samplePolicy({ visionUse: "always" }),
      catalogs: catalogs(),
      intent: "visualUnderstanding",
    });
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    expect(outcome.receipt.role).toBe("vision");
    expect(outcome.receipt.modelId).toBe(vision);
    expect(outcome.receipt.requiredCapabilities.modalities).toEqual(["image"]);
  });

  test("vision use fallback escalates coding when image modality is required", () => {
    const outcome = resolveModelRoute({
      policy: samplePolicy({ visionUse: "fallback" }),
      catalogs: catalogs(),
      intent: "coding",
      required: { modalities: ["image"] },
    });
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    expect(outcome.receipt.role).toBe("vision");
    expect(outcome.receipt.modelId).toBe(vision);
  });

  test("vision use fallback keeps default when image is not required", () => {
    const outcome = resolveModelRoute({
      policy: samplePolicy({ visionUse: "fallback" }),
      catalogs: catalogs(),
      intent: "coding",
    });
    expect(outcome.kind).toBe("selected");
    if (outcome.kind !== "selected") {
      return;
    }
    expect(outcome.receipt.role).toBe("default");
    expect(outcome.receipt.modelId).toBe(deep);
  });

  test("vision unconfigured fails closed when image is required", () => {
    const parsed = parseModelPolicy({
      roles: {
        default: { providerProfileId: "primary-profile", providerId: primary, modelId: deep },
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
      required: { modalities: ["image"] },
    });
    expect(outcome).toEqual({
      kind: "role-unconfigured",
      role: "vision",
      intent: "coding",
    });
  });

  test("compact evaluated selects for compression and memory", () => {
    for (const intent of ["compression", "memory"] as const) {
      const outcome = resolveModelRoute({
        policy: samplePolicy(),
        catalogs: catalogs(),
        intent,
      });
      expect(outcome.kind).toBe("selected");
      if (outcome.kind !== "selected") {
        return;
      }
      expect(outcome.receipt.role).toBe("compact");
      expect(outcome.receipt.modelId).toBe(fast);
    }
  });

  test("compact use off fails closed", () => {
    const parsed = parseModelPolicy({
      roles: {
        default: { providerProfileId: "primary-profile", providerId: primary, modelId: deep },
        compact: {
          providerProfileId: "primary-profile",
          providerId: primary,
          modelId: fast,
          use: "off",
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
      intent: "compression",
    });
    expect(outcome).toEqual({
      kind: "role-disabled",
      role: "compact",
      intent: "compression",
    });
  });

  test("resolveSpecializedRole demotes vision fallback without image need", () => {
    const specialized = resolveSpecializedRole({
      policy: samplePolicy({ visionUse: "fallback" }),
      role: "vision",
      required: {},
      primaryCapability: {
        schemaVersion: 1,
        modelId: deep,
        displayName: null,
        inputModalities: ["text"],
        outputModalities: ["text"],
        tools: "supported",
        structuredOutput: "supported",
        streaming: "supported",
        reasoning: "supported",
        reasoningControls: ["balanced"],
        completeness: "complete",
        availability: "available",
        provenance: ["profile-declaration"],
        contextTokens: 128_000,
        outputTokens: 16_000,
      },
    });
    // primary lacks image → keep vision under fallback
    expect(specialized.kind).toBe("resolved");
    if (specialized.kind !== "resolved") {
      return;
    }
    expect(specialized.role).toBe("vision");

    const demoted = resolveSpecializedRole({
      policy: samplePolicy({ visionUse: "fallback" }),
      role: "vision",
      required: {},
      primaryCapability: {
        schemaVersion: 1,
        modelId: vision,
        displayName: null,
        inputModalities: ["text", "image"],
        outputModalities: ["text"],
        tools: "supported",
        structuredOutput: "supported",
        streaming: "supported",
        reasoning: "unsupported",
        reasoningControls: [],
        completeness: "complete",
        availability: "available",
        provenance: ["profile-declaration"],
        contextTokens: 64_000,
        outputTokens: 4_000,
      },
    });
    expect(demoted.kind).toBe("resolved");
    if (demoted.kind !== "resolved") {
      return;
    }
    expect(demoted.role).toBe("default");
  });
});
