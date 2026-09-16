import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { digestSchema } from "../../domain/extensions/identity.ts";
import { err, ok } from "../../domain/foundation/result.ts";
import type { Migration, SqliteStorePort } from "../../domain/storage/index.ts";
import {
  type HookHealth,
  hookHealthStateSchema,
  nextHookHealth,
} from "../../domain/tools/hook-health.ts";

export const HOOK_HEALTH_TABLE = "hook_health";
export const MIGRATION_0029: Migration = {
  version: 29,
  name: "hook-generation-health",
  destructive: false,
  statements: [
    "CREATE TABLE hook_health (binding TEXT PRIMARY KEY, failures INTEGER NOT NULL CHECK(failures BETWEEN 0 AND 3), uncertain INTEGER NOT NULL CHECK(uncertain IN (0,1))) STRICT",
  ],
};
function decode(row: Record<string, unknown> | undefined) {
  if (row !== undefined && row.uncertain !== 0 && row.uncertain !== 1)
    throw new Error("invalid-hook-health");
  return row === undefined
    ? { failures: 0, uncertain: false }
    : hookHealthStateSchema.parse({ failures: row.failures, uncertain: row.uncertain === 1 });
}
/** One bounded state row per validated identity/generation in the existing SQLite owner. */
export function createHookHealthRepository(store: SqliteStorePort) {
  return (identity: string, generation: string): HookHealth => {
    digestSchema.parse(generation);
    const binding = canonicalDigest({ identity, generation });
    return {
      generation,
      read() {
        try {
          const result = store.read(
            "SELECT failures,uncertain FROM hook_health WHERE binding=$binding",
            { binding },
          );
          return result.ok ? ok(decode(result.value[0])) : err({ code: "hook-health-unavailable" });
        } catch {
          return err({ code: "hook-health-unavailable" });
        }
      },
      settle(outcome) {
        try {
          const saved = store.write((tx) => {
            const state = nextHookHealth(
              decode(
                tx.all("SELECT failures,uncertain FROM hook_health WHERE binding=$binding", {
                  binding,
                })[0],
              ),
              outcome,
            );
            tx.run(
              "INSERT INTO hook_health(binding,failures,uncertain) VALUES($binding,$failures,$uncertain) ON CONFLICT(binding) DO UPDATE SET failures=excluded.failures,uncertain=excluded.uncertain",
              { binding, failures: state.failures, uncertain: Number(state.uncertain) },
            );
            return state;
          });
          return saved.ok ? ok(saved.value.value) : err({ code: "hook-health-unavailable" });
        } catch {
          return err({ code: "hook-health-unavailable" });
        }
      },
    };
  };
}
