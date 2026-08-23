/** Resolves and bounds export selections before any package write. */

import {
  type ArtifactApiError,
  type ArtifactId,
  type ContentDigest,
  EMPTY_COUNTS,
  type ExportArtifactEntry,
  type ExportCounts,
  type ExportError,
  type ExportInventory,
  type ExportOmission,
  type ExportSelection,
  err,
  MAX_ARTIFACT_LINEAGE_DEPTH,
  MAX_EXPORT_MEMBERS,
  MAX_EXPORTED_ARTIFACTS,
  MAX_EXPORTED_EVENTS,
  MAX_EXPORTED_SESSIONS,
  MAX_PACKAGE_BYTES,
  MAX_RECORD_LIST_LIMIT,
  MAX_STREAM_READ_LIMIT,
  ok,
  type RecordError,
  type Result,
  type RuntimeEvent,
  type Sequence,
  type SessionId,
  type SqliteRow,
  sessionId,
  walkArtifactLineage,
} from "../../domain/index.ts";
import { createArtifactProvenanceRepository } from "../artifact-provenance-repository.ts";
import { ARTIFACTS_TABLE } from "../artifact-schema.ts";
import { SESSIONS_TABLE } from "../schema.ts";
import {
  aborted,
  cancelled,
  type ExportOptions,
  integerOf,
  oversize,
  storageError,
  textOf,
} from "./shared.ts";

const SELECT_SESSIONS_IN_RANGE = `SELECT session_id AS sessionId FROM ${SESSIONS_TABLE}
  WHERE ($after IS NULL OR started_at >= $after)
    AND ($before IS NULL OR started_at <= $before)
  ORDER BY started_at, session_id LIMIT $limit`;

/**
 * Artifacts reachable from a session, through the invocations its turns made.
 *
 * The join is the first reachability rule: an artifact belongs to an export
 * because an invocation inside a selected session produced it. Versioned
 * bundles then walk the provenance graph from those seeds so a derived child
 * with no selected-session invocation is still in the package, subject to the
 * same sensitivity and availability omit rules.
 */
const SELECT_SESSION_ARTIFACTS = `SELECT DISTINCT
    a.artifact_id AS artifactId, a.digest AS digest, a.byte_length AS byteLength,
    a.sensitivity AS sensitivity, a.availability AS availability
  FROM ${ARTIFACTS_TABLE} a
  JOIN invocations i ON i.invocation_id = a.invocation_id
  JOIN turns t ON t.turn_id = i.turn_id
  WHERE t.session_id = $sessionId
  ORDER BY a.created_at, a.artifact_id
  LIMIT $limit`;

const SELECT_ARTIFACT_BY_ID = `SELECT
    a.artifact_id AS artifactId, a.digest AS digest, a.byte_length AS byteLength,
    a.sensitivity AS sensitivity, a.availability AS availability
  FROM ${ARTIFACTS_TABLE} a
  WHERE a.artifact_id = $artifactId`;

export const SELECT_ARTIFACT_RECORD = `SELECT
    artifact_id AS artifactId, digest AS digest, media_type AS mediaType,
    encoding AS encoding, byte_length AS byteLength, sensitivity AS sensitivity,
    origin AS origin, invocation_id AS invocationId, created_at AS createdAt,
    finalized_at AS finalizedAt, availability AS availability
  FROM ${ARTIFACTS_TABLE}
  WHERE artifact_id = $artifactId`;

