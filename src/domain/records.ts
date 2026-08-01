/**
 * Falryn's durable records, and the repository contracts they travel through.
 *
 * A session holds turns, a turn holds the model attempts and capability
 * invocations it made, and every one of them ends in exactly one
 * {@link TerminalOutcome}. The types below are keyed by the branded identities
 * the rest of the domain already uses, so a turn identifier can never be stored
 * where a session identifier belongs, and no field is a bare string that a
 * caller could fill with the wrong opaque value.
 *
 * Three rules the types carry rather than document:
 *
 * - **A row is untrusted input.** Every record has a parser, and a record read
 *   back out of storage goes through it. A hand-edited database cannot inject
 *   an unknown outcome kind, a malformed identity, or an unbounded title into
 *   domain state.
 * - **A rejection reports structure only.** It carries a path and an issue
 *   code, never the rejected value, because a record may carry a title or a
 *   digest derived from something private.
 * - **A repository returns records, never rows.** No column name, SQL string,
 *   or database handle appears in any signature here, which is what lets the
 *   storage shape change without a caller noticing.
 *
 * Lifecycle is derived rather than stored twice: a record is running while its
 * completion time and outcome are `null`, and terminal once both are set. There
 * is no separate status column to disagree with them.
 */

import { z } from "zod";

import {
  brandedInteger,
  brandedString,
  terminalOutcomeSchema,
  timestampSchema,
  toCodecIssues,
} from "./branded-schema.ts";
import type { CodecIssue } from "./codec-error.ts";
import type { RuntimeEvent } from "./event.ts";
import {
  type CapabilityId,
  type ConfigurationGeneration,
  capabilityId,
  configurationGeneration,
  type InvocationId,
  invocationId,
  type ModelAttemptId,
  type ModelId,
  modelAttemptId,
  modelId,
  type ProviderId,
  providerId,
  type SessionId,
  type StreamId,
  sessionId,
  streamId,
  type TurnId,
  turnId,
  type WorkspaceId,
  workspaceId,
} from "./identity.ts";
import type { TerminalOutcome } from "./outcome.ts";
import { err, ok, type Result } from "./result.ts";
import type { SqliteStoreError } from "./sqlite.ts";
import type { Timestamp } from "./time.ts";

/** Longest session title stored. Titles are labels, not content. */
export const MAX_SESSION_TITLE_LENGTH = 200;

/** Longest input digest stored. A digest identifies input without holding it. */
export const MAX_INPUT_DIGEST_LENGTH = 128;

/** Digests are lowercase hexadecimal, so a digest column can never carry prose. */
const INPUT_DIGEST = /^[0-9a-f]+$/;

/** Most records one repository listing may return. */
export const MAX_RECORD_LIST_LIMIT = 1_000;

/**
 * A session: one workspace, one event stream, one lifecycle.
 *
 * `workspaceId` is an identity column with no foreign key. The workspace record
 * — canonical root, path normalization, Git identity — is owned elsewhere, and
 * a key pointing at a table this owner does not have would either block every
 * session write or force a stub row invented to satisfy it.
 */
export type SessionRecord = {
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  /** The stream this session's ordered facts are sequenced within. */
  readonly streamId: StreamId;
  readonly title: string | null;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly startedAt: Timestamp;
  readonly closedAt: Timestamp | null;
  readonly outcome: TerminalOutcome | null;
};

export type TurnRecord = {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  /** The turn this one forked from, or `null` at the head of a lineage. */
  readonly parentTurnId: TurnId | null;
  readonly startedAt: Timestamp;
  readonly completedAt: Timestamp | null;
  readonly outcome: TerminalOutcome | null;
};

export type ModelAttemptRecord = {
  readonly modelAttemptId: ModelAttemptId;
  readonly turnId: TurnId;
  readonly providerId: ProviderId;
  readonly modelId: ModelId;
  readonly startedAt: Timestamp;
  readonly completedAt: Timestamp | null;
  readonly outcome: TerminalOutcome | null;
};

