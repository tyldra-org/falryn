/**
 * Transcript replay controls without repeating effects (#261).
 *
 * Play, pause, step, and seek move a cursor over declared events. They never
 * append, invoke a tool, or call a provider.
 */

import { z } from "zod";

import { brandedInteger, brandedString } from "./branded-schema.ts";
import { type Sequence, type StreamId, sequence, streamId } from "./identity.ts";
import { MAX_STREAM_READ_LIMIT } from "./limits.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const SESSION_REPLAY_CONTROL_VERSION = "session-replay-control.v1";
export const SESSION_REPLAY_CONTROL_SOURCE = "deterministic-event-replay";

export const SESSION_REPLAY_CONTROL_STATUSES = ["idle", "playing", "paused"] as const;
export type SessionReplayControlStatus = (typeof SESSION_REPLAY_CONTROL_STATUSES)[number];

export type SessionReplayControlErrorCode =
  | "cancelled"
  | "empty"
  | "malformed"
  | "not-found"
  | "oversized";

export type SessionReplayControlError = {
  readonly kind: "session-replay-control";
  readonly code: SessionReplayControlErrorCode;
  readonly field: string | null;
};

export type SessionReplayControlProvenance = {
  readonly version: typeof SESSION_REPLAY_CONTROL_VERSION;
  readonly source: typeof SESSION_REPLAY_CONTROL_SOURCE;
  readonly model: null;
};

export type SessionReplayControlState = {
  readonly status: SessionReplayControlStatus;
  readonly streamId: StreamId;
  readonly atSequence: Sequence | null;
  readonly applied: number;
  readonly provenance: SessionReplayControlProvenance;
};

export type SessionReplayControlInput = {
  readonly events: unknown;
  readonly state?: unknown;
  readonly command: unknown;
};

const eventSpineSchema = z
  .object({
    streamId: brandedString(streamId),
    sequence: brandedInteger(sequence),
  })
  .passthrough();

const stateSchema = z
  .object({
    status: z.enum(SESSION_REPLAY_CONTROL_STATUSES),
    streamId: brandedString(streamId),
    atSequence: brandedInteger(sequence).nullable(),
    applied: z.int().min(0),
  })
  .passthrough();

const playSchema = z.object({ kind: z.literal("play") }).strict();
const pauseSchema = z.object({ kind: z.literal("pause") }).strict();
const stepSchema = z.object({ kind: z.literal("step") }).strict();
const seekSchema = z
  .object({
    kind: z.literal("seek"),
    sequence: z.number().int(),
  })
  .strict();

function controlError(
  code: SessionReplayControlErrorCode,
  field: string | null,
): SessionReplayControlError {
  return { kind: "session-replay-control", code, field };
}

export function describeSessionReplayControlError(error: SessionReplayControlError): string {
  const field = error.field === null ? "replay" : error.field;
  switch (error.code) {
    case "cancelled":
      return `cancelled ${field}`;
    case "empty":
      return `empty ${field}`;
    case "malformed":
      return `malformed ${field}`;
    case "not-found":
      return `not-found ${field}`;
    case "oversized":
      return `oversized ${field}`;
    default:
      return assertNever(error.code, "unhandled session-replay-control error");
  }
}

type EventSpine = { readonly streamId: StreamId; readonly sequence: Sequence };

function parseEvents(value: unknown): Result<EventSpine[], SessionReplayControlError> {
  if (!Array.isArray(value)) {
    return err(controlError("malformed", "events"));
  }
  if (value.length > MAX_STREAM_READ_LIMIT) {
    return err(controlError("oversized", "events"));
  }
  const events: EventSpine[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = eventSpineSchema.safeParse(item);
    if (!parsed.success) {
      return err(controlError("malformed", `events.${index}`));
    }
    if (index > 0 && parsed.data.streamId !== events[0]?.streamId) {
      return err(controlError("malformed", `events.${index}.streamId`));
    }
    events.push({ streamId: parsed.data.streamId, sequence: parsed.data.sequence });
  }
  return ok(events);
}

function stateOf(
  status: SessionReplayControlStatus,
  stream: StreamId,
  atSequence: Sequence | null,
  applied: number,
): SessionReplayControlState {
  return {
    status,
    streamId: stream,
    atSequence,
    applied,
    provenance: {
      version: SESSION_REPLAY_CONTROL_VERSION,
      source: SESSION_REPLAY_CONTROL_SOURCE,
      model: null,
    },
  };
}

function indexOf(events: readonly EventSpine[], atSequence: Sequence | null): number {
  if (atSequence === null) {
    return -1;
  }
  return events.findIndex((event) => event.sequence === atSequence);
}

/**
 * Moves a replay cursor over declared events. Playback never repeats an effect
 * because this module has no port that could produce one.
 */
export function controlSessionReplay(
  input: SessionReplayControlInput,
  signal?: AbortSignal,
): Result<SessionReplayControlState, SessionReplayControlError> {
  if (signal?.aborted) {
    return err(controlError("cancelled", "signal"));
  }
  const events = parseEvents(input.events);
  if (!events.ok) {
    return events;
  }
  const stream = events.value[0]?.streamId;
  if (stream === undefined) {
    if (input.command === null || typeof input.command !== "object") {
      return err(controlError("malformed", "command"));
    }
    return err(controlError("empty", "events"));
  }
  const current =
    input.state === undefined
      ? stateOf("idle", stream, null, 0)
      : (() => {
          const parsed = stateSchema.safeParse(input.state);
          return parsed.success
            ? stateOf(
                parsed.data.status,
                parsed.data.streamId,
                parsed.data.atSequence,
                parsed.data.applied,
              )
            : null;
        })();
  if (current === null) {
    return err(controlError("malformed", "state"));
  }
  if (current.streamId !== stream) {
    return err(controlError("malformed", "state.streamId"));
  }
  if (input.command === null || typeof input.command !== "object") {
    return err(controlError("malformed", "command"));
  }
  const kind = "kind" in input.command ? input.command.kind : undefined;
  switch (kind) {
    case "play": {
      const parsed = playSchema.safeParse(input.command);
      if (!parsed.success) {
        return err(controlError("malformed", "command"));
      }
      return ok(stateOf("playing", stream, current.atSequence, current.applied));
    }
    case "pause": {
      const parsed = pauseSchema.safeParse(input.command);
      if (!parsed.success) {
        return err(controlError("malformed", "command"));
      }
      return ok(stateOf("paused", stream, current.atSequence, current.applied));
    }
    case "step": {
      const parsed = stepSchema.safeParse(input.command);
      if (!parsed.success) {
        return err(controlError("malformed", "command"));
      }
      const index = indexOf(events.value, current.atSequence) + 1;
      const next = events.value[index];
      if (next === undefined) {
        return err(controlError("empty", "command"));
      }
      return ok(stateOf("paused", stream, next.sequence, index + 1));
    }
    case "seek": {
      const parsed = seekSchema.safeParse(input.command);
      if (!parsed.success) {
        return err(controlError("malformed", "command"));
      }
      const at = brandedInteger(sequence).safeParse(parsed.data.sequence);
      if (!at.success) {
        return err(controlError("malformed", "command.sequence"));
      }
      const index = indexOf(events.value, at.data);
      if (index < 0) {
        return err(controlError("not-found", "command.sequence"));
      }
      return ok(stateOf("paused", stream, at.data, index + 1));
    }
    default:
      return err(controlError("malformed", "command.kind"));
  }
}
