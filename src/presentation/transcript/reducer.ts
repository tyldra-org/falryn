import { artifactId } from "../../domain/artifacts/index.ts";
import { sandboxSummary } from "../../domain/security/sandbox.ts";
import type { HistoryPayload } from "../../domain/sessions/history.ts";
import { historyReferences } from "../../domain/sessions/history.ts";
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
 * a lifecycle-event producer today: `notice`, `turn-outcome`, `model-outcome`,
 * `tool-request`, and `tool-result`. The other eleven are declared in
 * `./blocks.ts` but are not emitted by this reducer's closed `RuntimeEvent`
 * vocabulary. Stating the number here rather than leaving it to be counted is
 * the point: a transcript that looked complete would be the most misleading
 * thing this area could ship.
 *
 * **Every block this build produces is `ordinary`.** Invocation completion may
 * carry a bounded, secret-free degradation receipt; it still carries no tool
 * input or result payload. The other two sensitivity classes are constructed by
 * fixtures so the transcript surface has something to render them against — see
 * `./fixtures.ts`. A test asserts this, so the first event that does carry
 * sensitive content has to revisit it rather than inherit `ordinary` by default.
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

import type { Sequence, StreamId } from "../../domain/foundation/index.ts";
import { assertNever } from "../../domain/foundation/index.ts";
import type { RuntimeEvent } from "../../domain/sessions/index.ts";
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

