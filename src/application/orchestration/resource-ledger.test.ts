import { describe, expect, test } from "bun:test";
import {
  canonicalResourceValue,
  type ResourceDebit,
  type ResourceReservationIdentityV1,
  sharedCapacityScopeIdentitySchema,
} from "../../domain/orchestration/resource-admission.ts";
import { capacityScope } from "./product-resources.ts";
import { createResourceLedger } from "./resource-ledger.ts";

const token = capacityScope("provider", "vendor", "model-family", "inputTokens");
const concurrency = capacityScope("process", "falryn", "product", "concurrency", "occupancy");
function identity(
  debits: readonly ResourceDebit[],
  attempt = "attempt",
): ResourceReservationIdentityV1 {
  return {
    version: 1,
    parentScope: "task",
    owner: "agent",
    operation: "request",
    workspaceGeneration: "1",
    configurationGeneration: "1",
    attempt,
    fence: "fence",
    scopes: debits.map((debit) => debit.scope),
  };
}
describe("shared resource ledger", () => {
  test("rejects caller and generation dimensions in capacity identity", () => {
    expect(
      sharedCapacityScopeIdentitySchema.safeParse({ ...token, credentialBinding: "key" }).success,
    ).toBe(false);
    expect(
      sharedCapacityScopeIdentitySchema.safeParse({ ...token, configurationGeneration: 1 }).success,
    ).toBe(false);
    expect(canonicalResourceValue({ b: 1, a: 2 })).toBe(canonicalResourceValue({ a: 2, b: 1 }));
  });
  test("all overlapping scopes preflight atomically, including arithmetic overflow", () => {
    const ledger = createResourceLedger();
    const debits = [
      { scope: concurrency, amount: 1, limit: 2 },
      { scope: token, amount: 8, limit: 10 },
    ];
    expect(ledger.reserve("a", identity(debits), debits).kind).toBe("admitted");
    expect(ledger.reserve("b", identity(debits, "b"), debits).receipt.dimension).toBe(
      "inputTokens",
    );
    expect(ledger.remaining(concurrency, 2)).toBe(1);
    expect(ledger.remaining(token, 10)).toBe(2);
    const invalid = [
      { scope: token, amount: Number.MAX_SAFE_INTEGER + 1, limit: Number.MAX_SAFE_INTEGER },
    ];
    expect(ledger.reserve("c", identity(invalid), invalid).receipt.state).toBe("quota-unknown");
    expect(ledger.remaining(token, 10)).toBe(2);
  });
  test("replay matches full binding and never charges or overwrites settlement", () => {
    const ledger = createResourceLedger();
    const debits = [{ scope: token, amount: 8, limit: 10 }];
    const original = ledger.reserve("a", identity(debits), debits);
    expect(ledger.reserve("a", identity(debits), debits)).toEqual({
      kind: "replay",
      receipt: original.receipt,
    });
    expect(ledger.reserve("a", identity(debits, "different"), debits).receipt.state).toBe(
      "stale-generation",
    );
    expect(ledger.settle("a", [{ scope: token, limit: 10, amount: 3 }], true)?.released).toBe(true);
    expect(ledger.reserve("a", identity(debits), debits).receipt.released).toBe(true);
    expect(ledger.remaining(token, 10)).toBe(7);
    expect(ledger.settle("a", null, false)?.released).toBe(true);
  });
  test("unknown usage is maximum debit and interruption retains occupancy until evidence", () => {
    const ledger = createResourceLedger();
    const debits = [
      { scope: concurrency, amount: 1, limit: 1 },
      { scope: token, amount: 8, limit: 10 },
    ];
    ledger.reserve("a", identity(debits), debits);
    expect(ledger.settle("a", null, false)?.state).toBe("uncertain-after-interruption");
    expect(ledger.remaining(token, 10)).toBe(2);
    expect(ledger.reserve("b", identity(debits, "b"), debits).kind).toBe("refused");
    const occupancyOnly = [{ scope: concurrency, amount: 1, limit: 1 }];
    expect(ledger.reserve("wait", identity(occupancyOnly, "wait"), occupancyOnly).kind).toBe(
      "queued",
    );
    ledger.settle(
      "a",
      [
        { scope: concurrency, limit: 1, amount: 1 },
        { scope: token, limit: 10, amount: 3 },
      ],
      true,
    );
    expect(ledger.remaining(concurrency, 1)).toBe(1);
    expect(ledger.remaining(token, 10)).toBe(7);
  });
  test("aliases conservatively combine already charged names", () => {
    const ledger = createResourceLedger();
    const alias = { ...token, account: "resolved-account" };
    const a = [{ scope: token, amount: 4, limit: 10 }];
    const b = [{ scope: alias, amount: 4, limit: 10 }];
    ledger.reserve("a", identity(a), a);
    ledger.reserve("b", identity(b, "b"), b);
    expect(ledger.joinAliases(token, alias)).toBe(true);
    expect(ledger.remaining(token, 10)).toBe(2);
    expect(ledger.remaining(alias, 10)).toBe(2);
    expect(ledger.reserve("c", identity(b, "c"), b).kind).toBe("refused");
  });
  test("overrun explicitly poisons the scope, and receipts expose no owner data", () => {
    const ledger = createResourceLedger();
    const debits = [{ scope: token, amount: 4, limit: 10 }];
    ledger.reserve("a", identity(debits), debits);
    const receipt = ledger.settle("a", [{ scope: token, limit: 10, amount: 5 }], true);
    expect(receipt?.state).toBe("limit-exceeded");
    expect(ledger.remaining(token, 10)).toBe(0);
    expect(JSON.stringify(receipt)).not.toContain("vendor");
    expect(JSON.stringify(receipt)).not.toContain("model-family");
  });
});

test("joining aliases after admission preserves exact release of both original charges", () => {
  const ledger = createResourceLedger();
  const alias = { ...concurrency, project: "resolved" };
  const debits = [
    { scope: concurrency, amount: 1, limit: 2 },
    { scope: alias, amount: 1, limit: 2 },
  ];
  ledger.reserve("a", identity(debits), debits);
  ledger.joinAliases(concurrency, alias);
  expect(ledger.remaining(concurrency, 2)).toBe(0);
  ledger.settle("a", null, true);
  expect(ledger.remaining(concurrency, 2)).toBe(2);
});

test("idle tool buckets retain the strictest declared generation limit", () => {
  const ledger = createResourceLedger();
  const scope = capacityScope("tool", "falryn", "read", "concurrency", "occupancy");
  const strict = [{ scope, amount: 1, limit: 1 }];
  ledger.reserve("strict", identity(strict), strict);
  ledger.settle("strict", null, true);
  ledger.closeTask("task");
  const old = [{ scope, amount: 2, limit: 2 }];
  expect(ledger.reserve("old", identity(old), old).receipt.state).toBe("limit-exceeded");
});
