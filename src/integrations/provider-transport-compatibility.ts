/** Host-owned identity binding for provider transport compatibility plans. */

import { createHash } from "node:crypto";

import type { ProviderAdapterKind } from "../providers/adapter-kind.ts";
import {
  type ProviderTransportCompatibilityDeclaration,
  type ProviderTransportCompatibilityError,
  type ProviderTransportCompatibilityPlan,
  resolveProviderTransportCompatibility,
} from "../providers/transport-compatibility.ts";

function compatibilityId(declaration: ProviderTransportCompatibilityDeclaration): string {
  return `sha-256:${createHash("sha256").update(JSON.stringify(declaration)).digest("hex")}`;
}

/** Validate a declaration, then bind its canonical bytes to one immutable identity. */
export function resolveProviderTransportCompatibilityPlan(
  adapterKind: ProviderAdapterKind,
  declaration?: ProviderTransportCompatibilityDeclaration | null,
):
  | { readonly ok: true; readonly value: ProviderTransportCompatibilityPlan }
  | { readonly ok: false; readonly error: ProviderTransportCompatibilityError } {
  const resolved = resolveProviderTransportCompatibility(adapterKind, declaration);
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
