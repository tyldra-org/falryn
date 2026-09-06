/** Integer admission estimates are maxima, not authoritative billing observations. */
import type { ResourceAmounts } from "../../domain/orchestration/resource-admission.ts";
import type { ModelPricing } from "../../providers/catalog/model-pricing.ts";
import type { RoleBudgets } from "../../providers/configuration/policy.ts";
export function roleResourceLimits(budgets: RoleBudgets): ResourceAmounts {
  return {
    ...(budgets.attempts === undefined ? {} : { attempts: budgets.attempts }),
    ...(budgets.inputTokens === undefined ? {} : { inputTokens: budgets.inputTokens }),
    ...(budgets.outputTokens === undefined ? {} : { outputTokens: budgets.outputTokens }),
    ...(budgets.cost === undefined ? {} : { costMicros: budgets.cost }),
    ...(budgets.wallTimeMs === undefined ? {} : { wallTimeMs: budgets.wallTimeMs }),
  };
}
/** Maximum across published tiers, including cache writes. Missing rates fail closed. */
export function providerCostMaximum(
  pricing: ModelPricing | undefined,
  inputTokens: number | undefined,
  outputTokens: number | undefined,
): number | null {
  if (pricing?.kind === "free") return 0;
  if (
    pricing?.kind !== "published" ||
    pricing.currency !== "USD" ||
    pricing.billingMode !== "api" ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    pricing.tiers.length === 0
  )
    return null;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0
  )
    return null;
  let inputRate = 0;
  let outputRate = 0;
  for (const tier of pricing.tiers) {
    const rate = tier.usdMicrosPerMillionTokens;
    if (
      rate.input === null ||
      rate.output === null ||
      rate.cachedInput === null ||
      rate.cacheWriteInput === null
    )
      return null;
    inputRate = Math.max(
      inputRate,
      rate.input,
      rate.cachedInput ?? rate.input,
      rate.cacheWriteInput ?? rate.input,
    );
    outputRate = Math.max(outputRate, rate.output);
  }
  if (!Number.isSafeInteger(inputRate) || !Number.isSafeInteger(outputRate)) return null;
  const cost =
    (BigInt(inputTokens) * BigInt(inputRate) +
      BigInt(outputTokens) * BigInt(outputRate) +
      999_999n) /
    1_000_000n;
  return cost > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(cost);
}
