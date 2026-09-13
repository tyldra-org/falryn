/** Versioned, provider-bound pricing facts used for estimates and telemetry. */

export const MODEL_PRICING_KINDS = ["published", "published-estimate", "free", "unknown"] as const;
export type ModelPricingKind = (typeof MODEL_PRICING_KINDS)[number];

export const MODEL_BILLING_MODES = ["api", "provider-credit", "free", "unknown"] as const;
export type ModelBillingMode = (typeof MODEL_BILLING_MODES)[number];

export const MODEL_PRICE_TOKEN_UNIT = 1_000_000 as const;

export type ModelTokenPrice = {
  /** Integer USD microunits per one million tokens. Null means unpublished. */
  readonly input: number | null;
  readonly cachedInput: number | null;
  readonly cacheWriteInput: number | null;
  readonly output: number | null;
};

export type ModelPricingUtcWindow = {
  readonly startMinuteInclusive: number;
  readonly endMinuteExclusive: number;
};

export type ModelPricingTier = {
  readonly id: string;
  readonly label: string;
  readonly serviceTier: string | null;
  readonly inputTokensFrom: number;
  readonly inputTokensThrough: number | null;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  /** Empty means every UTC minute. Multiple windows represent a split interval. */
  readonly utcWindows: readonly ModelPricingUtcWindow[];
  readonly usdMicrosPerMillionTokens: ModelTokenPrice;
};

/**
 * Pricing belongs to the provider-bound catalog record, not to a global model
 * name. Generations retain the exact schedule used for a historical estimate.
 */
export type ModelPricing = {
  readonly kind: ModelPricingKind;
  readonly billingMode: ModelBillingMode;
  readonly currency: "USD" | null;
  readonly tokenUnit: typeof MODEL_PRICE_TOKEN_UNIT;
  readonly sourceUrl: string | null;
  readonly observedAt: string | null;
  readonly tiers: readonly ModelPricingTier[];
};

export function unknownModelPricing(): ModelPricing {
  return {
    kind: "unknown",
    billingMode: "unknown",
    currency: null,
    tokenUnit: MODEL_PRICE_TOKEN_UNIT,
    sourceUrl: null,
    observedAt: null,
    tiers: [],
  };
}

import type { ProcessingPrice } from "../../domain/sessions/model-processing.ts";

/** Capture only qualified charge tiers. Null coverage cannot establish a hard cap. */
export function processingPrice(
  pricing: ModelPricing | undefined,
  tierIds: readonly string[] | null,
): ProcessingPrice {
  const unknown: ProcessingPrice = {
    sourceUrl: pricing?.sourceUrl ?? null,
    observedAt: pricing?.observedAt ?? null,
    tierIds: tierIds === null ? [] : [...tierIds],
    inputMicrosPerMillion: null,
    outputMicrosPerMillion: null,
  };
  if (pricing?.kind === "free")
    return { ...unknown, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 };
  if (
    pricing?.kind !== "published" ||
    pricing.currency !== "USD" ||
    pricing.billingMode !== "api" ||
    tierIds === null ||
    tierIds.length === 0
  )
    return unknown;
  const tiers = tierIds.map((id) => pricing.tiers.find((tier) => tier.id === id));
  if (tiers.some((tier) => tier === undefined)) return unknown;
  const input: number[] = [];
  const output: number[] = [];
  for (const tier of tiers) {
    if (!tier) return unknown;
    const rates = tier.usdMicrosPerMillionTokens;
    if (
      Object.values(rates).some((rate) => rate === null || !Number.isSafeInteger(rate) || rate < 0)
    )
      return unknown;
    if (
      rates.input === null ||
      rates.cachedInput === null ||
      rates.cacheWriteInput === null ||
      rates.output === null
    )
      return unknown;
    input.push(rates.input, rates.cachedInput, rates.cacheWriteInput);
    output.push(rates.output);
  }
  return {
    ...unknown,
    inputMicrosPerMillion: Math.max(...input),
    outputMicrosPerMillion: Math.max(...output),
  };
}