export async function resolveInventory(
  options: ExportOptions,
  selection: ExportSelection,
  signal?: AbortSignal,
): Promise<Result<ExportInventory, ExportError>> {
  if (aborted(signal)) {
    return err(cancelled);
  }

  const sessions = resolveSessions(options, selection);
  if (!sessions.ok) {
    return err(sessions.error);
  }
  if (sessions.value.length === 0) {
    return err({ kind: "export", code: "empty-selection" });
  }
  if (sessions.value.length > MAX_EXPORTED_SESSIONS) {
    return err(oversize("sessions", sessions.value.length, MAX_EXPORTED_SESSIONS));
  }

  const counts: {
    -readonly [Key in keyof ExportCounts]: ExportCounts[Key];
  } = { ...EMPTY_COUNTS, sessions: sessions.value.length };
  const artifacts: ExportArtifactEntry[] = [];
  const carried = new Set<ContentDigest>();
  const decided = new Set<string>();
  const omissions: ExportOmission[] = [];
  let artifactBytes = 0;

  for (const session of sessions.value) {
    if (aborted(signal)) {
      return err(cancelled);
    }
    const counted = countSession(options, session, counts);
    if (!counted.ok) {
      return err(counted.error);
    }
    // Counted here rather than while writing, because the manifest declares
    // these numbers and a count taken after the fact could only ever agree with
    // itself. It is also where the bound is enforced.
    const events = await countEvents(options, session, signal);
    if (!events.ok) {
      return err(events.error);
    }
    counts.events += events.value;
    if (counts.events > MAX_EXPORTED_EVENTS) {
      return err(oversize("events", counts.events, MAX_EXPORTED_EVENTS));
    }

    const reachable = readSessionArtifacts(options, session);
    if (!reachable.ok) {
      return err(reachable.error);
    }
    for (const candidate of reachable.value) {
      artifactBytes += includeOrOmit(
        candidate,
        selection.includeSensitive,
        carried,
        decided,
        artifacts,
        omissions,
        counts,
      );
    }
  }

  const expanded = expandProvenance(options, decided, selection.includeSensitive, {
    artifacts,
    carried,
    omissions,
    counts,
  });
  if (!expanded.ok) {
    return err(expanded.error);
  }
  artifactBytes += expanded.value;

  if (artifacts.length > MAX_EXPORTED_ARTIFACTS) {
    return err(oversize("artifacts", artifacts.length, MAX_EXPORTED_ARTIFACTS));
  }
  if (artifacts.length + 1 > MAX_EXPORT_MEMBERS) {
    return err(oversize("members", artifacts.length + 1, MAX_EXPORT_MEMBERS));
  }
  const ceiling = Math.min(options.maxPackageBytes ?? MAX_PACKAGE_BYTES, MAX_PACKAGE_BYTES);
  if (artifactBytes > ceiling) {
    return err(oversize("package-bytes", artifactBytes, ceiling));
  }

  return ok({
    counts,
    sessionIds: sessions.value,
    artifacts,
    omissions,
    artifactBytes,
  });
}

/** One artifact as the inventory sees it, before it is included or omitted. */
type ReachableArtifact = ExportArtifactEntry & {
  readonly sensitivity: string;
  readonly availability: string;
};

type InventoryBuckets = {
  readonly artifacts: ExportArtifactEntry[];
  readonly carried: Set<ContentDigest>;
  readonly omissions: ExportOmission[];
  readonly counts: { -readonly [Key in keyof ExportCounts]: ExportCounts[Key] };
};

/**
 * Whether an artifact is carried, and why not when it is not.
 *
 * `restricted` is checked first and is not reachable by any flag: the
 * vocabulary that declared it says those bytes do not leave the machine, and a
 * selection that could opt back in would make the label decoration.
 */
function decide(
  candidate: ReachableArtifact,
  includeSensitive: boolean,
): ExportOmission["reason"] | null {
  if (candidate.sensitivity === "restricted") {
    return "restricted-sensitivity";
  }
  if (candidate.availability === "quarantined") {
    return "bytes-quarantined";
  }
  if (candidate.availability !== "available") {
    return "bytes-missing";
  }
  if (candidate.sensitivity === "sensitive" && !includeSensitive) {
    return "sensitive-not-selected";
  }
  return null;
}

function resolveSessions(
  options: ExportOptions,
  selection: ExportSelection,
): Result<readonly SessionId[], ExportError> {
  if (selection.kind === "sessions") {
    for (const id of selection.sessionIds) {
      const found = options.repositories.sessions.get(id);
      if (!found.ok) {
        return err(fromRecordError(found.error));
      }
      if (found.value === null) {
        return err({ kind: "export", code: "not-found", sessionId: id });
      }
    }
    return ok(selection.sessionIds);
  }

  const rows = options.store.read(SELECT_SESSIONS_IN_RANGE, {
    after: selection.startedAfter,
    before: selection.startedBefore,
    limit: MAX_EXPORTED_SESSIONS + 1,
  });
  if (!rows.ok) {
    return err(storageError(rows.error));
  }
  const sessions: SessionId[] = [];
  for (const row of rows.value) {
    const parsed = sessionId.parse(textOf(row.sessionId));
    if (parsed.ok) {
      sessions.push(parsed.value);
    }
  }
  return ok(sessions);
}

