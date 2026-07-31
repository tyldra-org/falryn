import { describe, expect, test } from "bun:test";

import type { BudgetId, ReservationId } from "../domain/index.ts";
import { createBudgetLedger } from "./budget-ledger.ts";

const ROOT = "budget-root" as BudgetId;
const CHILD = "budget-child" as BudgetId;
const GRANDCHILD = "budget-grandchild" as BudgetId;

function reservation(name: string): ReservationId {
  return name as ReservationId;
}

describe("limits", () => {
  test("a child cannot enlarge what it inherited", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 1_000, costMicros: 500 });
    ledger.createChild(ROOT, CHILD, { tokens: 9_999, costMicros: 100 });

    const report = ledger.report(CHILD);
    expect(report?.dimensions.tokens.limit).toBe(1_000);
    expect(report?.dimensions.costMicros.limit).toBe(100);
  });

  test("an unlimited request under a limited parent inherits the parent's limit", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 100 });
    ledger.createChild(ROOT, CHILD, {});
    expect(ledger.report(CHILD)?.dimensions.tokens.limit).toBe(100);
  });

  test("reports whether a requested limit would be narrowed", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 100 });
    expect(ledger.wouldNarrow(ROOT, { tokens: 200 })).toEqual({ ok: true, value: true });
    expect(ledger.wouldNarrow(ROOT, { tokens: 50 })).toEqual({ ok: true, value: false });
  });

  test("refuses a duplicate budget", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, {});
    const again = ledger.createRoot(ROOT, {});
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.error.code).toBe("duplicate-budget");
    }
  });
});

describe("reserve, consume, release", () => {
  test("accounts without drift across many integer operations", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { costMicros: 1_000_000 });

    for (let index = 0; index < 1_000; index += 1) {
      const id = reservation(`r-${index}`);
      expect(ledger.reserve(ROOT, id, { costMicros: 333 }).ok).toBe(true);
      expect(ledger.consume(id, { costMicros: 111 }).ok).toBe(true);
    }

    const report = ledger.report(ROOT);
    expect(report?.dimensions.costMicros.consumed).toBe(111_000);
    expect(report?.dimensions.costMicros.reserved).toBe(0);
    expect(report?.dimensions.costMicros.remaining).toBe(1_000_000 - 111_000);
    expect(Number.isSafeInteger(report?.dimensions.costMicros.consumed ?? 0)).toBe(true);
  });

  test("a reservation counts against the limit before it is spent", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 100 });
    ledger.reserve(ROOT, reservation("a"), { tokens: 80 });

    const second = ledger.reserve(ROOT, reservation("b"), { tokens: 80 });
    expect(second.ok).toBe(false);
    if (!second.ok && second.error.code === "budget-exhausted") {
      expect(second.error.remaining).toBe(20);
      expect(second.error.dimension).toBe("tokens");
    }
  });

  test("releasing returns the whole reservation", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 100 });
    ledger.reserve(ROOT, reservation("a"), { tokens: 80 });
    ledger.release(reservation("a"));

    expect(ledger.report(ROOT)?.dimensions.tokens.remaining).toBe(100);
    expect(ledger.openReservationCount()).toBe(0);
  });

  test("releasing twice is safe", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 100 });
    ledger.reserve(ROOT, reservation("a"), { tokens: 10 });
    expect(ledger.release(reservation("a")).ok).toBe(true);
    expect(ledger.release(reservation("a")).ok).toBe(true);
    expect(ledger.report(ROOT)?.dimensions.tokens.remaining).toBe(100);
  });

  test("consuming returns the unused remainder", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 100 });
    ledger.reserve(ROOT, reservation("a"), { tokens: 80 });
    ledger.consume(reservation("a"), { tokens: 30 });

    const report = ledger.report(ROOT);
    expect(report?.dimensions.tokens.consumed).toBe(30);
    expect(report?.dimensions.tokens.reserved).toBe(0);
    expect(report?.dimensions.tokens.remaining).toBe(70);
  });

  test("consuming more than was reserved is refused", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 100 });
    ledger.reserve(ROOT, reservation("a"), { tokens: 10 });

    const consumed = ledger.consume(reservation("a"), { tokens: 50 });
    expect(consumed.ok).toBe(false);
    if (!consumed.ok && consumed.error.code === "over-consumption") {
      expect(consumed.error.reserved).toBe(10);
      expect(consumed.error.requested).toBe(50);
    }
  });

  test("rejects a non-integer or negative amount", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, {});
    const fractional = ledger.reserve(ROOT, reservation("a"), { costMicros: 1.5 });
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) {
      expect(fractional.error.code).toBe("non-integer-amount");
    }
    const negative = ledger.reserve(ROOT, reservation("b"), { tokens: -1 });
    expect(negative.ok).toBe(false);
    if (!negative.ok) {
      expect(negative.error.code).toBe("negative-amount");
    }
  });
});

describe("hierarchy", () => {
  test("a child reservation is charged to every ancestor", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 100 });
    ledger.createChild(ROOT, CHILD, { tokens: 100 });
    ledger.reserve(CHILD, reservation("a"), { tokens: 40 });

    expect(ledger.report(ROOT)?.dimensions.tokens.reserved).toBe(40);
    expect(ledger.report(CHILD)?.dimensions.tokens.reserved).toBe(40);
  });

  test("a child cannot spend what its parent no longer has", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 50 });
    ledger.createChild(ROOT, CHILD, { tokens: 50 });
    ledger.reserve(ROOT, reservation("parent"), { tokens: 40 });

    const child = ledger.reserve(CHILD, reservation("child"), { tokens: 30 });
    expect(child.ok).toBe(false);
    if (!child.ok && child.error.code === "budget-exhausted") {
      expect(child.error.budgetId).toBe(ROOT);
    }
  });

  test("a refused reservation leaves no partial charge behind", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 10 });
    ledger.createChild(ROOT, CHILD, { tokens: 100 });
    ledger.createChild(CHILD, GRANDCHILD, { tokens: 100 });

    const refused = ledger.reserve(GRANDCHILD, reservation("a"), { tokens: 50 });
    expect(refused.ok).toBe(false);

    // The grandchild and child were charged first, then rolled back.
    expect(ledger.report(GRANDCHILD)?.dimensions.tokens.reserved).toBe(0);
    expect(ledger.report(CHILD)?.dimensions.tokens.reserved).toBe(0);
    expect(ledger.report(ROOT)?.dimensions.tokens.reserved).toBe(0);
  });

  test("consuming through a child settles every ancestor", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 100 });
    ledger.createChild(ROOT, CHILD, { tokens: 100 });
    ledger.reserve(CHILD, reservation("a"), { tokens: 40 });
    ledger.consume(reservation("a"), { tokens: 25 });

    expect(ledger.report(ROOT)?.dimensions.tokens.consumed).toBe(25);
    expect(ledger.report(ROOT)?.dimensions.tokens.reserved).toBe(0);
    expect(ledger.report(CHILD)?.dimensions.tokens.consumed).toBe(25);
  });

  test("an unlimited dimension reports no remaining rather than zero", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 10 });
    expect(ledger.report(ROOT)?.dimensions.bytes.limit).toBeNull();
    expect(ledger.report(ROOT)?.dimensions.bytes.remaining).toBeNull();
  });
});
