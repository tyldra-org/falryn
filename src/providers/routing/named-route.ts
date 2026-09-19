/** Pure route admission producer. It neither probes accounts nor performs attempt transitions. */
import { z } from "zod";
import {
  processingPreferenceSchema,
  resolveProcessingPreference,
} from "../../domain/sessions/model-processing.ts";
import {
  MODEL_INPUT_MODALITIES,
  MODEL_OUTPUT_MODALITIES,
  type ModelCapability,
} from "../catalog/model-capability.ts";
import {
  type NamedRouteCandidate,
  type NamedRouteDefinition,
  namedRouteCandidateSchema,
  namedRouteDefinitionSchema,
} from "../configuration/named-route.ts";
import { REASONING_EFFORTS, type ReasoningEffort } from "../configuration/policy.ts";

export type RouteCandidateFacts = {
  readonly target: NamedRouteCandidate;
  readonly revision: number;
  readonly accountGeneration: string;
  readonly catalogGeneration: number;
  readonly destinationId: string;
  readonly transportId: string;
  readonly credential: "declared" | "missing" | "revoked";
  readonly lifecycle: "active" | "paused" | "draining";
  readonly trusted: boolean;
  readonly allowed: boolean;
  readonly disclosures: readonly string[];
  readonly capability: ModelCapability | null;
  readonly reasoning: readonly ReasoningEffort[];
  readonly quota: "available" | "exhausted" | "unknown" | "stale";
  readonly quotaPool?: string;
  readonly waitMs?: number;
  readonly includedEnforced: boolean;
  readonly maximumCostMicros: number | null;
  readonly fast: "supported" | "unsupported" | "unknown";
  readonly standard: "supported" | "unsupported" | "unknown";
};
export const routeEvaluationSchema = z.strictObject({
  required: z
    .strictObject({
      modalities: z.array(z.enum(MODEL_INPUT_MODALITIES)).max(5).readonly().optional(),
      outputModalities: z.array(z.enum(MODEL_OUTPUT_MODALITIES)).max(4).readonly().optional(),
      tools: z.boolean().optional(),
      structuredOutput: z.boolean().optional(),
      streaming: z.boolean().optional(),
      reasoning: z.boolean().optional(),
      reasoningControls: z.array(z.string().max(128)).max(32).readonly().optional(),
      minContextTokens: z.number().int().nonnegative().optional(),
      minOutputTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  reasoning: z.enum(REASONING_EFFORTS).optional(),
  processing: processingPreferenceSchema.optional(),
  sensitivity: z.enum(["public", "user-content", "sensitive"]).optional(),
  current: namedRouteCandidateSchema.optional(),
  remainingMs: z.number().int().nonnegative().optional(),
  remainingCostMicros: z.number().int().nonnegative().optional(),
});
export type NamedRouteRequest = z.infer<typeof routeEvaluationSchema> & {
  readonly configurationGeneration: number;
  readonly factsRevision: number;
};
const candidateReceiptSchema = z.strictObject({
  target: namedRouteCandidateSchema,
  factsRevision: z.number().int().nonnegative(),
  accountGeneration: z.string().max(256),
  catalogGeneration: z.number().int().nonnegative(),
  destinationId: z.string().max(4096),
  transportId: z.string().max(256),
  waitMs: z.number().int().nonnegative(),
  uncertainty: z
    .array(z.enum(["quota-unknown", "quota-stale", "price-unknown", "availability-unknown"]))
    .max(4),
  costGuarantee: z.enum(["provider-enforced", "locally-bounded", "unknown"]),
});
export const namedRouteReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  routeId: z.string().max(128),
  definitionRevision: z.number().int().nonnegative(),
  configurationGeneration: z.number().int().nonnegative(),
  factsRevision: z.number().int().nonnegative(),
  definition: namedRouteDefinitionSchema,
  evaluation: routeEvaluationSchema,
  processing: processingPreferenceSchema.required(),
  eligible: z.array(candidateReceiptSchema).max(17),
  exclusions: z
    .array(
      z.strictObject({
        target: namedRouteCandidateSchema,
        reasons: z.array(z.string().max(128)).max(64),
      }),
    )
    .max(17),
});
export type NamedRouteReceipt = z.infer<typeof namedRouteReceiptSchema>;
export type NamedRouteResolution =
  | { readonly kind: "resolved"; readonly receipt: NamedRouteReceipt }
  | {
      readonly kind: "unresolved";
      readonly code: "route-missing" | "route-unavailable";
      readonly receipt: NamedRouteReceipt | null;
    };
