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