function includeOrOmit(
  candidate: ReachableArtifact,
  includeSensitive: boolean,
  carried: Set<ContentDigest>,
  decided: Set<string>,
  artifacts: ExportArtifactEntry[],
  omissions: ExportOmission[],
  counts: { -readonly [Key in keyof ExportCounts]: ExportCounts[Key] },
): number {
  if (decided.has(candidate.artifactId)) {
    return 0;
  }
  decided.add(candidate.artifactId);
  const decision = decide(candidate, includeSensitive);
  if (decision !== null) {
    omissions.push({ artifactId: candidate.artifactId, reason: decision });
    return 0;
  }
  if (carried.has(candidate.digest)) {
    // Exact bytes are carried once. Two records sharing a digest is the
    // deduplication the artifact store already performs, and a package
    // repeating those bytes would be larger for no reason.
    counts.artifacts += 1;
    return 0;
  }
  carried.add(candidate.digest);
  artifacts.push({
    artifactId: candidate.artifactId,
    digest: candidate.digest,
    byteLength: candidate.byteLength,
  });
  counts.artifacts += 1;
  return candidate.byteLength;
}

function fromProvenance(error: ArtifactApiError): ExportError {
  if (
    error.kind === "artifact" &&
    error.code === "storage" &&
    error.failure.medium === "metadata"
  ) {
    return storageError(error.failure.error);
  }
  return storageError({
    kind: "sqlite-store",
    code: "statement-rejected",
    operation: "read",
    effect: "none",
    cause: {
      kind: "sqlite",
      code: "io-failure",
      operation: "read",
      driverCode: null,
      detail: null,
    },
  });
}

/**
 * Walks parents and children of every invocation-reachable artifact.
 *
 * A derived child with no selected-session invocation is still in the bundle
 * when an ancestor or descendant was reached, subject to the same omit rules.
 */
function expandProvenance(
  options: ExportOptions,
  decided: Set<string>,
  includeSensitive: boolean,
  buckets: InventoryBuckets,
): Result<number, ExportError> {
  const provenance = createArtifactProvenanceRepository(options.store);
  const related = new Set<ArtifactId>();
  for (const seed of decided) {
    const id = seed as ArtifactId;
    const parents = walkArtifactLineage(
      id,
      (from) => provenance.listParents(from),
      (edge) => edge.parentArtifactId,
      MAX_ARTIFACT_LINEAGE_DEPTH,
    );
    if (!parents.ok) {
      return err(fromProvenance(parents.error));
    }
    const children = walkArtifactLineage(
      id,
      (from) => provenance.listChildren(from),
      (edge) => edge.childArtifactId,
      MAX_ARTIFACT_LINEAGE_DEPTH,
    );
    if (!children.ok) {
      return err(fromProvenance(children.error));
    }
    for (const edge of parents.value) {
      related.add(edge.parentArtifactId);
    }
    for (const edge of children.value) {
      related.add(edge.childArtifactId);
    }
  }

  let addedBytes = 0;
  for (const id of related) {
    if (decided.has(id)) {
      continue;
    }
    const candidate = readArtifactById(options, id);
    if (!candidate.ok) {
      return err(candidate.error);
    }
    if (candidate.value === null) {
      continue;
    }
    addedBytes += includeOrOmit(
      candidate.value,
      includeSensitive,
      buckets.carried,
      decided,
      buckets.artifacts,
      buckets.omissions,
      buckets.counts,
    );
  }
  return ok(addedBytes);
}

function readArtifactById(
  options: ExportOptions,
  id: ArtifactId,
): Result<ReachableArtifact | null, ExportError> {
  const rows = options.store.read(SELECT_ARTIFACT_BY_ID, { artifactId: id });
  if (!rows.ok) {
    return err(storageError(rows.error));
  }
  const row = rows.value[0];
  return ok(row === undefined ? null : parseReachable(row));
}

/**
 * A record failure carried onto the export vocabulary.
 *
 * Repositories report their own error shape; an export reports storage. The
 * database's own failure is preserved when there is one, because a caller
 * diagnosing a busy database needs it; anything else was a malformed row or a
 * bad bound, neither of which this module can produce, so it lands on the
 * generic member rather than inventing a code for a case that cannot happen.
 */
export function fromRecordError(error: RecordError): ExportError {
  return storageError(
    error.code === "storage"
      ? error.error
      : {
          kind: "sqlite-store",
          code: "statement-rejected",
          operation: "read",
          effect: "none",
          cause: {
            kind: "sqlite",
            code: "io-failure",
            operation: "read",
            driverCode: null,
            detail: null,
          },
        },
  );
}