/**
 * One capability invocation.
 *
 * The input is identified by digest rather than stored: a digest makes a retry
 * recognizable without keeping a copy of arguments that may name a path, a
 * host, or a secret. Effect certainty is not a column — it is carried by the
 * outcome, so a record can never claim a settled effect and an uncertain
 * outcome at the same time.
 */
export type InvocationRecord = {
  readonly invocationId: InvocationId;
  readonly turnId: TurnId;
  readonly capabilityId: CapabilityId;
  readonly capabilityVersion: number;
  readonly inputDigest: string;
  readonly startedAt: Timestamp;
  readonly completedAt: Timestamp | null;
  readonly outcome: TerminalOutcome | null;
};

export const RECORD_ENTITIES = [
  "session",
  "turn",
  "model-attempt",
  "invocation",
  "projection-cursor",
] as const;

export type RecordEntity = (typeof RECORD_ENTITIES)[number];

/**
 * Every way a repository fails.
 *
 * `identity` carries an identifier and nothing else. Identifiers are structural
 * — printable, bounded, and produced by Falryn — so naming the row that already
 * exists is what makes the failure diagnosable without echoing its contents.
 */
export type RecordError =
  /** A stored row is not a record this build can interpret. */
  | {
      readonly kind: "record";
      readonly code: "malformed-row";
      readonly entity: RecordEntity;
      readonly issues: readonly CodecIssue[];
    }
  /** The database refused, was busy, was cancelled, or is closed. */
  | {
      readonly kind: "record";
      readonly code: "storage";
      readonly entity: RecordEntity;
      readonly error: SqliteStoreError;
    }
  | {
      readonly kind: "record";
      readonly code: "already-exists";
      readonly entity: RecordEntity;
      readonly identity: string;
    }
  | {
      readonly kind: "record";
      readonly code: "not-found";
      readonly entity: RecordEntity;
      readonly identity: string;
    }
  | {
      readonly kind: "record";
      readonly code: "invalid-list-limit";
      readonly entity: RecordEntity;
      readonly requestedLimit: number;
      readonly maximumLimit: number;
    };

/**
 * What a repository write did.
 *
 * `cancelledAfterCommit` mirrors the store's contract: cancellation that
 * arrived after `COMMIT` did not undo it, and reporting it as `cancelled` would
 * tell a caller nothing happened when something did.
 */
export type RecordWrite = {
  readonly cancelledAfterCommit: boolean;
};

/** How a record reaches its terminal state. */
export type RecordCompletionInput = {
  readonly completedAt: Timestamp;
  readonly outcome: TerminalOutcome;
};

/**
 * The repository shape every record shares.
 *
 * Synchronous by construction: writes run inside one transaction, and a
 * transaction wraps synchronous work so nothing inside one can wait on a
 * provider, a process, the network, or a user.
 */
export type RecordRepositoryPort<Record, Id extends string, ParentId extends string> = {
  insert(record: Record, signal?: AbortSignal): Result<RecordWrite, RecordError>;
  complete(
    id: Id,
    completion: RecordCompletionInput,
    signal?: AbortSignal,
  ): Result<RecordWrite, RecordError>;
  get(id: Id): Result<Record | null, RecordError>;
  /** Lists a parent's records in start order. Bounded by {@link MAX_RECORD_LIST_LIMIT}. */
  listByParent(parentId: ParentId, limit: number): Result<readonly Record[], RecordError>;
};

export type SessionRepositoryPort = RecordRepositoryPort<SessionRecord, SessionId, WorkspaceId>;
export type TurnRepositoryPort = RecordRepositoryPort<TurnRecord, TurnId, SessionId>;
export type ModelAttemptRepositoryPort = RecordRepositoryPort<
  ModelAttemptRecord,
  ModelAttemptId,
  TurnId
>;
export type InvocationRepositoryPort = RecordRepositoryPort<InvocationRecord, InvocationId, TurnId>;