export function routeCandidateKey(target: NamedRouteCandidate): string {
  return JSON.stringify([
    target.connectionId,
    target.providerId,
    target.modelId,
    target.variant ?? null,
  ]);
}
export function freezeRouteValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeRouteValue(child);
    Object.freeze(value);
  }
  return value;
}

/** Unknown facts stay unknown. Safety/auth failures are never fallback triggers. */
export function resolveNamedRoute(
  definition: NamedRouteDefinition | undefined,
  facts: readonly RouteCandidateFacts[],
  request: NamedRouteRequest,
): NamedRouteResolution {
  if (!definition) return { kind: "unresolved", code: "route-missing", receipt: null };
  const policy = definition.policy;
  const processing = resolveProcessingPreference([request.processing]);
  const eligible: NamedRouteReceipt["eligible"] = [];
  const exclusions: NamedRouteReceipt["exclusions"] = [];
  const seen = new Set<string>();
  for (const [index, target] of [definition.primary, ...definition.alternatives].entries()) {
    const key = routeCandidateKey(target);
    const reasons: string[] = [];
    if (seen.has(key)) reasons.push("duplicate-target");
    seen.add(key);
    if (policy.strategy === "strict-target" && index !== 0) reasons.push("strict-target");
    const fact = facts.find((entry) => routeCandidateKey(entry.target) === key);
    if (!fact) reasons.push("target-facts-missing");
    else {
      if (fact.credential !== "declared") reasons.push(`credential-${fact.credential}`);
      if (fact.lifecycle !== "active") reasons.push(`account-${fact.lifecycle}`);
      if (!fact.allowed) reasons.push("profile-policy-denied");
      if (policy.trustedOnly && !fact.trusted) reasons.push("destination-untrusted");
      if (policy.requiredDisclosures.some((value) => !fact.disclosures.includes(value)))
        reasons.push("disclosure-unaccepted");
      const levels = ["public", "user-content", "sensitive"];
      if (
        levels.indexOf(request.sensitivity ?? "user-content") >
        levels.indexOf(policy.maxSensitivity)
      )
        reasons.push("sensitivity-denied");
      if (!fact.destinationId || !fact.transportId) reasons.push("transport-unqualified");
      const exhausted =
        fact.quota === "exhausted" ||
        (fact.quotaPool !== undefined &&
          facts.some((other) => other.quotaPool === fact.quotaPool && other.quota === "exhausted"));
      if (
        exhausted &&
        !(
          policy.strategy === "prefer-current" &&
          request.current &&
          routeCandidateKey(request.current) === key &&
          fact.waitMs !== undefined &&
          fact.waitMs <= Math.min(policy.maxWaitMs, request.remainingMs ?? 0)
        )
      )
        reasons.push("quota-exhausted");
      if (policy.billing === "included-only" && !fact.includedEnforced)
        reasons.push("included-allowance-not-enforced");
      const cap = Math.min(
        policy.maxCostMicros ?? Infinity,
        request.remainingCostMicros ?? Infinity,
      );
      if (cap !== Infinity && fact.maximumCostMicros === null)
        reasons.push("price-unknown-for-cost-cap");
      else if (fact.maximumCostMicros !== null && fact.maximumCostMicros > cap)
        reasons.push("cost-cap-exceeded");
      // Processing fallback is deliberately not permission to move to another account.
      if (processing.mode === "fast") {
        if (!policy.allowPremiumProcessing) reasons.push("premium-processing-not-approved");
        if (fact.fast !== "supported") reasons.push("fast-not-qualified");
      }
      if (processing.mode === "standard" && fact.standard !== "supported")
        reasons.push("standard-not-qualified");
      const model = fact.capability;
      if (!model || String(model.modelId) !== target.modelId) reasons.push("model-unqualified");
      else {
        if (model.availability === "unavailable") reasons.push("model-unavailable");
        const required = request.required ?? {};
        for (const feature of ["tools", "streaming", "reasoning", "structuredOutput"] as const)
          if (required[feature] && model[feature] !== "supported")
            reasons.push(`${feature}-unsupported`);
        for (const modality of required.modalities ?? [])
          if (!model.inputModalities.includes(modality))
            reasons.push(`input-${modality}-unsupported`);
        for (const modality of required.outputModalities ?? [])
          if (!model.outputModalities.includes(modality))
            reasons.push(`output-${modality}-unsupported`);
        if (
          required.minContextTokens !== undefined &&
          (model.contextTokens === null || model.contextTokens < required.minContextTokens)
        )
          reasons.push("context-capacity-insufficient");
        if (
          required.minOutputTokens !== undefined &&
          (model.outputTokens === null || model.outputTokens < required.minOutputTokens)
        )
          reasons.push("output-capacity-insufficient");
        if (
          required.reasoningControls?.some((control) => !model.reasoningControls.includes(control))
        )
          reasons.push("thinking-control-unsupported");
        if (
          request.reasoning &&
          request.reasoning !== "provider-default" &&
          !fact.reasoning.includes(request.reasoning)
        )
          reasons.push("thinking-effort-unsupported");
      }
      if (reasons.length === 0)
        eligible.push({
          target: { ...target },
          factsRevision: fact.revision,
          accountGeneration: fact.accountGeneration,
          catalogGeneration: fact.catalogGeneration,
          destinationId: fact.destinationId,
          transportId: fact.transportId,
          waitMs: exhausted ? (fact.waitMs ?? 0) : 0,
          uncertainty: [
            ...(fact.quota === "unknown" ? ["quota-unknown" as const] : []),
            ...(fact.quota === "stale" ? ["quota-stale" as const] : []),
            ...(fact.maximumCostMicros === null ? ["price-unknown" as const] : []),
            ...(model?.availability === "unknown" ? ["availability-unknown" as const] : []),
          ],
          costGuarantee:
            policy.billing === "included-only"
              ? "provider-enforced"
              : fact.maximumCostMicros !== null
                ? "locally-bounded"
                : "unknown",
        });
    }
    if (reasons.length > 0) exclusions.push({ target: { ...target }, reasons });
  }
  if (policy.strategy === "prefer-current" && request.current) {
    const current = routeCandidateKey(request.current);
    eligible.sort(
      (a, b) =>
        Number(routeCandidateKey(b.target) === current) -
        Number(routeCandidateKey(a.target) === current),
    );
  } else if (policy.strategy === "prefer-availability") {
    eligible.sort(
      (a, b) =>
        Number(a.uncertainty.some((value) => value.startsWith("quota-"))) -
        Number(b.uncertainty.some((value) => value.startsWith("quota-"))),
    );
  }
  const receipt = freezeRouteValue(
    structuredClone({
      schemaVersion: 1 as const,
      routeId: definition.id,
      definitionRevision: definition.revision,
      configurationGeneration: request.configurationGeneration,
      factsRevision: request.factsRevision,
      definition,
      evaluation: routeEvaluationSchema.parse(
        Object.fromEntries(
          Object.entries(request).filter(
            ([key]) => key !== "configurationGeneration" && key !== "factsRevision",
          ),
        ),
      ),
      processing,
      eligible,
      exclusions,
    }),
  );
  return eligible.length > 0
    ? { kind: "resolved", receipt }
    : { kind: "unresolved", code: "route-unavailable", receipt };
}

/** Handoff only: #215 owns effect checks, shared reservations, waits and real attempt transitions. */
export function qualifiedRouteAlternatives(
  receipt: NamedRouteReceipt,
  trigger: string,
  attempt: number,
): readonly NamedRouteReceipt["eligible"][number][] {
  if (
    !receipt.definition.policy.triggers.some((value) => value === trigger) ||
    attempt >= receipt.definition.policy.maxAttempts
  )
    return [];
  return receipt.eligible.slice(1);
}
