/** Host-owned identity binding for provider transport compatibility plans. */

import { createHash } from "node:crypto";

import type { ModelId } from "../domain/identity.ts";
import type { ProviderAdapterKind } from "../providers/adapter-kind.ts";
import {
  type ProviderModelTransportCompatibilityOverride,
  type ProviderTransportCompatibilityDeclaration,
  type ProviderTransportCompatibilityError,
  type ProviderTransportCompatibilityPlan,
  resolveProviderTransportCompatibility,
} from "../providers/transport-compatibility.ts";

export type ProviderTransportCompatibilityModelPlan = {
  readonly modelId: ModelId;
  readonly plan: ProviderTransportCompatibilityPlan;
};

export type ProviderTransportCompatibilityPlanSet = {
  readonly destination: ProviderTransportCompatibilityPlan;
  readonly models: readonly ProviderTransportCompatibilityModelPlan[];
};

function compatibilityId(declaration: ProviderTransportCompatibilityDeclaration): string {
  return `sha-256:${createHash("sha256").update(JSON.stringify(declaration)).digest("hex")}`;
}

/** Validate a declaration, then bind its canonical bytes to one immutable identity. */
export function resolveProviderTransportCompatibilityPlan(
  adapterKind: ProviderAdapterKind,
  declaration?: ProviderTransportCompatibilityDeclaration | null,
  options: {
    readonly modelId?: ModelId;
    readonly modelOverrides?: readonly ProviderModelTransportCompatibilityOverride[];
  } = {},
):
  | { readonly ok: true; readonly value: ProviderTransportCompatibilityPlan }
  | { readonly ok: false; readonly error: ProviderTransportCompatibilityError } {
  const resolved = resolveProviderTransportCompatibility(adapterKind, declaration, options);
  if (!resolved.ok) {
    return resolved;
  }
  return {
    ok: true,
    value: {
      ...resolved.value,
      compatibilityId: compatibilityId(resolved.value.declaration),
    },
  };
}

/** Bind one destination plan and every supported exact-model override before execution. */
export function resolveProviderTransportCompatibilityPlanSet(
  adapterKind: ProviderAdapterKind,
  declaration: ProviderTransportCompatibilityDeclaration | null | undefined,
  models: readonly ModelId[],
  modelOverrides: readonly ProviderModelTransportCompatibilityOverride[] = [],
):
  | { readonly ok: true; readonly value: ProviderTransportCompatibilityPlanSet }
  | { readonly ok: false; readonly error: ProviderTransportCompatibilityError } {
  const destination = resolveProviderTransportCompatibilityPlan(adapterKind, declaration);
  if (!destination.ok) {
    return destination;
  }
  const modelPlans: ProviderTransportCompatibilityModelPlan[] = [];
  for (const currentModelId of models) {
    const resolved = resolveProviderTransportCompatibilityPlan(adapterKind, declaration, {
      modelId: currentModelId,
      modelOverrides,
    });
    if (!resolved.ok) {
      return resolved;
    }
    modelPlans.push({ modelId: currentModelId, plan: resolved.value });
  }
  return { ok: true, value: { destination: destination.value, models: modelPlans } };
}