export type RecordRepositories = {
  readonly sessions: SessionRepositoryPort;
  readonly turns: TurnRepositoryPort;
  readonly modelAttempts: ModelAttemptRepositoryPort;
  readonly invocations: InvocationRepositoryPort;
};

const outcomeSchema = terminalOutcomeSchema.nullable();

const sessionSchema = z.object({
  sessionId: brandedString(sessionId),
  workspaceId: brandedString(workspaceId),
  streamId: brandedString(streamId),
  title: z.string().max(MAX_SESSION_TITLE_LENGTH).nullable(),
  configurationGeneration: brandedInteger(configurationGeneration),
  startedAt: timestampSchema,
  closedAt: timestampSchema.nullable(),
  outcome: outcomeSchema,
});

const turnSchema = z.object({
  turnId: brandedString(turnId),
  sessionId: brandedString(sessionId),
  parentTurnId: brandedString(turnId).nullable(),
  startedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  outcome: outcomeSchema,
});

const modelAttemptSchema = z.object({
  modelAttemptId: brandedString(modelAttemptId),
  turnId: brandedString(turnId),
  providerId: brandedString(providerId),
  modelId: brandedString(modelId),
  startedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  outcome: outcomeSchema,
});

const invocationSchema = z.object({
  invocationId: brandedString(invocationId),
  turnId: brandedString(turnId),
  capabilityId: brandedString(capabilityId),
  capabilityVersion: z.int().min(1),
  inputDigest: z.string().min(1).max(MAX_INPUT_DIGEST_LENGTH).regex(INPUT_DIGEST),
  startedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  outcome: outcomeSchema,
});

function parseWith<Value>(
  schema: z.ZodType<Value>,
  value: unknown,
): Result<Value, readonly CodecIssue[]> {
  const parsed = schema.safeParse(value);
  return parsed.success ? ok(parsed.data) : err(toCodecIssues(parsed.error));
}

export function parseSessionRecord(value: unknown): Result<SessionRecord, readonly CodecIssue[]> {
  return parseWith(sessionSchema, value);
}

export function parseTurnRecord(value: unknown): Result<TurnRecord, readonly CodecIssue[]> {
  return parseWith(turnSchema, value);
}

export function parseModelAttemptRecord(
  value: unknown,
): Result<ModelAttemptRecord, readonly CodecIssue[]> {
  return parseWith(modelAttemptSchema, value);
}

export function parseInvocationRecord(
  value: unknown,
): Result<InvocationRecord, readonly CodecIssue[]> {
  return parseWith(invocationSchema, value);
}

/**
 * Rebuilds an outcome from the two values a store keeps it in.
 *
 * An outcome is stored as its kind beside its effect certainty, so both stay
 * queryable and constrained by the schema rather than hidden inside a blob.
 * `completed` carries no effect in the domain — its effect is implied — so the
 * stored effect is dropped on the way back rather than being reintroduced as a
 * field the union does not have.
 *
 * The result is deliberately `unknown`: it is a candidate for
 * {@link terminalOutcomeSchema}, not an outcome yet.
 */
export function outcomeFromColumns(kind: unknown, effect: unknown): unknown {
  if (kind === null || kind === undefined) {
    return null;
  }
  return kind === "completed" ? { kind } : { kind, effect };
}

/**
 * One stable read structure for a session, its turns, and its events.
 *
 * Declared here so a transcript view, a JSON surface, and a diagnostic viewer
 * share the same key paths instead of each inventing their own. It carries
 * whole events rather than summaries, because a renderer that needs a payload
 * should not have to reach past this shape to get one.
 */
export type TurnView = {
  readonly turn: TurnRecord;
  readonly modelAttempts: readonly ModelAttemptRecord[];
  readonly invocations: readonly InvocationRecord[];
};

export type SessionView = {
  readonly session: SessionRecord;
  readonly turns: readonly TurnView[];
  readonly events: readonly RuntimeEvent[];
  /** Whether a bound stopped the read before the stream ended. */
  readonly truncated: boolean;
};
