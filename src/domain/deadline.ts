/**
 * Deadlines and their inheritance rule.
 *
 * A deadline is an absolute instant rather than a duration, so passing it
 * through a chain of calls cannot silently restart the countdown. Derivation is
 * one-directional: a child takes the tighter of what it inherited and what it
 * requested, and can never enlarge a limit it was given.
 */

import {
  addDuration,
  type ClockPort,
  type DurationMs,
  elapsedBetween,
  type Instant,
} from "./clock.ts";

export type Deadline = {
  readonly expiresAt: Instant;
};

export function deadlineAt(expiresAt: Instant): Deadline {
  return { expiresAt };
}

export function deadlineIn(clock: ClockPort, span: DurationMs): Deadline {
  return { expiresAt: addDuration(clock.now(), span) };
}

/**
 * Resolves the deadline a child operation runs under.
 *
 * The tighter of the two always wins. A request that is looser than what the
 * parent allows is not an error — it is simply capped, because a caller asking
 * for more time than its parent has is a normal consequence of composing
 * defaults, not a defect worth failing on.
 */
export function deriveDeadline(
  inherited: Deadline | null,
  requested: Deadline | null,
): Deadline | null {
  if (inherited === null) {
    return requested;
  }
  if (requested === null) {
    return inherited;
  }
  return requested.expiresAt < inherited.expiresAt ? requested : inherited;
}

/** Whether a deadline enlarges what was inherited. Used to explain a capped request. */
export function enlargesDeadline(inherited: Deadline | null, requested: Deadline | null): boolean {
  if (inherited === null || requested === null) {
    return false;
  }
  return requested.expiresAt > inherited.expiresAt;
}

export function isExpired(deadline: Deadline, clock: ClockPort): boolean {
  return clock.now() >= deadline.expiresAt;
}

/** Time left before expiry, clamped at zero. */
export function remainingDuration(deadline: Deadline, clock: ClockPort): DurationMs {
  return elapsedBetween(clock.now(), deadline.expiresAt);
}

/** The earlier of two deadlines, treating `null` as no limit. */
export function earlierDeadline(left: Deadline | null, right: Deadline | null): Deadline | null {
  return deriveDeadline(left, right);
}
