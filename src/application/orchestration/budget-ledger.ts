/**
 * Hierarchical budget accounting.
 *
 * A reservation is taken against a budget *and every ancestor*, so a child
 * cannot spend what its parent no longer has. Every ancestor is checked before
 * any charge is applied, so a refusal leaves the entire chain unchanged.
 *
 * Reserved amounts count against the limit immediately. Two units that each fit
 * in the remaining budget must not both be admitted and overshoot together;
 * reserving up front is what prevents that.
 */

import { err, ok, type Result } from "../../domain/foundation/index.ts";
import {
  BUDGET_DIMENSIONS,
  type BudgetAmounts,
  type BudgetDimension,
  type BudgetError,
  type BudgetId,
  type BudgetLimits,
  type BudgetReport,
  type DimensionReport,
  enlargesLimits,
  narrowLimits,
  type ReservationId,
  validateAmounts,
  validateLimits,
} from "../../domain/orchestration/index.ts";

/**
 * Deepest budget a child may be created at, with the root at depth zero.
 *
 * The guard below compares against this inclusively, so a budget may exist at
 * exactly this depth.
 */
export const MAX_BUDGET_DEPTH = 16;

type BudgetNode = {
  readonly budgetId: BudgetId;
  readonly parentId: BudgetId | null;
  readonly depth: number;
  readonly limits: BudgetLimits;
  readonly reserved: Record<BudgetDimension, number>;
  readonly consumed: Record<BudgetDimension, number>;
};

type Reservation = {
  readonly reservationId: ReservationId;
  readonly budgetId: BudgetId;
  /** The chain the reservation was applied to, nearest first. */
  readonly chain: readonly BudgetId[];
  readonly amounts: Record<BudgetDimension, number>;
  open: boolean;
};

function zeroed(): Record<BudgetDimension, number> {
  return {
    timeMs: 0,
    costMicros: 0,
    tokens: 0,
    bytes: 0,
    operations: 0,
  };
}

function filled(amounts: BudgetAmounts): Record<BudgetDimension, number> {
  const result = zeroed();
  for (const dimension of BUDGET_DIMENSIONS) {
    result[dimension] = amounts[dimension] ?? 0;
  }
  return result;
}

export type BudgetLedger = {
  createRoot(budgetId: BudgetId, limits: BudgetLimits): Result<BudgetId, BudgetError>;

  /**
   * Creates a child budget.
   *
   * The requested limits are narrowed by the parent's in every dimension, so a
   * child that asks for more than its parent has simply gets the parent's.
   */
  createChild(
    parentId: BudgetId,
    budgetId: BudgetId,
    limits: BudgetLimits,
  ): Result<BudgetId, BudgetError>;

  /** Whether a requested child limit would have been narrowed. */
  wouldNarrow(parentId: BudgetId, limits: BudgetLimits): Result<boolean, BudgetError>;

  /** Reservation IDs cannot be reused, including after settlement. */
  reserve(
    budgetId: BudgetId,
    reservationId: ReservationId,
    amounts: BudgetAmounts,
  ): Result<ReservationId, BudgetError>;

  /**
   * Settles a reservation with what was actually used.
   *
   * The unused remainder is returned to the budget. Consuming more than was
   * reserved is refused rather than silently expanding the reservation.
   */
  consume(reservationId: ReservationId, actual: BudgetAmounts): Result<void, BudgetError>;

  /** Returns an unused reservation in full. Safe to call twice. */
  release(reservationId: ReservationId): Result<void, BudgetError>;

  report(budgetId: BudgetId): BudgetReport | null;
  openReservationCount(): number;
};

