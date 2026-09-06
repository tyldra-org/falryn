import { expect, test } from "bun:test";
import type { ModelPricing } from "../../providers/catalog/model-pricing.ts";
import { providerCostMaximum } from "./provider-resource-admission.ts";

const pricing: ModelPricing = {
  kind: "published",
  billingMode: "api",
  currency: "USD",
  tokenUnit: 1_000_000,
  sourceUrl: "https://example.com/pricing",
  observedAt: null,
  tiers: [
    {
      id: "standard",
      label: "Standard",
      serviceTier: null,
      inputTokensFrom: 0,
      inputTokensThrough: null,
      effectiveFrom: null,
      effectiveUntil: null,
      utcWindows: [],
      usdMicrosPerMillionTokens: {
        input: 2_000_000,
        cachedInput: 1_000_000,
        cacheWriteInput: 3_000_000,
        output: 5_000_000,
      },
    },
  ],
};
test("cost admission uses integer microunits with conservative cache-write and output rates", () => {
  expect(providerCostMaximum(pricing, 100, 20)).toBe(400);
  expect(providerCostMaximum(pricing, 0, 1)).toBe(5);
  expect(providerCostMaximum({ ...pricing, kind: "published-estimate" }, 100, 20)).toBeNull();
  expect(providerCostMaximum(pricing, undefined, 20)).toBeNull();
  expect(providerCostMaximum(pricing, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBeNull();
});
