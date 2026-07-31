/**
 * The runtime's only source of time.
 *
 * Every deadline, expiry, and drain window resolves through `ClockPort`, so
 * time-dependent behavior is deterministic under test and cannot be smuggled
 * in through `Date.now` or a wall-clock sleep at a call site.
 *
 * `waitUntil` belongs on the port rather than beside it: waiting for a deadline
 * *is* a clock operation, and a separate timer source would reintroduce the
 * non-determinism the port exists to remove.
 */

import { err, ok, type Result } from "./result.ts";
import { type Timestamp, timestampFromEpochMilliseconds } from "./time.ts";

declare const brand: unique symbol;

type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

/** A point in time, as integer milliseconds since the Unix epoch. */
export type Instant = Brand<number, "Instant">;

/** A span of time, as non-negative integer milliseconds. */
export type DurationMs = Brand<number, "DurationMs">;

export type TimeError = {
  readonly kind: "time";
  readonly code: "not-an-integer" | "out-of-range";
  readonly identity: "instant" | "duration";
};

export function parseInstant(value: unknown): Result<Instant, TimeError> {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return err({ kind: "time", code: "not-an-integer", identity: "instant" });
  }
  return ok(value as Instant);
}

export function instant(value: number): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) {
    throw new Error(`invalid instant: ${parsed.error.code}`);
  }
  return parsed.value;
}

export function parseDuration(value: unknown): Result<DurationMs, TimeError> {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return err({ kind: "time", code: "not-an-integer", identity: "duration" });
  }
  if (value < 0) {
    return err({ kind: "time", code: "out-of-range", identity: "duration" });
  }
  return ok(value as DurationMs);
}

export function duration(value: number): DurationMs {
  const parsed = parseDuration(value);
  if (!parsed.ok) {
    throw new Error(`invalid duration: ${parsed.error.code}`);
  }
  return parsed.value;
}

export const ZERO_DURATION = 0 as DurationMs;

export function addDuration(from: Instant, span: DurationMs): Instant {
  return (from + span) as Instant;
}

/** Elapsed time between two instants, clamped at zero rather than going negative. */
export function elapsedBetween(from: Instant, to: Instant): DurationMs {
  return Math.max(0, to - from) as DurationMs;
}

export function instantToTimestamp(value: Instant): Timestamp {
  return timestampFromEpochMilliseconds(value);
}

/** Why a wait ended. A caller must distinguish these; they are not interchangeable. */
export type WaitOutcome = "reached" | "aborted";

export type ClockPort = {
  now(): Instant;
  /**
   * Resolves when the clock reaches `at`, or as soon as `signal` aborts.
   *
   * Returns which of the two happened. It never throws on abort, because an
   * aborted wait is an expected control flow rather than a failure.
   */
  waitUntil(at: Instant, signal?: AbortSignal): Promise<WaitOutcome>;
};

/** A clock backed by the host. Used by the composed application, never by tests. */
export function createSystemClock(): ClockPort {
  return {
    now(): Instant {
      return Date.now() as Instant;
    },
    waitUntil(at: Instant, signal?: AbortSignal): Promise<WaitOutcome> {
      if (signal?.aborted === true) {
        return Promise.resolve("aborted");
      }
      const remaining = Math.max(0, at - Date.now());
      return new Promise<WaitOutcome>((resolve) => {
        let settled = false;
        const finish = (outcome: WaitOutcome): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve(outcome);
        };
        const onAbort = (): void => finish("aborted");
        const timer = setTimeout(() => finish("reached"), remaining);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

/**
 * A clock that only moves when a test moves it.
 *
 * `runUntilIdle` is the deterministic driver: it repeatedly flushes pending
 * work and jumps to the next scheduled wait, so a test can observe a timeout
 * without waiting for one.
 */
export type ManualClock = ClockPort & {
  /** Moves the clock forward and releases every wait it passes. */
  advance(span: DurationMs): Promise<void>;
  advanceTo(at: Instant): Promise<void>;
  /**
   * Flushes pending work, then jumps to the next scheduled wait, until no wait
   * remains or `maxSteps` is reached. Throws when the bound is hit, because a
   * clock that never goes idle means the code under test is looping.
   */
  runUntilIdle(maxSteps?: number): Promise<void>;
  pendingWaitCount(): number;
};

type Waiter = {
  readonly at: Instant;
  readonly release: (outcome: WaitOutcome) => void;
};

/** Bound on `runUntilIdle` steps. Reaching it is a defect, not a slow test. */
const DEFAULT_MAX_IDLE_STEPS = 1000;

function flushPendingWork(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function createManualClock(start: Instant = instant(0)): ManualClock {
  let current = start;
  let waiters: Waiter[] = [];

  const release = (upTo: Instant): void => {
    const due = waiters.filter((waiter) => waiter.at <= upTo);
    waiters = waiters.filter((waiter) => waiter.at > upTo);
    for (const waiter of due) {
      waiter.release("reached");
    }
  };

  const advanceTo = async (at: Instant): Promise<void> => {
    if (at > current) {
      current = at;
    }
    release(current);
    await flushPendingWork();
  };

  return {
    now(): Instant {
      return current;
    },

    waitUntil(at: Instant, signal?: AbortSignal): Promise<WaitOutcome> {
      if (signal?.aborted === true) {
        return Promise.resolve("aborted");
      }
      if (at <= current) {
        return Promise.resolve<WaitOutcome>("reached");
      }
      return new Promise<WaitOutcome>((resolve) => {
        let settled = false;
        const waiter: Waiter = {
          at,
          release: (outcome) => {
            if (settled) {
              return;
            }
            settled = true;
            signal?.removeEventListener("abort", onAbort);
            resolve(outcome);
          },
        };
        const onAbort = (): void => {
          waiters = waiters.filter((candidate) => candidate !== waiter);
          waiter.release("aborted");
        };
        waiters.push(waiter);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },

    async advance(span: DurationMs): Promise<void> {
      await advanceTo(addDuration(current, span));
    },

    advanceTo,

    async runUntilIdle(maxSteps: number = DEFAULT_MAX_IDLE_STEPS): Promise<void> {
      for (let step = 0; step < maxSteps; step += 1) {
        await flushPendingWork();
        const next = waiters.reduce<Instant | null>(
          (earliest, waiter) => (earliest === null || waiter.at < earliest ? waiter.at : earliest),
          null,
        );
        if (next === null) {
          return;
        }
        await advanceTo(next);
      }
      throw new Error(`manual clock did not go idle within ${maxSteps} steps`);
    },

    pendingWaitCount(): number {
      return waiters.length;
    },
  };
}
