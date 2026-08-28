/** Secret-safe identity for one configured provider transport destination. */

import { createHash } from "node:crypto";

import type { ProviderAdapterKind } from "../providers/adapter-kind.ts";

export function providerDestinationId(
  adapterKind: ProviderAdapterKind,
  endpoint: string | null,
): string {
  const encoded = JSON.stringify({ adapterKind, endpoint });
  return `sha-256:${createHash("sha256").update(encoded).digest("hex")}`;
}
