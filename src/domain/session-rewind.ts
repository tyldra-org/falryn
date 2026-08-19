/**
 * Session fork and rewind-as-new-history (#260).
 *
 * Rewind always forks. The source stream is never rewritten, truncated, or
 * deleted. Clone starts a new lineage with an empty restore set.
 */

import { z } from "zod";

import { brandedString } from "./branded-schema.ts";
import {
  type SessionId,
  type StreamId,
  sessionId,
  streamId,
  type TurnId,
  turnId,
  type WorkspaceId,
  workspaceId,
} from "./identity.ts";
import { MAX_RECORD_LIST_LIMIT } from "./records.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const SESSION_REWIND_VERSION = "session-rewind.v1";
export const SESSION_REWIND_SOURCE = "deterministic-session-fork";

export const SESSION_REWIND_KINDS = ["rewind", "fork", "clone"] as const;
export type SessionRewindKind = (typeof SESSION_REWIND_KINDS)[number];

export type SessionRewindErrorCode = "cancelled" | "malformed" | "not-found" | "oversized";

export type SessionRewindError = {
  readonly kind: "session-rewind";
  readonly code: SessionRewindErrorCode;
  readonly field: string | null;
};

export type SessionRewindProvenance = {
  readonly version: typeof SESSION_REWIND_VERSION;
  readonly source: typeof SESSION_REWIND_SOURCE;
  readonly model: null;
};

export type SessionRewindPlan = {
  readonly kind: SessionRewindKind;
  readonly sourceSessionId: SessionId;
  readonly sourceStreamId: StreamId;
  readonly sessionId: SessionId;
  readonly streamId: StreamId;
  readonly workspaceId: WorkspaceId;
  readonly parentTurnId: TurnId | null;
  readonly provenance: SessionRewindProvenance;
};

export type SessionRewindInput = {
  readonly source: unknown;
  readonly turns?: unknown;
  readonly identities: unknown;
  readonly edit: unknown;
};

const sourceSchema = z
  .object({
    sessionId: brandedString(sessionId),
    streamId: brandedString(streamId),
    workspaceId: brandedString(workspaceId),
  })
  .strict();

const identitiesSchema = z
  .object({
    sessionId: brandedString(sessionId),
    streamId: brandedString(streamId),
    workspaceId: brandedString(workspaceId),
  })
  .strict();

const turnSchema = z
  .object({
    turnId: brandedString(turnId),
  })
  .passthrough();

const rewindEditSchema = z
  .object({
    kind: z.literal("rewind"),
    atTurnId: z.string(),
  })
  .strict();

const forkEditSchema = z.object({ kind: z.literal("fork") }).strict();
const cloneEditSchema = z.object({ kind: z.literal("clone") }).strict();

function rewindError(code: SessionRewindErrorCode, field: string | null): SessionRewindError {
  return { kind: "session-rewind", code, field };
}

export function describeSessionRewindError(error: SessionRewindError): string {
  const field = error.field === null ? "rewind" : error.field;
  switch (error.code) {
    case "cancelled":
      return `cancelled ${field}`;
    case "malformed":
      return `malformed ${field}`;
    case "not-found":
      return `not-found ${field}`;
    case "oversized":
      return `oversized ${field}`;
    default:
      return assertNever(error.code, "unhandled session-rewind error");
  }
}

function parseTurns(value: unknown): Result<TurnId[], SessionRewindError> {
  if (value === undefined) {
    return ok([]);
  }
  if (!Array.isArray(value)) {
    return err(rewindError("malformed", "turns"));
  }
  if (value.length > MAX_RECORD_LIST_LIMIT) {
    return err(rewindError("oversized", "turns"));
  }
  const turns: TurnId[] = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const parsed = turnSchema.safeParse(item);
    if (!parsed.success) {
      return err(rewindError("malformed", `turns.${index}`));
    }
    if (seen.has(parsed.data.turnId)) {
      return err(rewindError("malformed", `turns.${index}.turnId`));
    }
    seen.add(parsed.data.turnId);
    turns.push(parsed.data.turnId);
  }
  return ok(turns);
}

function planOf(
  kind: SessionRewindKind,
  source: { sessionId: SessionId; streamId: StreamId },
  identities: { sessionId: SessionId; streamId: StreamId; workspaceId: WorkspaceId },
  parentTurnId: TurnId | null,
): SessionRewindPlan {
  return {
    kind,
    sourceSessionId: source.sessionId,
    sourceStreamId: source.streamId,
    sessionId: identities.sessionId,
    streamId: identities.streamId,
    workspaceId: identities.workspaceId,
    parentTurnId,
    provenance: {
      version: SESSION_REWIND_VERSION,
      source: SESSION_REWIND_SOURCE,
      model: null,
    },
  };
}

/**
 * Plans a new lineage. The source session and stream identities are preserved
 * on the plan so a caller cannot treat rewind as an in-place undo.
 */
export function planSessionRewind(
  input: SessionRewindInput,
  signal?: AbortSignal,
): Result<SessionRewindPlan, SessionRewindError> {
  if (signal?.aborted) {
    return err(rewindError("cancelled", "signal"));
  }
  const source = sourceSchema.safeParse(input.source);
  if (!source.success) {
    return err(rewindError("malformed", "source"));
  }
  const identities = identitiesSchema.safeParse(input.identities);
  if (!identities.success) {
    return err(rewindError("malformed", "identities"));
  }
  if (identities.data.sessionId === source.data.sessionId) {
    return err(rewindError("malformed", "identities.sessionId"));
  }
  if (identities.data.streamId === source.data.streamId) {
    return err(rewindError("malformed", "identities.streamId"));
  }
  const turns = parseTurns(input.turns);
  if (!turns.ok) {
    return turns;
  }
  if (input.edit === null || typeof input.edit !== "object") {
    return err(rewindError("malformed", "edit"));
  }
  const kind = "kind" in input.edit ? input.edit.kind : undefined;
  switch (kind) {
    case "rewind": {
      const parsed = rewindEditSchema.safeParse(input.edit);
      if (!parsed.success) {
        return err(rewindError("malformed", "edit"));
      }
      const at = brandedString(turnId).safeParse(parsed.data.atTurnId);
      if (!at.success) {
        return err(rewindError("malformed", "edit.atTurnId"));
      }
      if (!turns.value.includes(at.data)) {
        return err(rewindError("not-found", "edit.atTurnId"));
      }
      return ok(planOf("rewind", source.data, identities.data, at.data));
    }
    case "fork": {
      const parsed = forkEditSchema.safeParse(input.edit);
      if (!parsed.success) {
        return err(rewindError("malformed", "edit"));
      }
      const checkpoint = turns.value[turns.value.length - 1] ?? null;
      return ok(planOf("fork", source.data, identities.data, checkpoint));
    }
    case "clone": {
      const parsed = cloneEditSchema.safeParse(input.edit);
      if (!parsed.success) {
        return err(rewindError("malformed", "edit"));
      }
      return ok(planOf("clone", source.data, identities.data, null));
    }
    default:
      return err(rewindError("malformed", "edit.kind"));
  }
}
