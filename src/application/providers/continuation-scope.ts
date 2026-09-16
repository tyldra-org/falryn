import { createHash } from "node:crypto";
import type { ProviderContinuationStatePort } from "../../providers/protocol/continuation-state.ts";

/** Opaque provider state is never inherited by a different session/profile admission binding. */
export function scopeProviderContinuations(
  store: ProviderContinuationStatePort,
  scope: string,
): ProviderContinuationStatePort {
  const scoped = (profile: string) =>
    createHash("sha256")
      .update(JSON.stringify([scope, profile]))
      .digest("hex");
  return {
    load(key) {
      const loaded = store.load({ ...key, profileId: scoped(key.profileId) });
      return loaded.ok && loaded.value !== null
        ? { ok: true, value: { ...loaded.value, profileId: key.profileId } }
        : loaded;
    },
    save(records) {
      return store.save(
        records.map((record) => ({ ...record, profileId: scoped(record.profileId) })),
      );
    },
  };
}
