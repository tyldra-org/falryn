/**
 * Events in, transcript out.
 *
 * Pure and total: the same events always produce the same blocks in the same
 * order, and every event kind the runtime declares has a case here. Nothing in
 * this module reads a clock, a file, a database, or a provider — which is what
 * makes rebuilding a transcript produce the same transcript rather than a
 * second, differently-informed one.
 *
 * **What this build can actually produce.** Five of the sixteen block kinds have
 * a producer today: `notice`, `turn-outcome`, `model-outcome`, `tool-request`,
 * and `tool-result`. The other eleven are declared in `./blocks.ts` and reached
 * only by fixtures, because nothing in this build has an agent loop, a
 * provider, a tool runner, or a process boundary that emits them. Stating the
 * number here rather than leaving it to be counted is the point: a transcript
 * that looked complete would be the most misleading thing this area could ship.
 *
 * **Every block this build produces is `ordinary`.** The runtime's invocation and
 * turn events carry no payload, so nothing reaching this reducer is sensitive or
 * secret, and claiming otherwise would be theatre. The other two sensitivity
 * classes are constructed by fixtures so the transcript surface has something to
 * render them against — see `./fixtures.ts`. A test asserts this, so the first
 * event that does carry content has to revisit it rather than inherit
 * `ordinary` by default.
 *
 * **Two events deliberately produce nothing.** `turn.started` and
 * `model.attempt.started` open a scope; they do not say anything. A block for
 * them would read "a turn began" directly above the blocks that show what the
 * turn did, which is a row whose entire content is that there are rows below
 * it. They are still cases in the switch — totality is about the switch being
 * exhaustive, not about every event earning a row.
 *
 * The tool pair is where the streaming contract becomes real rather than
 * hypothetical: `capability.invocation.started` and its `completed` event share
 * an anchor, so the second revises the first in place. One tool call is one
 * block that changes from a request into a result, and `./coalesce.ts` is what
 * guarantees it does not become two rows.
 */

import type { RuntimeEvent, Sequence, StreamId } from "../../domain/index.ts";
import { assertNever } from "../../domain/index.ts";
import type { TranscriptBlock } from "./blocks.ts";
import type { CoalescedTranscript } from "./coalesce.ts";
import { applyRevision, EMPTY_TRANSCRIPT } from "./coalesce.ts";
import { bound, complete, omitted } from "./disclosure.ts";
import type { ResumePoint, SequenceAnomaly } from "./gaps.ts";
import { detectAnomalies } from "./gaps.ts";
import type { TranscriptCursor } from "./generation.ts";
import { TRANSCRIPT_PROJECTION_GENERATION } from "./generation.ts";

export type TranscriptProjection = {
  readonly generation: number;
  readonly blocks: readonly TranscriptBlock[];
  /** What did not line up in the events this was built from. Never hidden. */
  readonly anomalies: readonly SequenceAnomaly[];
  /** Revisions refused because their block had already settled. */
  readonly refusedRevisions: number;
  /** How far each stream was folded. One per stream actually seen. */
  readonly cursors: readonly TranscriptCursor[];
};

export const EMPTY_PROJECTION: TranscriptProjection = {
  generation: TRANSCRIPT_PROJECTION_GENERATION,
  blocks: [],
  anomalies: [],
  refusedRevisions: 0,
  cursors: [],
};

/**
 * Builds a transcript from an ordered run of events.
 *
 * `resumedAfter` is where the reader claims to have left off. Supplying it is
 * what lets a run that starts at sequence 40 be recognised as either a
 * legitimate resume or a run missing its first 39 events; without it, the two
 * are the same input.
 */