function invocationResultOutput(
  event: Extract<RuntimeEvent, { readonly kind: "capability.invocation.completed" }>,
) {
  const sandbox = sandboxSummary(event.payload.sandbox ?? []);
  const degradation = event.payload.degradation;
  if (degradation === undefined) {
    return sandbox === null ? omitted("invocation events carry no result payload") : bound(sandbox);
  }
  const fallbacks =
    degradation.candidateIds.length === 0 ? "none" : degradation.candidateIds.join(", ");
  const recovery =
    degradation.recoveryHandles.length === 0
      ? ""
      : ` Recovery: ${degradation.recoveryHandles.join(", ")}.`;
  return bound(
    (sandbox === null ? "" : `${sandbox} `) +
      `Observed ${event.payload.observedStatus ?? "unavailable"}. ` +
      `Degradation: ${degradation.decision}. ` +
      `Fallbacks: ${fallbacks}. ` +
      `Terminal: ${degradation.terminalReason}.${recovery}`,
  );
}

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
  const first = events[0];
  if (
    first &&
    first.sequence > 1 &&
    !resumedAfter.has(first.streamId) &&
    events.some((event) => event.kind === "history.recorded")
  ) {
    state = applyRevision(state, {
      kind: "notice",
      anchor: { of: "declared", key: `history-window:${first.streamId}` },
      source: "runtime",
      status: "final",
      summary: complete("Earlier session history is outside this view."),
      note: complete(
        `Read ordered history with falryn session show ${first.correlation.sessionId} --workspace-id ${first.correlation.workspaceId}; follow its paging cursor.`,
      ),
      invocationId: null,
      occurredAt: first.occurredAt,
      order: 0,
      sensitivity: "ordinary",
      artifactIds: [],
      renderGeneration: TRANSCRIPT_PROJECTION_GENERATION,
    });
  }

  const history = new Map(
    events.flatMap((event) =>
      event.kind === "history.recorded" ? [[event.payload.id, event.payload] as const] : [],
    ),
  );
  const settledTurns = new Set(
    events.flatMap((event) => (event.kind === "turn.completed" ? [event.correlation.turnId] : [])),
  );
  const retiredPoints = new Set(
    events.flatMap((event) =>
      event.kind === "history.recorded" &&
      event.payload.type === "restore-point" &&
      (event.payload.stage === "expired" || event.payload.stage === "deleted")
        ? [event.payload.restorePointId]
        : [],
    ),
  );
  const completedInvocations = new Set(
    events.flatMap((event) =>
      event.kind === "capability.invocation.completed" ? [String(event.invocationId)] : [],
    ),
  );
  const fragments = new Map<string, Extract<RuntimeEvent, { kind: "history.recorded" }>[]>();
  for (const event of events)
    if (
      event.kind === "history.recorded" &&
      event.payload.type === "message" &&
      event.payload.part > 0
    ) {
      const parts = fragments.get(event.payload.messageId) ?? [];
      parts.push(event);
      fragments.set(event.payload.messageId, parts);
    }
  const completeMessages = new Set(
    events.flatMap((event) =>
      event.kind === "history.recorded" &&
      event.payload.type === "message" &&
      event.payload.part === 0 &&
      event.payload.evidence.availability !== "unavailable"
        ? [event.payload.messageId]
        : [],
    ),
  );
  for (const event of events) {
    const supersededFragment =
      event.kind === "history.recorded" &&
      event.payload.type === "message" &&
      event.payload.part > 0 &&
      completeMessages.has(event.payload.messageId);
    const projectedResult =
      event.kind === "history.recorded" &&
      event.payload.type === "result" &&
      event.payload.invocationId !== null &&
      completedInvocations.has(event.payload.invocationId);
    const parts =
      event.kind === "history.recorded" &&
      event.payload.type === "message" &&
      event.payload.part > 0
        ? fragments.get(event.payload.messageId)
        : undefined;
    const earlierFragment = parts !== undefined && parts.at(-1)?.eventId !== event.eventId;
    let block =
      supersededFragment || projectedResult || earlierFragment
        ? null
        : blockFor(
            event,
            event.kind === "capability.invocation.completed" && event.payload.historyId
              ? history.get(event.payload.historyId)
              : undefined,
          );
    if (parts && block?.kind === "model-text" && event.kind === "history.recorded") {
      const complete = parts.every((part) => part.payload.evidence.availability === "inline");
      block = {
        ...block,
        status: settledTurns.has(event.correlation.turnId) ? "final" : "in-progress",
        text: complete
          ? bound(
              parts
                .map((part) =>
                  part.payload.evidence.availability === "inline" ? part.payload.evidence.text : "",
                )
                .join(""),
            )
          : omitted("Partial response; inspect retained fragments for available content."),
        artifactIds: parts.flatMap((part) =>
          part.payload.evidence.availability === "retained"
            ? [artifactId.from(part.payload.evidence.artifactId)]
            : [],
        ),
      };
    }
    if (
      block?.kind === "notice" &&
      event.kind === "history.recorded" &&
      event.payload.type === "restore-point" &&
      retiredPoints.has(event.payload.restorePointId)
    )
      block = {
        ...block,
        artifactIds: [],
        note: omitted("Restore-point evidence is expired or deleted."),
      };
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
export function blockFor(event: RuntimeEvent, history?: HistoryPayload): TranscriptBlock | null {
  const spine = {
    occurredAt: event.occurredAt,
    // Replaced by the fold. A producer cannot know where its block lands.
    order: 0,
    sensitivity: "ordinary",
    artifactIds: [],
    renderGeneration: TRANSCRIPT_PROJECTION_GENERATION,
  } as const;

  switch (event.kind) {
    case "workflow.changed":
    case "work.queue.changed":
      // The queue journal is available to its store consumers; #161 owns shared projections.
      return null;
    case "process.task.changed":
      return {
        ...spine,
        kind: "notice",
        anchor: {
          of: "declared",
          key: `process-task:${event.payload.task.handle.taskId}:${event.payload.task.handle.generation}`,
        },
        source: "runtime",
        status: "final",
        summary: complete(
          `Process task ${event.payload.change === "cleaned" ? "cleaned" : event.payload.task.state}.`,
        ),
        invocationId: null,
        note: complete(
          event.payload.task.terminal === null
            ? `${event.payload.task.attachment}; process result pending.`
            : `${event.payload.task.terminal.outcome}; ${event.payload.task.terminal.reason}.`,
        ),
      };
    case "history.recorded": {
      const history = event.payload;
      if (history.type === "gate") return null;
      const evidence = history.evidence;
      const text =
        evidence.availability === "inline"
          ? bound(evidence.text)
          : omitted(
              evidence.availability === "retained"
                ? "Artifact referenced; availability is checked when opened."
                : evidence.reason,
            );
      const common = {
        ...spine,
        anchor: { of: "declared" as const, key: String(event.eventId) },
        status: "final" as const,
        invocationId: null,
        sensitivity:
          evidence.availability === "retained" && evidence.sensitivity === "restricted"
            ? ("secret" as const)
            : evidence.availability === "retained" && evidence.sensitivity === "sensitive"
              ? ("sensitive" as const)
              : ("ordinary" as const),
        artifactIds: historyReferences(history).map((reference) =>
          artifactId.from(reference.artifactId),
        ),
      };
      if (history.type === "message")
        return {
          ...common,
          anchor: { of: "declared", key: `message:${history.messageId}` },
          status: history.part === 0 ? "final" : "in-progress",
          kind: history.role === "user" ? "user-input" : "model-text",
          source: history.role === "user" ? "user" : "model",
          summary: complete(`${history.role} content (${history.completion})`),
          text,
        };
      return {
        ...common,
        kind: "notice",
        source: "runtime",
        summary: complete(`History ${history.type}`),
        note: text,
      };
    }
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
        output:
          history === undefined
            ? invocationResultOutput(event)
            : history.evidence.availability === "inline"
              ? bound(history.evidence.text)
              : omitted(
                  history.evidence.availability === "retained"
                    ? "Exact result is referenced by an artifact; availability is checked when opened."
                    : history.evidence.reason,
                ),
        sensitivity:
          history?.evidence.availability === "retained" &&
          history.evidence.sensitivity === "restricted"
            ? "secret"
            : history?.evidence.availability === "retained" &&
                history.evidence.sensitivity === "sensitive"
              ? "sensitive"
              : "ordinary",
        artifactIds:
          history?.evidence.availability === "retained"
            ? [artifactId.from(history.evidence.artifactId)]
            : [],
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

    case "workspace.trust.reviewed":
      return {
        ...spine,
        kind: "notice",
        anchor: {
          of: "declared",
          key: `workspace-trust:${event.payload.inventory?.generation ?? event.eventId}`,
        },
        source: "runtime",
        status: "final",
        summary: complete(`Workspace trust: ${event.payload.status}.`),
        invocationId: null,
        note: bound(
          `${event.payload.reason}. Replay cannot grant trust or activate project loaders.`,
        ),
      };
    case "execution.profile.selected":
      return {
        ...spine,
        kind: "notice",
        anchor: { of: "declared", key: `execution-profile:${event.payload.selectionId}` },
        source: "runtime",
        status: "final",
        summary: complete(`Execution profile set to ${event.payload.profileId}.`),
        invocationId: null,
        note: complete(`${event.payload.completion}; applies ${event.payload.applicationClass}.`),
      };

    default:
      return assertNever(event, "unhandled runtime event");
  }
}
