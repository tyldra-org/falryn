/**
 * Hierarchical resource budgets.
 *
 * Every amount is an integer. Cost is carried in micro-units rather than a
 * fractional currency value, because repeatedly adding and subtracting floats
 * drifts, and a budget that drifts eventually reports spending that never
 * happened.
 *
 * The invariant: a child budget can never enlarge what it inherited, and a
 * reservation is money set aside — it counts against the limit from the moment
 * it is taken, not when it is spent. Otherwise concurrent reservations could
 * each fit individually and overshoot together.
 */

import { err, ok, type Result } from "./result.ts";

declare const brand: unique symbol;

type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type BudgetId = Brand<string, "BudgetId">;
export type ReservationId = Brand<string, "ReservationId">;

/**
 * What a budget meters.
 *
 * Time is milliseconds, cost is micro-units of currency, tokens and operations
 * are counts, and bytes are bytes. All integers.
 */
export const BUDGET_DIMENSIONS = ["timeMs", "costMicros", "tokens", "bytes", "operations"] as const;

export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

/** `null` means no limit in that dimension, which is not the same as zero. */
export type BudgetLimits = Readonly<Partial<Record<BudgetDimension, number | null>>>;

export type BudgetAmounts = Readonly<Partial<Record<BudgetDimension, number>>>;

export type DimensionReport = {
  readonly limit: number | null;
  readonly reserved: number;
  readonly consumed: number;
  /** `null` when the dimension is unlimited. */
  readonly remaining: number | null;
};

export type BudgetReport = {
  readonly budgetId: BudgetId;
  readonly parentId: BudgetId | null;
  readonly dimensions: Readonly<Record<BudgetDimension, DimensionReport>>;
  readonly openReservations: number;
};

export type BudgetError =
  | { readonly code: "unknown-budget"; readonly budgetId: BudgetId }
  | { readonly code: "unknown-reservation"; readonly reservationId: ReservationId }
  | { readonly code: "duplicate-budget"; readonly budgetId: BudgetId }
  | {
      readonly code: "non-integer-amount";
      readonly dimension: BudgetDimension;
    }
  | {
      readonly code: "negative-amount";
      readonly dimension: BudgetDimension;
    }
  /** The reservation would take a budget past its limit. Carries what was left. */
  | {
      readonly code: "budget-exhausted";
      readonly budgetId: BudgetId;
      readonly dimension: BudgetDimension;
      readonly requested: number;
      readonly remaining: number;
    }
  /** Consuming more than was reserved would let a unit exceed its own reservation. */
  | {
      readonly code: "over-consumption";
      readonly dimension: BudgetDimension;
      readonly reserved: number;
      readonly requested: number;
    }
  | { readonly code: "budget-depth-exceeded"; readonly maximumDepth: number };

export function isBudgetDimension(value: unknown): value is BudgetDimension {
  return typeof value === "string" && (BUDGET_DIMENSIONS as readonly string[]).includes(value);
}

/**
 * Resolves a child's limit against its parent's.
 *
 * The tighter wins in every dimension. An unlimited request under a limited
 * parent inherits the parent's limit rather than escaping it.
 */
export function narrowLimits(inherited: BudgetLimits, requested: BudgetLimits): BudgetLimits {
  const resolved: Partial<Record<BudgetDimension, number | null>> = {};
  for (const dimension of BUDGET_DIMENSIONS) {
    const parent = inherited[dimension] ?? null;
    const child = requested[dimension] ?? null;
    if (parent === null) {
      resolved[dimension] = child;
      continue;
    }
    resolved[dimension] = child === null ? parent : Math.min(parent, child);
  }
  return resolved;
}

/** Whether a requested limit would exceed what was inherited in any dimension. */
export function enlargesLimits(inherited: BudgetLimits, requested: BudgetLimits): boolean {
  return BUDGET_DIMENSIONS.some((dimension) => {
    const parent = inherited[dimension] ?? null;
    const child = requested[dimension] ?? null;
    if (parent === null) {
      return false;
    }
    return child === null || child > parent;
  });
}

export function validateAmounts(amounts: BudgetAmounts): Result<void, BudgetError> {
  for (const dimension of BUDGET_DIMENSIONS) {
    const amount = amounts[dimension];
    if (amount === undefined) {
      continue;
    }
    if (!Number.isSafeInteger(amount)) {
      return err({ code: "non-integer-amount", dimension });
    }
    if (amount < 0) {
      return err({ code: "negative-amount", dimension });
    }
  }
  return ok(undefined);
}