export function reduceTranscript(
  events: readonly RuntimeEvent[],
  resumedAfter: ResumePoint = new Map(),
): TranscriptProjection {
  let state: CoalescedTranscript = EMPTY_TRANSCRIPT;
  const cursors = new Map<StreamId, Sequence>();

  for (const event of events) {
    const block = blockFor(event);
    if (block !== null) {
      state = applyRevision(state, block);
    }
    // Advanced for every event, including the ones that produce no block. A
    // cursor records what was read, not what was displayed — the alternative
    // resumes from before an event that was already applied.
    const highest = cursors.get(event.streamId);
    if (highest === undefined || event.sequence > highest) {
      cursors.set(event.streamId, event.sequence);
    }
  }

  return {
    generation: TRANSCRIPT_PROJECTION_GENERATION,
    blocks: state.blocks,
    anomalies: detectAnomalies(events, resumedAfter),
    refusedRevisions: state.refusedRevisions,
    cursors: [...cursors].map(([streamId, lastAppliedSequence]) => ({
      streamId,
      lastAppliedSequence,
      generation: TRANSCRIPT_PROJECTION_GENERATION,
    })),
  };
}

/**
 * The block one event projects to, or `null` when it projects to none.
 *
 * Exhaustive. A new event kind does not compile until it has decided whether it
 * is something a user should see.
 */
export function blockFor(event: RuntimeEvent): TranscriptBlock | null {
  const spine = {
    occurredAt: event.occurredAt,
    // Replaced by the fold. A producer cannot know where its block lands.
    order: 0,
    sensitivity: "ordinary",
    artifactIds: [],
    renderGeneration: TRANSCRIPT_PROJECTION_GENERATION,
  } as const;

  switch (event.kind) {
    case "session.started":
      return {
        ...spine,
        kind: "notice",
        anchor: { of: "session", sessionId: event.correlation.sessionId },
        source: "runtime",
        status: "final",
        summary: complete("Session started."),
        invocationId: null,
        note: complete("A session was opened. Nothing has run in it yet."),
      };

    case "turn.started":
    case "model.attempt.started":
      // Scope boundaries. See this module's header for why they draw nothing.
      return null;

    case "turn.completed":
      return {
        ...spine,
        kind: "turn-outcome",
        anchor: { of: "turn", turnId: event.correlation.turnId },
        source: "runtime",
        status: "final",
        summary: complete("Turn finished."),
        invocationId: null,
        outcome: event.payload.outcome,
      };

    case "model.attempt.completed":
      return {
        ...spine,
        kind: "model-outcome",
        anchor: { of: "model-attempt", modelAttemptId: event.modelAttemptId },
        source: "model",
        status: "final",
        summary: complete("Model attempt finished."),
        invocationId: null,
        outcome: event.payload.outcome,
      };

    case "capability.invocation.started":
      return {
        ...spine,
        kind: "tool-request",
        anchor: { of: "invocation", invocationId: event.invocationId },
        source: "tool",
        status: "in-progress",
        summary: complete(`Running ${event.capabilityId}.`),
        invocationId: event.invocationId,
        capability: event.capabilityId,
        // Omitted rather than empty, and the distinction is the one
        // `./disclosure.ts` exists for: the runtime's invocation events carry
        // no payload, so the input was never collected. An empty string here
        // would render as a tool called with no arguments.
        input: omitted("invocation events carry no payload"),
      };

    case "capability.invocation.completed":
      return {
        ...spine,
        kind: "tool-result",
        anchor: { of: "invocation", invocationId: event.invocationId },
        source: "tool",
        status: "final",
        summary: complete(`Ran ${event.capabilityId}.`),
        invocationId: event.invocationId,
        capability: event.capabilityId,
        output: omitted("invocation events carry no payload"),
        outcome: event.payload.outcome,
      };

    case "configuration.generation.changed":
      return {
        ...spine,
        kind: "notice",
        anchor: { of: "configuration", generation: event.payload.generation },
        source: "runtime",
        status: "final",
        summary: complete("Configuration changed."),
        invocationId: null,
        note: bound(
          `Generation ${event.payload.generation} applies ${event.payload.applicationClass}.`,
        ),
      };

    default:
      return assertNever(event, "unhandled runtime event");
  }
}
