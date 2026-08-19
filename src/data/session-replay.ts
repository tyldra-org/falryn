/**
 * Import a verified package and replay it without repeating effects.
 *
 * Verify is already a data-layer operation. This module is the missing second
 * half: records become local state, artifacts become local bytes, and a replay
 * rebuilds turns from the imported stream. Nothing here names a command
 * runner, a provider, or a network.
 */

import {
  type ArtifactRecord,
  type ArtifactStorePort,
  classifyTurnReplay,
  configurationGeneration,
  EXPORT_FORMAT,
  type ExportError,
  type ExportName,
  type ExportRecordLine,
  err,
  type ImportError,
  type ImportResult,
  MAX_ARTIFACT_LIST_LIMIT,
  MAX_RECORD_LIST_LIMIT,
  MAX_STREAM_READ_LIMIT,
  ok,
  parseExportRecordLine,
  type RecordError,
  type Result,
  type RunId,
  type RuntimeEvent,
  type SessionFork,
  type SessionId,
  type SessionRecord,
  type SessionReplay,
  type StreamId,
  type WorkspaceId,
} from "../domain/index.ts";
import { createArtifactRepository } from "./artifact-repository.ts";
import { createArtifactStore } from "./artifact-store.ts";
import { EXPORT_CHUNK_BYTES, type ExportOptions, verifyPackage } from "./export.ts";

export type ImportOptions = ExportOptions & {
  readonly runId: RunId;
};

const cancelled: ImportError = { kind: "import", code: "cancelled" };
const FORMAT_HEADER = new TextEncoder().encode(`${EXPORT_FORMAT}\n`);

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function fromExport(error: ExportError): ImportError {
  return { kind: "import", code: "export", error };
}

function fromRecord(error: RecordError): ImportError {
  return error.code === "already-exists"
    ? {
        kind: "import",
        code: "identity-collision",
        entity: error.entity === "projection-cursor" ? "session" : error.entity,
        identity: error.identity,
      }
    : { kind: "import", code: "record", error };
}

/**
 * Applies a verified package to this database, preserving declared identities.
 *
 * A colliding session, turn, invocation, event, or artifact is refused. Titles
 * are never consulted.
 */
export async function importPackage(
  options: ImportOptions,
  name: ExportName,
  signal?: AbortSignal,
): Promise<Result<ImportResult, ImportError>> {
  if (aborted(signal)) {
    return err(cancelled);
  }
  const verified = await verifyPackage(options, name, signal);
  if (!verified.ok) {
    return err(fromExport(verified.error));
  }
  if (!verified.value.verified) {
    return err({ kind: "import", code: "unverified-package" });
  }

  const recordsMember = verified.value.manifest.members.find((member) => member.kind === "records");
  if (recordsMember === undefined) {
    return err({ kind: "import", code: "empty-package" });
  }

  const body = await readMember(
    options,
    name,
    FORMAT_HEADER.byteLength,
    recordsMember.byteLength,
    signal,
  );
  if (!body.ok) {
    return err(body.error);
  }

  const sessionIds: SessionId[] = [];
  let events = 0;
  let artifacts = 0;
  const artifactStore = createArtifactStore({
    repository: createArtifactRepository(options.store, options.runId),
    blobs: options.blobs,
    hasher: options.hasher,
    clock: options.clock,
  });

  for (const raw of new TextDecoder().decode(body.value).split("\n")) {
    if (aborted(signal)) {
      return err(cancelled);
    }
    if (raw.length === 0) {
      continue;
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return err({
        kind: "import",
        code: "malformed-record",
        issues: [{ path: "line", code: "invalid_json" }],
      });
    }
    const line = parseExportRecordLine(parsedJson);
    if (!line.ok) {
      return err({ kind: "import", code: "malformed-record", issues: line.error });
    }
    const applied = await applyLine(
      options,
      artifactStore,
      name,
      verified.value.manifest.members,
      line.value,
      sessionIds,
      signal,
    );
    if (!applied.ok) {
      return err(applied.error);
    }
    if (line.value.entity === "event") {
      events += 1;
    }
    if (line.value.entity === "artifact") {
      artifacts += 1;
    }
  }

  if (sessionIds.length === 0) {
    return err({ kind: "import", code: "empty-package" });
  }
  return ok({ sessionIds, events, artifacts });
}

/**
 * Rebuilds a session's turns and artifacts from durable facts.
 *
 * The original stream is not executed. Missing artifacts are reported by the
 * store as unavailable rather than re-fetched.
 */
