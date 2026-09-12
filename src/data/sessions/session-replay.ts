import { artifactId } from "../../domain/artifacts/index.ts";
import { HISTORY_LIMITS } from "../../domain/sessions/history.ts";
import { createStoredHistoryReader } from "./history-reader.ts";
import { SESSION_ARTIFACT_SEEDS } from "./history-schema.ts";
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
  MAX_ARTIFACT_LIST_LIMIT,
} from "../../domain/artifacts/index.ts";
import type { ExportName } from "../../domain/extensions/index.ts";
import {
  configurationGeneration,
  err,
  ok,
  type Result,
  type RunId,
  type SessionId,
  type StreamId,
  type WorkspaceId,
} from "../../domain/foundation/index.ts";
import {
  classifyTurnReplay,
  EXPORT_FORMAT,
  type ExportError,
  type ExportRecordLine,
  type ImportError,
  type ImportResult,
  MAX_RECORD_LIST_LIMIT,
  parseExportRecordLine,
  type RecordError,
  type SessionFork,
  type SessionRecord,
  type SessionReplay,
} from "../../domain/sessions/index.ts";
import { createArtifactRepository } from "../artifacts/artifact-repository.ts";
import { createArtifactStore } from "../artifacts/artifact-store.ts";
import { replayPackageData } from "../extensions/package-data-import-repository.ts";
import { EXPORT_CHUNK_BYTES, type ExportOptions, verifyPackage } from "../lifecycle/export.ts";

export type ImportOptions = ExportOptions & {
  readonly runId: RunId;
  readonly importPackageData?: (
    bundles: readonly import("../../domain/extensions/package-data-transfer.ts").PackageDataBundle[],
    signal?: AbortSignal,
  ) => Result<readonly string[], ImportError>;
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
  let packageDataImports: readonly string[] = [];
  if ((verified.value.manifest.packageData?.length ?? 0) > 0) {
    if (!options.importPackageData)
      return err({
        kind: "import",
        code: "malformed-record",
        issues: [{ path: "packageData", code: "owner-unavailable" }],
      });
    const imported = options.importPackageData(verified.value.manifest.packageData ?? [], signal);
    if (!imported.ok) return imported;
    packageDataImports = imported.value;
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

  const lines = new TextDecoder().decode(body.value).split("\n");
  for (const phase of ["records", "artifacts", "events"] as const) {
    for (const raw of lines) {
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
      const belongs =
        line.value.entity === "event"
          ? "events"
          : line.value.entity === "artifact"
            ? "artifacts"
            : "records";
      if (belongs !== phase) continue;
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
  }
  if (sessionIds.length === 0) {
    return err({ kind: "import", code: "empty-package" });
  }
  return ok({
    sessionIds,
    events,
    artifacts,
    ...(packageDataImports.length === 0 ? {} : { packageDataImports }),
  });
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

  const history = await createStoredHistoryReader(
    options,
    (event) => event.correlation.sessionId === sessionId,
  ).page(
    { streamId: session.value.streamId, afterSequence: null, limit: HISTORY_LIMITS.page },
    signal,
  );
  if (!history.ok)
    return err({
      kind: "import",
      code: "malformed-record",
      issues: [{ path: "history", code: history.code }],
    });
  const collected = history.items.flatMap((item) => (item.event ? [item.event] : []));

  const classified = classifyTurnReplay(collected);
  const turns = classified.kind === "empty" ? [] : classified.reduction.turns;
  const listed = listSessionArtifacts(options, sessionId);
  if (!listed.ok) {
    return listed;
  }
  const packageData = replayPackageData(options.store, sessionId);
  if (!packageData.ok)
    return err({
      kind: "import",
      code: "malformed-record",
      issues: [{ path: "packageData", code: packageData.error.code }],
    });

  return ok({
    sessionId,
    ...(packageData.value.length === 0 ? {} : { packageData: packageData.value }),
    streamId: session.value.streamId,
    ...(session.value.extensionCatalog === undefined
      ? {}
      : { extensionCatalog: session.value.extensionCatalog }),
    turns,
    artifacts: listed.value.records,
    report: classified.report,
    history,
    truncated: history.next !== null || listed.value.truncated,
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
  const inserted = options.repositories.sessions.fork
    ? options.repositories.sessions.fork(source.value, forked, signal)
    : options.repositories.sessions.insert(forked, signal);
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
): Result<
  { readonly records: readonly ArtifactRecord[]; readonly truncated: boolean },
  ImportError
> {
  const repository = createArtifactRepository(options.store, options.runId);
  const rows = options.store.read(SESSION_ARTIFACT_SEEDS, {
    sessionId,
    limit: MAX_ARTIFACT_LIST_LIMIT + 1,
  });
  if (!rows.ok)
    return err({
      kind: "import",
      code: "export",
      error: { kind: "export", code: "storage", error: rows.error },
    });
  const listed: ArtifactRecord[] = [];
  for (const row of rows.value.slice(0, MAX_ARTIFACT_LIST_LIMIT)) {
    const id = artifactId.parse(row.artifactId);
    if (!id.ok) continue;
    const found = repository.get(id.value);
    if (!found.ok) return err({ kind: "import", code: "artifact", error: found.error });
    if (found.value) listed.push(found.value);
  }
  return ok({ records: listed, truncated: rows.value.length > MAX_ARTIFACT_LIST_LIMIT });
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
