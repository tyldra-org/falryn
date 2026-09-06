import { describe, expect, test } from "bun:test";

import {
  BUDGET_DIMENSIONS,
  type BudgetId,
  type ReservationId,
} from "../../domain/orchestration/index.ts";
import { createBudgetLedger } from "./budget-ledger.ts";

const ROOT = "budget-root" as BudgetId;
const CHILD = "budget-child" as BudgetId;
const GRANDCHILD = "budget-grandchild" as BudgetId;

function reservation(name: string): ReservationId {
  return name as ReservationId;
}

describe("limits", () => {
  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid limits before creating or narrowing a budget: %s",
    (value) => {
      for (const dimension of BUDGET_DIMENSIONS) {
        const ledger = createBudgetLedger();
        const limits = { [dimension]: value };
        expect(ledger.createRoot(ROOT, limits).ok).toBe(false);
        expect(ledger.report(ROOT)).toBeNull();
        expect(ledger.createRoot(ROOT, { [dimension]: 10 }).ok).toBe(true);
        const before = ledger.report(ROOT);
        expect(ledger.createChild(ROOT, CHILD, limits).ok).toBe(false);
        expect(ledger.wouldNarrow(ROOT, limits).ok).toBe(false);
        expect(ledger.report(CHILD)).toBeNull();
        expect(ledger.report(ROOT)).toEqual(before);
      }
    },
  );

  test("root limits are a snapshot, including explicit zero and unlimited dimensions", () => {
    const ledger = createBudgetLedger();
    const limits = { tokens: 10, operations: 0, bytes: null };
    expect(ledger.createRoot(ROOT, limits).ok).toBe(true);
    limits.tokens = 1_000;
    limits.operations = 1;
    expect(ledger.reserve(ROOT, reservation("tokens"), { tokens: 11 }).ok).toBe(false);
    expect(ledger.reserve(ROOT, reservation("operation"), { operations: 1 }).ok).toBe(false);
    expect(ledger.reserve(ROOT, reservation("bytes"), { bytes: 100 }).ok).toBe(true);
    expect(ledger.report(ROOT)?.dimensions.tokens.limit).toBe(10);
    expect(ledger.report(ROOT)?.dimensions.bytes.limit).toBeNull();
  });

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
  test.each(["open", "consumed", "released"] as const)(
    "a duplicate ID cannot replace a %s reservation or charge another budget",
    (state) => {
      const ledger = createBudgetLedger();
      ledger.createRoot(ROOT, { tokens: 100, bytes: 100 });
      ledger.createChild(ROOT, CHILD, {});
      const id = reservation("original");
      expect(ledger.reserve(CHILD, id, { tokens: 30, bytes: 20 }).ok).toBe(true);
      if (state === "consumed") expect(ledger.consume(id, { tokens: 10 }).ok).toBe(true);
      if (state === "released") expect(ledger.release(id).ok).toBe(true);
      const root = ledger.report(ROOT);
      const child = ledger.report(CHILD);
      for (const target of [ROOT, CHILD]) {
        for (const amounts of [{ tokens: 30, bytes: 20 }, { tokens: 1 }, {}]) {
          expect(ledger.reserve(target, id, amounts)).toEqual({
            ok: false,
            error: { code: "duplicate-reservation", reservationId: id },
          });
          expect(ledger.report(ROOT)).toEqual(root);
          expect(ledger.report(CHILD)).toEqual(child);
        }
      }
      if (state === "open") {
        expect(ledger.consume(id, { tokens: 10, bytes: 5 }).ok).toBe(true);
        expect(ledger.report(ROOT)?.dimensions.tokens.remaining).toBe(90);
        expect(ledger.report(ROOT)?.dimensions.bytes.remaining).toBe(95);
      }
      expect(ledger.release(id).ok).toBe(true);
      expect(ledger.openReservationCount()).toBe(0);
    },
  );

  test.each([...BUDGET_DIMENSIONS])(
    "unlimited %s accounting stays exact at its numeric ceiling",
    (dimension) => {
      const ledger = createBudgetLedger();
      ledger.createRoot(ROOT, {});
      ledger.createChild(ROOT, CHILD, {});
      ledger.createChild(CHILD, GRANDCHILD, {});
      ledger.reserve(ROOT, reservation("used"), { [dimension]: Number.MAX_SAFE_INTEGER - 3 });
      ledger.consume(reservation("used"), { [dimension]: Number.MAX_SAFE_INTEGER - 3 });
      ledger.reserve(CHILD, reservation("held"), { [dimension]: 2 });
      const before = [ROOT, CHILD, GRANDCHILD].map((id) => ledger.report(id));

      expect(ledger.reserve(GRANDCHILD, reservation("overflow"), { [dimension]: 2 })).toEqual({
        ok: false,
        error: { code: "accounting-overflow", budgetId: ROOT, dimension, remaining: 1 },
      });
      expect([ROOT, CHILD, GRANDCHILD].map((id) => ledger.report(id))).toEqual(before);
      expect(ledger.release(reservation("held")).ok).toBe(true);
      expect(ledger.reserve(GRANDCHILD, reservation("boundary"), { [dimension]: 3 }).ok).toBe(true);
      expect(ledger.consume(reservation("boundary"), { [dimension]: 3 }).ok).toBe(true);
      expect(ledger.report(ROOT)?.dimensions[dimension]).toEqual({
        limit: null,
        reserved: 0,
        consumed: Number.MAX_SAFE_INTEGER,
        remaining: null,
      });
      expect(ledger.openReservationCount()).toBe(0);
    },
  );

  test("a rejected settlement preserves every dimension until a valid settlement", () => {
    const ledger = createBudgetLedger();
    ledger.createRoot(ROOT, { tokens: 100, bytes: 100 });
    ledger.createChild(ROOT, CHILD, {});
    const amounts = { tokens: 20, bytes: 30 };
    ledger.reserve(CHILD, reservation("a"), amounts);
    amounts.tokens = 80;
    const before = [ledger.report(ROOT), ledger.report(CHILD)];
    for (const actual of [{ tokens: 21 }, { bytes: -1 }, { bytes: Number.NaN }]) {
      expect(ledger.consume(reservation("a"), actual).ok).toBe(false);
      expect([ledger.report(ROOT), ledger.report(CHILD)]).toEqual(before);
    }
    expect(ledger.consume(reservation("a"), { tokens: 10, bytes: 5 }).ok).toBe(true);
    for (const id of [ROOT, CHILD]) {
      expect(ledger.report(id)?.dimensions.tokens.remaining).toBe(90);
      expect(ledger.report(id)?.dimensions.bytes.remaining).toBe(95);
    }
    expect(ledger.consume(reservation("a"), {}).ok).toBe(false);
    expect(ledger.release(reservation("a")).ok).toBe(true);
    expect(ledger.report(ROOT)?.dimensions.tokens.remaining).toBe(90);
  });

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

    // An ancestor refusal must leave the entire chain unchanged.
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
