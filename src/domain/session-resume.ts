/**
 * Crash-safe session resume from durable event cursors (#259).
 *
 * Resume continues the same session. It does not fork a lineage, rewrite a
 * stream, or re-apply a sequence the cursor already claimed.
 */

import { z } from "zod";

import { brandedInteger, brandedString, timestampSchema } from "./branded-schema.ts";
import type { EventCursor } from "./event-store.ts";
import {
  FIRST_SEQUENCE,
  nextSequence,
  type Sequence,
  type SessionId,
  type StreamId,
  sequence,
  sessionId,
  streamId,
} from "./identity.ts";
import { PROJECTION_PAGE_SIZE, TERMINAL_OUTCOME_PROJECTION_GENERATION } from "./projection.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const SESSION_RESUME_VERSION = "session-resume.v1";
export const SESSION_RESUME_SOURCE = "deterministic-event-cursors";

export type SessionResumeErrorCode =
  | "cancelled"
  | "closed"
  | "malformed"
  | "not-found"
  | "oversized";

export type SessionResumeError = {
  readonly kind: "session-resume";
  readonly code: SessionResumeErrorCode;
  readonly field: string | null;
};

export type SessionResumeKind = "continue" | "rebuild";

export type SessionResumeProvenance = {
  readonly version: typeof SESSION_RESUME_VERSION;
  readonly source: typeof SESSION_RESUME_SOURCE;
  readonly model: null;
};

export type SessionResumePlan = {
  readonly kind: SessionResumeKind;
  readonly sessionId: SessionId;
  readonly streamId: StreamId;
  readonly cursor: EventCursor;
  readonly pending: number;
  readonly provenance: SessionResumeProvenance;
};

export type SessionResumeInput = {
  readonly session: unknown;
  readonly cursor?: unknown;
  readonly events?: unknown;
};

const sessionSchema = z
  .object({
    sessionId: brandedString(sessionId),
    streamId: brandedString(streamId),
    closedAt: timestampSchema.nullable(),
  })
  .strict();

const cursorSchema = z
  .object({
    streamId: brandedString(streamId),
    afterSequence: brandedInteger(sequence).nullable(),
    schemaGeneration: z.int().min(1),
  })
  .strict();

const eventSpineSchema = z
  .object({
    streamId: brandedString(streamId),
    sequence: brandedInteger(sequence),
  })
  .passthrough();

function resumeError(code: SessionResumeErrorCode, field: string | null): SessionResumeError {
  return { kind: "session-resume", code, field };
}

export function describeSessionResumeError(error: SessionResumeError): string {
  const field = error.field === null ? "resume" : error.field;
  switch (error.code) {
    case "cancelled":
      return `cancelled ${field}`;
    case "closed":
      return `closed ${field}`;
    case "malformed":
      return `malformed ${field}`;
    case "not-found":
      return `not-found ${field}`;
    case "oversized":
      return `oversized ${field}`;
    default:
      return assertNever(error.code, "unhandled session-resume error");
  }
}

function expectedNext(afterSequence: Sequence | null): Sequence {
  return afterSequence === null ? FIRST_SEQUENCE : nextSequence(afterSequence);
}

function parseEvents(
  value: unknown,
  stream: StreamId,
  afterSequence: Sequence | null,
): Result<number, SessionResumeError> {
  if (value === undefined) {
    return ok(0);
  }
  if (!Array.isArray(value)) {
    return err(resumeError("malformed", "events"));
  }
  if (value.length > PROJECTION_PAGE_SIZE) {
    return err(resumeError("oversized", "events"));
  }
  let expected = expectedNext(afterSequence);
  for (const [index, item] of value.entries()) {
    const parsed = eventSpineSchema.safeParse(item);
    if (!parsed.success) {
      return err(resumeError("malformed", `events.${index}`));
    }
    if (parsed.data.streamId !== stream) {
      return err(resumeError("malformed", `events.${index}.streamId`));
    }
    if (parsed.data.sequence !== expected) {
      return err(resumeError("malformed", `events.${index}.sequence`));
    }
    expected = nextSequence(parsed.data.sequence);
  }
  return ok(value.length);
}

function planOf(
  kind: SessionResumeKind,
  sessionIdValue: SessionId,
  stream: StreamId,
  afterSequence: Sequence | null,
  pending: number,
): SessionResumePlan {
  return {
    kind,
    sessionId: sessionIdValue,
    streamId: stream,
    cursor: { streamId: stream, afterSequence },
    pending,
    provenance: {
      version: SESSION_RESUME_VERSION,
      source: SESSION_RESUME_SOURCE,
      model: null,
    },
  };
}

/**
 * Plans resume of the same session from a durable cursor.
 *
 * A matching generation continues after the last applied sequence. A missing
 * or stale-generation cursor rebuilds from the start of the same stream.
 * Neither path forks, appends, or calls a tool.
 */
export function planSessionResume(
  input: SessionResumeInput,
  signal?: AbortSignal,
): Result<SessionResumePlan, SessionResumeError> {
  if (signal?.aborted) {
    return err(resumeError("cancelled", "signal"));
  }
  const session = sessionSchema.safeParse(input.session);
  if (!session.success) {
    return err(resumeError("malformed", "session"));
  }
  if (session.data.closedAt !== null) {
    return err(resumeError("closed", "session"));
  }
  if (input.cursor === undefined || input.cursor === null) {
    const pending = parseEvents(input.events, session.data.streamId, null);
    if (!pending.ok) {
      return pending;
    }
    return ok(
      planOf("rebuild", session.data.sessionId, session.data.streamId, null, pending.value),
    );
  }
  const cursor = cursorSchema.safeParse(input.cursor);
  if (!cursor.success) {
    return err(resumeError("malformed", "cursor"));
  }
  if (cursor.data.streamId !== session.data.streamId) {
    return err(resumeError("malformed", "cursor.streamId"));
  }
  if (cursor.data.schemaGeneration !== TERMINAL_OUTCOME_PROJECTION_GENERATION) {
    const pending = parseEvents(input.events, session.data.streamId, null);
    if (!pending.ok) {
      return pending;
    }
    return ok(
      planOf("rebuild", session.data.sessionId, session.data.streamId, null, pending.value),
    );
  }
  const pending = parseEvents(input.events, session.data.streamId, cursor.data.afterSequence);
  if (!pending.ok) {
    return pending;
  }
  return ok(
    planOf(
      "continue",
      session.data.sessionId,
      session.data.streamId,
      cursor.data.afterSequence,
      pending.value,
    ),
  );
}