export async function replaySession(
  options: ImportOptions,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<Result<SessionReplay, ImportError>> {
  if (aborted(signal)) {
    return err(cancelled);
  }
  const session = options.repositories.sessions.get(sessionId);
  if (!session.ok) {
    return err(fromRecord(session.error));
  }
  if (session.value === null) {
    return err({
      kind: "import",
      code: "record",
      error: { kind: "record", code: "not-found", entity: "session", identity: sessionId },
    });
  }

  const collected: RuntimeEvent[] = [];
  let afterSequence: number | null = null;
  for (;;) {
    if (aborted(signal)) {
      return err(cancelled);
    }
    const page = await options.events.readFrom(
      {
        streamId: session.value.streamId,
        afterSequence: afterSequence === null ? null : (afterSequence as never),
      },
      MAX_STREAM_READ_LIMIT,
      signal,
    );
    if (!page.ok) {
      return err({ kind: "import", code: "events", error: page.error });
    }
    if (page.value.length === 0) {
      break;
    }
    collected.push(...page.value);
    afterSequence = page.value[page.value.length - 1]?.sequence ?? afterSequence;
    if (page.value.length < MAX_STREAM_READ_LIMIT) {
      break;
    }
  }

  const classified = classifyTurnReplay(collected);
  const turns = classified.kind === "empty" ? [] : classified.reduction.turns;
  const listed = listSessionArtifacts(options, sessionId);
  if (!listed.ok) {
    return listed;
  }

  return ok({
    sessionId,
    streamId: session.value.streamId,
    turns,
    artifacts: listed.value,
    report: classified.report,
    truncated: false,
  });
}

/**
 * Inserts a new session under new identities and a fresh configuration generation.
 *
 * Events stay on the source stream. The fork is a new lineage, not an undo.
 */
export function forkSession(
  options: ImportOptions,
  sourceSessionId: SessionId,
  identities: {
    readonly sessionId: SessionId;
    readonly streamId: StreamId;
    readonly workspaceId: WorkspaceId;
  },
  signal?: AbortSignal,
): Result<SessionFork, ImportError> {
  if (aborted(signal)) {
    return err(cancelled);
  }
  const source = options.repositories.sessions.get(sourceSessionId);
  if (!source.ok) {
    return err(fromRecord(source.error));
  }
  if (source.value === null) {
    return err({
      kind: "import",
      code: "record",
      error: { kind: "record", code: "not-found", entity: "session", identity: sourceSessionId },
    });
  }
  const existing = options.repositories.sessions.get(identities.sessionId);
  if (!existing.ok) {
    return err(fromRecord(existing.error));
  }
  if (existing.value !== null) {
    return err({
      kind: "import",
      code: "identity-collision",
      entity: "session",
      identity: identities.sessionId,
    });
  }

  const forked: SessionRecord = {
    ...source.value,
    sessionId: identities.sessionId,
    streamId: identities.streamId,
    workspaceId: identities.workspaceId,
    configurationGeneration: configurationGeneration.from(source.value.configurationGeneration + 1),
    closedAt: null,
    outcome: null,
  };
  const inserted = options.repositories.sessions.insert(forked, signal);
  if (!inserted.ok) {
    return err(fromRecord(inserted.error));
  }

  const turns = options.repositories.turns.listByParent(sourceSessionId, MAX_RECORD_LIST_LIMIT);
  if (!turns.ok) {
    return err(fromRecord(turns.error));
  }
  return ok({
    sessionId: identities.sessionId,
    sourceSessionId,
    streamId: identities.streamId,
    workspaceId: identities.workspaceId,
    parentTurnId: turns.value[0]?.turnId ?? null,
  });
}

async function applyLine(
  options: ImportOptions,
  artifactStore: ArtifactStorePort,
  name: ExportName,
  members: readonly {
    readonly name: string;
    readonly kind: string;
    readonly byteLength: number;
    readonly digest: string;
  }[],
  line: ExportRecordLine,
  sessionIds: SessionId[],
  signal: AbortSignal | undefined,
): Promise<Result<null, ImportError>> {
  switch (line.entity) {
    case "session": {
      const collision = options.repositories.sessions.get(line.record.sessionId);
      if (!collision.ok) {
        return err(fromRecord(collision.error));
      }
      if (collision.value !== null) {
        return err({
          kind: "import",
          code: "identity-collision",
          entity: "session",
          identity: line.record.sessionId,
        });
      }
      const inserted = options.repositories.sessions.insert(line.record, signal);
      if (!inserted.ok) {
        return err(fromRecord(inserted.error));
      }
      sessionIds.push(line.record.sessionId);
      return ok(null);
    }
    case "turn": {
      const inserted = options.repositories.turns.insert(line.record, signal);
      return inserted.ok ? ok(null) : err(fromRecord(inserted.error));
    }
    case "model-attempt": {
      const inserted = options.repositories.modelAttempts.insert(line.record, signal);
      return inserted.ok ? ok(null) : err(fromRecord(inserted.error));
    }
    case "invocation": {
      const inserted = options.repositories.invocations.insert(line.record, signal);
      return inserted.ok ? ok(null) : err(fromRecord(inserted.error));
    }
    case "event": {
      const appended = await options.events.append(line.record, signal);
      return appended.ok
        ? ok(null)
        : err({ kind: "import", code: "events", error: appended.error });
    }
    case "artifact": {
      return copyArtifact(options, artifactStore, name, members, line.record, signal);
    }
    default: {
      const _exhaustive: never = line;
      return _exhaustive;
    }
  }
}

function listSessionArtifacts(
  options: ImportOptions,
  sessionId: SessionId,
): Result<readonly ArtifactRecord[], ImportError> {
  const artifacts = createArtifactRepository(options.store, options.runId);
  const listed: ArtifactRecord[] = [];
  const turns = options.repositories.turns.listByParent(sessionId, MAX_RECORD_LIST_LIMIT);
  if (!turns.ok) {
    return err(fromRecord(turns.error));
  }
  for (const turn of turns.value) {
    const invocations = options.repositories.invocations.listByParent(
      turn.turnId,
      MAX_RECORD_LIST_LIMIT,
    );
    if (!invocations.ok) {
      return err(fromRecord(invocations.error));
    }
    for (const invocation of invocations.value) {
      const found = artifacts.listByInvocation(invocation.invocationId, MAX_ARTIFACT_LIST_LIMIT);
      if (!found.ok) {
        return err({ kind: "import", code: "artifact", error: found.error });
      }
      listed.push(...found.value);
    }
  }
  return ok(listed);
}

async function copyArtifact(
  options: ImportOptions,
  artifacts: ArtifactStorePort,
  name: ExportName,
  members: readonly {
    readonly name: string;
    readonly kind: string;
    readonly byteLength: number;
    readonly digest: string;
  }[],
  record: ArtifactRecord,
  signal: AbortSignal | undefined,
): Promise<Result<null, ImportError>> {
  const member = members.find(
    (entry) => entry.kind === "artifact" && entry.digest === record.digest,
  );
  if (member === undefined) {
    return ok(null);
  }
  const bytes = await readMember(
    options,
    name,
    memberOffset(members, member.name),
    member.byteLength,
    signal,
  );
  if (!bytes.ok) {
    return err(bytes.error);
  }
  const ingested = await artifacts.ingest({
    artifactId: record.artifactId,
    mediaType: record.mediaType,
    encoding: record.encoding,
    sensitivity: record.sensitivity,
    origin: record.origin,
    invocationId: record.invocationId,
    declaredByteLength: bytes.value.byteLength,
    content: (async function* () {
      yield bytes.value;
    })(),
  });
  if (!ingested.ok) {
    return err({ kind: "import", code: "artifact", error: ingested.error });
  }
  return ok(null);
}

function memberOffset(
  members: readonly { readonly name: string; readonly byteLength: number }[],
  name: string,
): number {
  let offset = FORMAT_HEADER.byteLength;
  for (const member of members) {
    if (member.name === name) {
      return offset;
    }
    offset += member.byteLength;
  }
  return offset;
}

async function readMember(
  options: ImportOptions,
  name: ExportName,
  offset: number,
  length: number,
  signal: AbortSignal | undefined,
): Promise<Result<Uint8Array, ImportError>> {
  const out = new Uint8Array(length);
  let consumed = 0;
  while (consumed < length) {
    const chunk = await options.packages.readRange(
      name,
      offset + consumed,
      Math.min(EXPORT_CHUNK_BYTES, length - consumed),
      signal,
    );
    if (!chunk.ok) {
      return err(fromExport({ kind: "export", code: "package", error: chunk.error }));
    }
    if (chunk.value.byteLength === 0) {
      return err(
        fromExport({
          kind: "export",
          code: "truncated-package",
          expectedBytes: length,
          observedBytes: consumed,
        }),
      );
    }
    out.set(chunk.value, consumed);
    consumed += chunk.value.byteLength;
  }
  return ok(out);
}
