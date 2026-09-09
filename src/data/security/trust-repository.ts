import { err, ok } from "../../domain/foundation/result.ts";
import {
  type TrustDecision,
  type TrustDecisionStore,
  trustDecisionKey,
  trustDecisionSchema,
} from "../../domain/security/ecosystem-trust.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";

function decode(row: Record<string, unknown>, key: string): TrustDecision | null {
  if (
    typeof row.decision_json !== "string" ||
    new TextEncoder().encode(row.decision_json).length > 131_072
  )
    return null;
  try {
    const parsed = trustDecisionSchema.safeParse(JSON.parse(row.decision_json));
    if (
      !parsed.success ||
      parsed.data.revision !== row.revision ||
      trustDecisionKey(parsed.data.subject, parsed.data.scope, parsed.data.actor) !== key
    )
      return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function createTrustDecisionRepository(store: SqliteStorePort): TrustDecisionStore {
  return {
    get(key) {
      const rows = store.read(
        "SELECT revision, decision_json FROM trust_decisions WHERE decision_key = $key",
        { key },
      );
      if (!rows.ok) return err({ code: "unavailable" });
      if (rows.value.length === 0) return ok(null);
      const row = rows.value[0];
      const decision = row === undefined ? null : decode(row, key);
      return decision === null ? err({ code: "malformed" }) : ok(decision);
    },
    replace(key, expectedRevision, decision, signal) {
      if (signal?.aborted) return err({ code: "cancelled" });
      const checked = trustDecisionSchema.safeParse(decision);
      const json = JSON.stringify(decision);
      if (
        !checked.success ||
        new TextEncoder().encode(json).length > 131_072 ||
        decision.revision !== expectedRevision + 1 ||
        trustDecisionKey(decision.subject, decision.scope, decision.actor) !== key
      )
        return err({ code: "malformed" });
      const written = store.write((statements) => {
        const existing = statements.all(
          "SELECT revision, decision_json FROM trust_decisions WHERE decision_key = $key",
          { key },
        )[0];
        if (existing !== undefined && decode(existing, key) === null) return "malformed" as const;
        if ((existing?.revision ?? 0) !== expectedRevision) return "conflict" as const;
        statements.run(
          "INSERT INTO trust_decisions (decision_key, revision, decision_json) VALUES ($key, $revision, $json) ON CONFLICT(decision_key) DO UPDATE SET revision = excluded.revision, decision_json = excluded.decision_json",
          { key, revision: decision.revision, json },
        );
        return null;
      }, signal);
      if (!written.ok)
        return err({ code: written.error.effect === "uncertain" ? "uncertain" : "unavailable" });
      return written.value.value === null ? ok(null) : err({ code: written.value.value });
    },
  };
}