function countSession(
  options: ExportOptions,
  session: SessionId,
  counts: { -readonly [Key in keyof ExportCounts]: ExportCounts[Key] },
): Result<null, ExportError> {
  const turns = options.repositories.turns.listByParent(session, MAX_RECORD_LIST_LIMIT);
  if (!turns.ok) {
    return err(fromRecordError(turns.error));
  }
  counts.turns += turns.value.length;

  for (const turn of turns.value) {
    const attempts = options.repositories.modelAttempts.listByParent(
      turn.turnId,
      MAX_RECORD_LIST_LIMIT,
    );
    if (!attempts.ok) {
      return err(fromRecordError(attempts.error));
    }
    counts.modelAttempts += attempts.value.length;

    const invocations = options.repositories.invocations.listByParent(
      turn.turnId,
      MAX_RECORD_LIST_LIMIT,
    );
    if (!invocations.ok) {
      return err(fromRecordError(invocations.error));
    }
    counts.invocations += invocations.value.length;
  }
  return ok(null);
}

/**
 * Reads one session's events a page at a time, stopping at the export bound.
 *
 * `readFrom` answers one bounded page, so a single call would export a stream's
 * first page and drop the rest without saying so. Paging until the stream is
 * exhausted is what makes the count in the manifest the count in the member.
 */
export async function eachEvent(
  options: ExportOptions,
  session: SessionId,
  visit: (event: RuntimeEvent) => Promise<Result<null, ExportError>> | Result<null, ExportError>,
  signal: AbortSignal | undefined,
): Promise<Result<number, ExportError>> {
  const record = options.repositories.sessions.get(session);
  if (!record.ok) {
    return err(fromRecordError(record.error));
  }
  if (record.value === null) {
    return err({ kind: "export", code: "not-found", sessionId: session });
  }

  let afterSequence: Sequence | null = null;
  let seen = 0;
  for (;;) {
    if (aborted(signal)) {
      return err(cancelled);
    }
    const page = await options.events.readFrom(
      { streamId: record.value.streamId, afterSequence },
      MAX_STREAM_READ_LIMIT,
      signal,
    );
    if (!page.ok) {
      // An event store failure is not a record failure, and folding the two
      // would send someone looking at the wrong table.
      return err({
        kind: "export",
        code: "storage",
        error:
          page.error.code === "storage"
            ? page.error.error
            : { kind: "sqlite-store", code: "closed", operation: "read", effect: "none" },
      });
    }
    for (const event of page.value) {
      const visited = await visit(event);
      if (!visited.ok) {
        return err(visited.error);
      }
      seen += 1;
      afterSequence = event.sequence;
    }
    if (page.value.length < MAX_STREAM_READ_LIMIT) {
      return ok(seen);
    }
    if (seen > MAX_EXPORTED_EVENTS) {
      return err(oversize("events", seen, MAX_EXPORTED_EVENTS));
    }
  }
}

function countEvents(
  options: ExportOptions,
  session: SessionId,
  signal: AbortSignal | undefined,
): Promise<Result<number, ExportError>> {
  return eachEvent(options, session, () => ok(null), signal);
}

function readSessionArtifacts(
  options: ExportOptions,
  session: SessionId,
): Result<readonly ReachableArtifact[], ExportError> {
  const rows = options.store.read(SELECT_SESSION_ARTIFACTS, {
    sessionId: session,
    limit: MAX_EXPORTED_ARTIFACTS + 1,
  });
  if (!rows.ok) {
    return err(storageError(rows.error));
  }
  const artifacts: ReachableArtifact[] = [];
  for (const row of rows.value) {
    const parsed = parseReachable(row);
    if (parsed !== null) {
      artifacts.push(parsed);
    }
  }
  return ok(artifacts);
}

function parseReachable(row: SqliteRow): ReachableArtifact | null {
  const id = textOf(row.artifactId);
  const digest = textOf(row.digest);
  const byteLength = integerOf(row.byteLength);
  const sensitivity = textOf(row.sensitivity);
  const availability = textOf(row.availability);
  if (
    id === null ||
    digest === null ||
    byteLength === null ||
    sensitivity === null ||
    availability === null
  ) {
    return null;
  }
  return {
    artifactId: id as ExportArtifactEntry["artifactId"],
    digest: digest as ContentDigest,
    byteLength,
    sensitivity,
    availability,
  };
}

/** A counting, hashing sink over the package writer. */
