/** Command Code rates observed from its official pricing table on 2026-08-29. */

import {
  type ModelPricing,
  type ModelPricingTier,
  type ModelPricingUtcWindow,
  unknownModelPricing,
} from "../../model-pricing.ts";

const SOURCE_URL = "https://commandcode.ai/docs/resources/pricing-limits";
const OBSERVED_AT = "2026-08-29T00:00:00Z";

type RateInput = {
  readonly input: number;
  readonly output: number;
  readonly cachedInput?: number;
  readonly cacheWriteInput?: number;
};

type TierOptions = {
  readonly label?: string;
  readonly inputTokensFrom?: number;
  readonly inputTokensThrough?: number | null;
  readonly effectiveFrom?: string | null;
  readonly effectiveUntil?: string | null;
  readonly utcWindows?: readonly ModelPricingUtcWindow[];
};

const usdMicros = (dollars: number): number => Math.round(dollars * 1_000_000);

function tier(id: string, rates: RateInput, options: TierOptions = {}): ModelPricingTier {
  return {
    id,
    label: options.label ?? id,
    serviceTier: "standard",
    inputTokensFrom: options.inputTokensFrom ?? 0,
    inputTokensThrough: options.inputTokensThrough ?? null,
    effectiveFrom: options.effectiveFrom ?? null,
    effectiveUntil: options.effectiveUntil ?? null,
    utcWindows: options.utcWindows ?? [],
    usdMicrosPerMillionTokens: {
      input: usdMicros(rates.input),
      cachedInput: rates.cachedInput === undefined ? null : usdMicros(rates.cachedInput),
      cacheWriteInput:
        rates.cacheWriteInput === undefined ? null : usdMicros(rates.cacheWriteInput),
      output: usdMicros(rates.output),
    },
  };
}

function published(...tiers: readonly ModelPricingTier[]): ModelPricing {
  return {
    // Command Code documents that routed open-model prices may vary by upstream.
    kind: "published-estimate",
    billingMode: "provider-credit",
    currency: "USD",
    tokenUnit: 1_000_000,
    sourceUrl: SOURCE_URL,
    observedAt: OBSERVED_AT,
    tiers,
  };
}

function free(...tiers: readonly ModelPricingTier[]): ModelPricing {
  return {
    kind: "free",
    billingMode: "free",
    currency: "USD",
    tokenUnit: 1_000_000,
    sourceUrl: SOURCE_URL,
    observedAt: OBSERVED_AT,
    tiers,
  };
}

const SHORT_272K = { label: "Short context", inputTokensThrough: 272_000 } as const;
const LONG_272K = { label: "Long context", inputTokensFrom: 272_001 } as const;
const PEAK_UTC: readonly ModelPricingUtcWindow[] = [
  { startMinuteInclusive: 60, endMinuteExclusive: 240 },
  { startMinuteInclusive: 360, endMinuteExclusive: 600 },
];
const OFF_PEAK_UTC: readonly ModelPricingUtcWindow[] = [
  { startMinuteInclusive: 0, endMinuteExclusive: 60 },
  { startMinuteInclusive: 240, endMinuteExclusive: 360 },
  { startMinuteInclusive: 600, endMinuteExclusive: 1_440 },
];
const TIME_PRICING_EFFECTIVE = "2026-08-16T16:00:00Z";