export function createBudgetLedger(): BudgetLedger {
  const nodes = new Map<BudgetId, BudgetNode>();
  const reservations = new Map<ReservationId, Reservation>();

  const chainOf = (budgetId: BudgetId): BudgetNode[] => {
    const chain: BudgetNode[] = [];
    let current = nodes.get(budgetId);
    while (current !== undefined) {
      chain.push(current);
      current = current.parentId === null ? undefined : nodes.get(current.parentId);
    }
    return chain;
  };

  const remainingIn = (node: BudgetNode, dimension: BudgetDimension): number | null => {
    const limit = node.limits[dimension] ?? null;
    if (limit === null) {
      return null;
    }
    return limit - node.reserved[dimension] - node.consumed[dimension];
  };

  return {
    createRoot(budgetId: BudgetId, limits: BudgetLimits): Result<BudgetId, BudgetError> {
      if (nodes.has(budgetId)) {
        return err({ code: "duplicate-budget", budgetId });
      }
      const valid = validateLimits(limits);
      if (!valid.ok) {
        return valid;
      }
      nodes.set(budgetId, {
        budgetId,
        parentId: null,
        depth: 0,
        limits: { ...limits },
        reserved: zeroed(),
        consumed: zeroed(),
      });
      return ok(budgetId);
    },

    createChild(
      parentId: BudgetId,
      budgetId: BudgetId,
      limits: BudgetLimits,
    ): Result<BudgetId, BudgetError> {
      const parent = nodes.get(parentId);
      if (parent === undefined) {
        return err({ code: "unknown-budget", budgetId: parentId });
      }
      if (nodes.has(budgetId)) {
        return err({ code: "duplicate-budget", budgetId });
      }
      if (parent.depth + 1 > MAX_BUDGET_DEPTH) {
        return err({ code: "budget-depth-exceeded", maximumDepth: MAX_BUDGET_DEPTH });
      }
      const valid = validateLimits(limits);
      if (!valid.ok) {
        return valid;
      }
      nodes.set(budgetId, {
        budgetId,
        parentId,
        depth: parent.depth + 1,
        limits: narrowLimits(parent.limits, limits),
        reserved: zeroed(),
        consumed: zeroed(),
      });
      return ok(budgetId);
    },

    wouldNarrow(parentId: BudgetId, limits: BudgetLimits): Result<boolean, BudgetError> {
      const parent = nodes.get(parentId);
      if (parent === undefined) {
        return err({ code: "unknown-budget", budgetId: parentId });
      }
      const valid = validateLimits(limits);
      if (!valid.ok) {
        return valid;
      }
      return ok(enlargesLimits(parent.limits, limits));
    },

    reserve(
      budgetId: BudgetId,
      reservationId: ReservationId,
      amounts: BudgetAmounts,
    ): Result<ReservationId, BudgetError> {
      const valid = validateAmounts(amounts);
      if (!valid.ok) {
        return valid;
      }
      if (!nodes.has(budgetId)) {
        return err({ code: "unknown-budget", budgetId });
      }
      if (reservations.has(reservationId)) {
        return err({ code: "duplicate-reservation", reservationId });
      }
      const requested = filled(amounts);
      const chain = chainOf(budgetId);

      // Preflight the whole chain before writing. Even unlimited dimensions
      // must stay within exact integer accounting.
      for (const node of chain) {
        for (const dimension of BUDGET_DIMENSIONS) {
          const remaining = remainingIn(node, dimension);
          if (remaining !== null && requested[dimension] > remaining) {
            return err({
              code: "budget-exhausted",
              budgetId: node.budgetId,
              dimension,
              requested: requested[dimension],
              remaining,
            });
          }
          const safeRemaining =
            Number.MAX_SAFE_INTEGER - node.reserved[dimension] - node.consumed[dimension];
          if (requested[dimension] > safeRemaining) {
            return err({
              code: "accounting-overflow",
              budgetId: node.budgetId,
              dimension,
              remaining: safeRemaining,
            });
          }
        }
      }
      for (const node of chain) {
        for (const dimension of BUDGET_DIMENSIONS) {
          node.reserved[dimension] += requested[dimension];
        }
      }

      reservations.set(reservationId, {
        reservationId,
        budgetId,
        chain: chain.map((node) => node.budgetId),
        amounts: requested,
        open: true,
      });
      return ok(reservationId);
    },

    consume(reservationId: ReservationId, actual: BudgetAmounts): Result<void, BudgetError> {
      const valid = validateAmounts(actual);
      if (!valid.ok) {
        return valid;
      }
      const reservation = reservations.get(reservationId);
      if (reservation === undefined || !reservation.open) {
        return err({ code: "unknown-reservation", reservationId });
      }
      const used = filled(actual);
      for (const dimension of BUDGET_DIMENSIONS) {
        if (used[dimension] > reservation.amounts[dimension]) {
          return err({
            code: "over-consumption",
            dimension,
            reserved: reservation.amounts[dimension],
            requested: used[dimension],
          });
        }
      }

      for (const budgetId of reservation.chain) {
        const node = nodes.get(budgetId);
        if (node === undefined) {
          continue;
        }
        for (const dimension of BUDGET_DIMENSIONS) {
          node.reserved[dimension] -= reservation.amounts[dimension];
          node.consumed[dimension] += used[dimension];
        }
      }
      reservation.open = false;
      return ok(undefined);
    },

    release(reservationId: ReservationId): Result<void, BudgetError> {
      const reservation = reservations.get(reservationId);
      if (reservation === undefined) {
        return err({ code: "unknown-reservation", reservationId });
      }
      if (!reservation.open) {
        return ok(undefined);
      }
      for (const budgetId of reservation.chain) {
        const node = nodes.get(budgetId);
        if (node === undefined) {
          continue;
        }
        for (const dimension of BUDGET_DIMENSIONS) {
          node.reserved[dimension] -= reservation.amounts[dimension];
        }
      }
      reservation.open = false;
      return ok(undefined);
    },

    report(budgetId: BudgetId): BudgetReport | null {
      const node = nodes.get(budgetId);
      if (node === undefined) {
        return null;
      }
      const dimensions = {} as Record<BudgetDimension, DimensionReport>;
      for (const dimension of BUDGET_DIMENSIONS) {
        dimensions[dimension] = {
          limit: node.limits[dimension] ?? null,
          reserved: node.reserved[dimension],
          consumed: node.consumed[dimension],
          remaining: remainingIn(node, dimension),
        };
      }
      return {
        budgetId,
        parentId: node.parentId,
        dimensions,
        openReservations: [...reservations.values()].filter(
          (reservation) => reservation.open && reservation.budgetId === budgetId,
        ).length,
      };
    },

    openReservationCount(): number {
      return [...reservations.values()].filter((reservation) => reservation.open).length;
    },
  };
}