const COMMAND_CODE_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-sonnet-5": published(
    tier("standard", { input: 2, output: 10, cachedInput: 0.2, cacheWriteInput: 2.5 }),
  ),
  "claude-sonnet-4-6": published(
    tier("standard", { input: 3, output: 15, cachedInput: 0.3, cacheWriteInput: 3.75 }),
  ),
  "claude-fable-5": published(
    tier("standard", { input: 10, output: 50, cachedInput: 1, cacheWriteInput: 12.5 }),
  ),
  "claude-opus-5": published(
    tier("standard", { input: 5, output: 25, cachedInput: 0.5, cacheWriteInput: 6.25 }),
  ),
  "claude-opus-4-8": published(
    tier("standard", { input: 5, output: 25, cachedInput: 0.5, cacheWriteInput: 6.25 }),
  ),
  "claude-opus-4-7": published(
    tier("standard", { input: 5, output: 25, cachedInput: 0.5, cacheWriteInput: 6.25 }),
  ),
  "claude-haiku-4-5-20251001": published(
    tier("standard", { input: 1, output: 5, cachedInput: 0.1, cacheWriteInput: 1.25 }),
  ),

  "gpt-5.6-sol": published(
    tier(
      "standard-short",
      { input: 5, output: 30, cachedInput: 0.5, cacheWriteInput: 6.25 },
      SHORT_272K,
    ),
    tier(
      "standard-long",
      { input: 10, output: 45, cachedInput: 1, cacheWriteInput: 12.5 },
      LONG_272K,
    ),
  ),
  "gpt-5.6-terra": published(
    tier(
      "standard-short",
      { input: 2, output: 12, cachedInput: 0.2, cacheWriteInput: 2.5 },
      SHORT_272K,
    ),
    tier(
      "standard-long",
      { input: 4, output: 18, cachedInput: 0.4, cacheWriteInput: 5 },
      LONG_272K,
    ),
  ),
  "gpt-5.6-luna": published(
    tier(
      "standard-short",
      { input: 0.2, output: 1.2, cachedInput: 0.02, cacheWriteInput: 0.25 },
      SHORT_272K,
    ),
    tier(
      "standard-long",
      { input: 0.4, output: 1.8, cachedInput: 0.04, cacheWriteInput: 0.5 },
      LONG_272K,
    ),
  ),
  "gpt-5.5": published(
    tier("standard", { input: 5, output: 30, cachedInput: 0.5, cacheWriteInput: 0 }),
  ),
  "gpt-5.4": published(
    tier("standard", { input: 2.5, output: 15, cachedInput: 0.25, cacheWriteInput: 0 }),
  ),
  "gpt-5.3-codex": published(
    tier("standard", { input: 2, output: 8, cachedInput: 0.5, cacheWriteInput: 0 }),
  ),
  "gpt-5.4-mini": published(
    tier("standard", { input: 0.75, output: 4.5, cachedInput: 0.075, cacheWriteInput: 0 }),
  ),

  "deepseek/deepseek-v4-pro": published(
    tier(
      "off-peak",
      { input: 0.66, output: 1.98, cachedInput: 0.022 },
      { effectiveFrom: TIME_PRICING_EFFECTIVE, utcWindows: OFF_PEAK_UTC },
    ),
    tier(
      "peak",
      { input: 1.32, output: 3.96, cachedInput: 0.044 },
      { effectiveFrom: TIME_PRICING_EFFECTIVE, utcWindows: PEAK_UTC },
    ),
  ),
  "deepseek/deepseek-v4-flash": published(
    tier(
      "off-peak",
      { input: 0.22, output: 0.66, cachedInput: 0.007 },
      { effectiveFrom: TIME_PRICING_EFFECTIVE, utcWindows: OFF_PEAK_UTC },
    ),
    tier(
      "peak",
      { input: 0.44, output: 1.32, cachedInput: 0.014 },
      { effectiveFrom: TIME_PRICING_EFFECTIVE, utcWindows: PEAK_UTC },
    ),
  ),
  "deepseek/deepseek-v4-flash-vision-exp": published(
    tier(
      "off-peak",
      { input: 0.22, output: 0.66, cachedInput: 0.007 },
      { effectiveFrom: TIME_PRICING_EFFECTIVE, utcWindows: OFF_PEAK_UTC },
    ),
    tier(
      "peak",
      { input: 0.44, output: 1.32, cachedInput: 0.014 },
      { effectiveFrom: TIME_PRICING_EFFECTIVE, utcWindows: PEAK_UTC },
    ),
  ),

  "moonshotai/Kimi-K3": published(tier("standard", { input: 3, output: 15, cachedInput: 0.3 })),
  "moonshotai/Kimi-K2.7-Code": published(
    tier("standard", { input: 0.95, output: 4, cachedInput: 0.19 }),
  ),
  "moonshotai/Kimi-K2.7-Code-Highspeed": published(
    tier("standard", { input: 1.9, output: 8, cachedInput: 0.38 }),
  ),
  "moonshotai/Kimi-K2.6": published(
    tier("standard", { input: 0.95, output: 4, cachedInput: 0.16 }),
  ),
  "moonshotai/Kimi-K2.5": published(tier("standard", { input: 0.6, output: 3, cachedInput: 0.1 })),

  "z-ai/glm-5.3-flash": published(
    tier("standard", { input: 0.15, output: 0.5, cachedInput: 0.03 }),
  ),
  "zai-org/GLM-5.3": published(tier("standard", { input: 1.4, output: 4.4, cachedInput: 0.26 })),
  "zai-org/GLM-5.2": published(tier("standard", { input: 1.4, output: 4.4, cachedInput: 0.26 })),
  "zai-org/GLM-5.2-Fast": published(
    tier("standard", { input: 3, output: 10.25, cachedInput: 0.5 }),
  ),
  "zai-org/GLM-5.1": published(tier("standard", { input: 1.4, output: 4.4, cachedInput: 0.26 })),
  "zai-org/GLM-5": published(tier("standard", { input: 1, output: 3.2, cachedInput: 0.2 })),

  "MiniMaxAI/MiniMax-M3": published(
    tier(
      "standard",
      { input: 0.3, output: 1.2, cachedInput: 0.06 },
      { label: "Standard context", inputTokensThrough: 512_000 },
    ),
    tier(
      "long",
      { input: 0.3, output: 1.2, cachedInput: 0.06 },
      { label: "Long context", inputTokensFrom: 512_001 },
    ),
  ),
  "MiniMaxAI/MiniMax-M2.7": published(
    tier("standard", { input: 0.3, output: 1.2, cachedInput: 0.06 }),
  ),
  "minimax/minimax-m3-free": free(
    tier(
      "free",
      { input: 0, output: 0, cachedInput: 0 },
      { effectiveUntil: "2026-09-06T00:00:00Z" },
    ),
  ),
  "minimax/minimax-m2.7-free": free(
    tier(
      "free",
      { input: 0, output: 0, cachedInput: 0 },
      { effectiveUntil: "2026-09-06T00:00:00Z" },
    ),
  ),
  "MiniMaxAI/MiniMax-M2.5": published(
    tier("standard", { input: 0.3, output: 1.2, cachedInput: 0.03 }),
  ),
  "xiaomi/mimo-v2.5-pro": published(
    tier("standard", { input: 0.435, output: 0.87, cachedInput: 0.0036 }),
  ),
  "xiaomi/mimo-v2.5": published(
    tier("standard", { input: 0.14, output: 0.28, cachedInput: 0.0028 }),
  ),

  "Qwen/Qwen3.8-Max": published(
    tier("standard", { input: 2, output: 6, cachedInput: 0.25, cacheWriteInput: 2.5 }),
  ),
  "Qwen/Qwen3.8-27B": published(tier("standard", { input: 0.4, output: 3, cachedInput: 0.04 })),
  "Qwen/Qwen3.8-Flash": published(
    tier("standard", { input: 0.16, output: 0.47, cachedInput: 0.016 }),
  ),
  "Qwen/Qwen3.7-Max": published(
    tier("standard", { input: 2.5, output: 7.5, cachedInput: 0.5, cacheWriteInput: 3.13 }),
  ),
  "Qwen/Qwen3.7-Plus": published(
    tier(
      "standard",
      { input: 0.4, output: 1.6, cachedInput: 0.08, cacheWriteInput: 0.5 },
      { label: "Standard context", inputTokensThrough: 256_000 },
    ),
    tier(
      "long",
      { input: 1.2, output: 4.8, cachedInput: 0.24, cacheWriteInput: 1.5 },
      { label: "Long context", inputTokensFrom: 256_001 },
    ),
  ),
  "Qwen/Qwen3.7-Flash": published(
    tier(
      "standard",
      { input: 0.03, output: 0.13, cachedInput: 0.006, cacheWriteInput: 0.038 },
      { inputTokensThrough: 32_000 },
    ),
    tier(
      "extended",
      { input: 0.1, output: 0.4, cachedInput: 0.02, cacheWriteInput: 0.125 },
      { inputTokensFrom: 32_001, inputTokensThrough: 256_000 },
    ),
    tier(
      "long",
      { input: 0.2, output: 0.8, cachedInput: 0.04, cacheWriteInput: 0.25 },
      { inputTokensFrom: 256_001 },
    ),
  ),
  "Qwen/Qwen3.6-Max-Preview": published(
    tier("standard", { input: 1.3, output: 7.8, cachedInput: 0.26, cacheWriteInput: 1.63 }),
  ),
  "Qwen/Qwen3.6-Plus": published(
    tier("standard", { input: 0.5, output: 3, cachedInput: 0.1 }, { inputTokensThrough: 256_000 }),
    tier("long", { input: 2, output: 6, cachedInput: 0.2 }, { inputTokensFrom: 256_001 }),
  ),

  "stepfun/Step-3.7-Flash": published(
    tier("standard", { input: 0.2, output: 1.15, cachedInput: 0.04 }),
  ),
  "stepfun/Step-3.5-Flash": published(
    tier("standard", { input: 0.1, output: 0.3, cachedInput: 0.02 }),
  ),
  "tencent/hy3-paid": published(
    tier("standard", { input: 0.14, output: 0.58, cachedInput: 0.035 }),
  ),
  "tencent/hy4-preview": published(
    tier("standard", { input: 0.834, output: 2.501, cachedInput: 0.042 }),
  ),

  "google/gemini-3.7-flash": published(
    tier(
      "standard",
      { input: 0.75, output: 3.75, cachedInput: 0.075, cacheWriteInput: 0.04167 },
      { effectiveUntil: "2027-01-01T00:00:00Z" },
    ),
  ),
  "google/gemini-3.6-flash": published(
    tier("standard", { input: 1.5, output: 7.5, cachedInput: 0.15 }),
  ),
  "google/gemini-3.5-flash": published(
    tier("standard", { input: 1.5, output: 9, cachedInput: 0.15 }),
  ),
  "google/gemini-3.5-flash-lite": published(
    tier("standard", { input: 0.3, output: 2.5, cachedInput: 0.03 }),
  ),
  "google/gemini-3.1-flash-lite": published(
    tier("standard", { input: 0.25, output: 1.5, cachedInput: 0.03 }),
  ),
  "sakana/fugu-ultra": published(tier("standard", { input: 5, output: 30, cachedInput: 0.5 })),
  "nvidia/nemotron-3-ultra-550b-a55b": published(
    tier("standard", { input: 0.6, output: 2.4, cachedInput: 0.12 }),
  ),
  "thinkingmachines/inkling": published(
    tier("standard", { input: 1, output: 4.05, cachedInput: 0.17 }),
  ),
  "thinkingmachines/inkling-small": published(
    tier("standard", { input: 0.5, output: 1.2, cachedInput: 0.1 }),
  ),
  "poolside/laguna-s-2.1-free": free(tier("free", { input: 0, output: 0, cachedInput: 0 })),
  "meta/muse-spark-1.1": published(
    tier("standard", { input: 1.25, output: 4.25, cachedInput: 0.15 }),
  ),
  "meta/muse-spark-1.2": published(
    tier("standard", { input: 1.25, output: 4.25, cachedInput: 0.15 }),
  ),
  "meta/muse-spark-1.2-contributor": published(
    tier("standard", { input: 0.1, output: 0.2, cachedInput: 0.002 }),
  ),
  "xai/grok-4.5": published(tier("standard", { input: 2, output: 6, cachedInput: 0.5 })),
  "xai/grok-4.6": published(
    tier("standard", { input: 2, output: 6, cachedInput: 0.5 }, { inputTokensThrough: 200_000 }),
    tier("long", { input: 4, output: 12, cachedInput: 1 }, { inputTokensFrom: 200_001 }),
  ),
};

export function commandCodePricingFor(modelId: string): ModelPricing {
  return COMMAND_CODE_MODEL_PRICING[modelId] ?? unknownModelPricing();
}
