/**
 * Export: resolving a selection, bounding it, writing it, and proving it.
 *
 * The pipeline mirrors artifact ingest rather than inventing a second shape:
 *
 * ```text
 * resolve selection → bound the inventory → stage destination → stream members
 *                  → write the manifest trailer → atomic finalize
 * ```
 *
 * Seven rules the implementation carries rather than documents:
 *
 * - **Nothing is written until the inventory is bounded.** Counts, artifact
 *   bytes, and free space are all checked first, so a selection too large is an
 *   error rather than a package that stops halfway.
 * - **The manifest is written last and found first.** Member digests are known
 *   only once they have been streamed, so the manifest is a trailer; a
 *   fixed-width footer makes it findable by seeking from the end, which is what
 *   lets a reader refuse an incompatible package before reading its body.
 * - **An omission is written down.** An artifact the selection reached and the
 *   package could not carry appears in the manifest with a reason. Silence
 *   would make the package unauditable.
 * - **A redaction is written down.** Secrets in records are replaced before
 *   they reach the package, and the manifest names each path. The original
 *   bytes never appear on that list. Configuration metadata is an
 *   already-redacted snapshot the caller supplied.
 * - **`restricted` never leaves, whatever the selection says.** The sensitivity
 *   vocabulary decides that, not a flag, and a selection cannot opt back in.
 * - **Bytes are re-hashed as they are copied.** A digest that changed between
 *   inventory and write means the bytes moved underneath the export, and that
 *   is reported rather than written around.
 * - **A failed or cancelled export leaves nothing behind.** The staged package
 *   is discarded, so a half-written one is never where a finished one would be.
 */

import {
  type ArtifactApiError,
  type ArtifactId,
  artifactMemberName,
  type BlobStorePort,
  type ClockPort,
  type ContentDigest,
  type ContentHasherPort,
  EMPTY_COUNTS,
  type EventStorePort,
  EXPORT_FOOTER_BYTES,
  EXPORT_FOOTER_DIGITS,
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION,
  type ExportArtifactEntry,
  type ExportBound,
  type ExportConfigurationEntry,
  type ExportCounts,
  type ExportError,
  type ExportInventory,
  type ExportManifest,
  type ExportMember,
  type ExportMemberCheck,
  type ExportName,
  type ExportOmission,
  type ExportRedaction,
  type ExportResult,
  type ExportSchemaFamilyDeclaration,
  type ExportSelection,
  type ExportVerification,
  err,
  isCompatible,
  MAX_ARTIFACT_LINEAGE_DEPTH,
  MAX_EXPORT_CONFIGURATION_ENTRIES,
  MAX_EXPORT_CONFIGURATION_KEY,
  MAX_EXPORT_CONFIGURATION_VALUE,
  MAX_EXPORT_MEMBERS,
  MAX_EXPORTED_ARTIFACTS,
  MAX_EXPORTED_EVENTS,
  MAX_EXPORTED_SESSIONS,
  MAX_MANIFEST_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_RECORD_LIST_LIMIT,
  MAX_STREAM_READ_LIMIT,
  MINIMUM_COMPATIBLE_EXPORT_SCHEMA_VERSION,
  ok,
  type PackageWriterPort,
  parseExportManifest,
  RECORDS_MEMBER,
  type RecordError,
  type RecordRepositories,
  type Result,
  RUNTIME_EVENT_SCHEMA_FAMILY,
  RUNTIME_EVENT_SCHEMA_VERSION,
  type RuntimeEvent,
  redactExportValue,
  type SensitiveValueRedactor,
  type Sequence,
  type SessionId,
  type SqliteRow,
  type SqliteStoreError,
  type SqliteStorePort,
  type SqliteValue,
  sessionId,
  summarize,
  type Timestamp,
  timestampFromEpochMilliseconds,
  walkArtifactLineage,
} from "../domain/index.ts";
import { createArtifactProvenanceRepository } from "./artifact-provenance-repository.ts";
import { ARTIFACTS_TABLE } from "./artifact-schema.ts";
import { SESSIONS_TABLE } from "./schema.ts";

/** How many bytes one artifact copy moves at a time. */
export const EXPORT_CHUNK_BYTES = 1_024 * 1_024;

/**
 * The families every package this build writes declares.
 *
 * Fixed rather than derived from `counts.events`, because a family describes the
 * shape a reader must understand and not the rows that happen to be present:
 * the records member is this family's canonical encoding by construction, so a
 * selection whose sessions produced no events still carries a member defined in
 * its terms. Deriving the list would turn such a selection into an empty list,
 * which the parser refuses — an unexportable legal selection.
 */
export const WRITTEN_SCHEMA_FAMILIES: readonly ExportSchemaFamilyDeclaration[] = [
  { family: RUNTIME_EVENT_SCHEMA_FAMILY, schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION },
];

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

export type ExportOptions = {
  readonly store: SqliteStorePort;
  readonly repositories: RecordRepositories;
  readonly events: EventStorePort;
  readonly blobs: BlobStorePort;
  readonly packages: PackageWriterPort;
  readonly hasher: ContentHasherPort;
  readonly clock: ClockPort;
  /** The build that writes the manifest's `createdBy`. */
  readonly buildIdentity: string;
  /**
   * Required so a package cannot be written without walking secrets.
   *
   * The runtime redactor lives in the application layer; this path depends
   * on the domain port only.
   */
  readonly redactor: SensitiveValueRedactor;
  /** Already-redacted configuration facts to declare on the package. */
  readonly configuration?: readonly ExportConfigurationEntry[];
  readonly maxPackageBytes?: number;
};

function storageError(error: SqliteStoreError): ExportError {
  return { kind: "export", code: "storage", error };
}

function oversize(bound: ExportBound, requested: number, maximum: number): ExportError {
  return { kind: "export", code: "oversize", bound, requested, maximum };
}

function textOf(value: SqliteValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function integerOf(value: SqliteValue | undefined): number | null {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : null;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

const cancelled: ExportError = { kind: "export", code: "cancelled" };

/**
 * Resolves a selection into everything the package will carry.
 *
 * Every bound is checked here, before the writer is asked for anything, which
 * is what makes "a selection above its bound is an error" true rather than
 * aspirational.
 */
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
function fromRecordError(error: RecordError): ExportError {
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
async function eachEvent(
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
type MemberSink = {
  write(chunk: Uint8Array): Promise<Result<null, ExportError>>;
  finish(): { readonly byteLength: number; readonly digest: ContentDigest };
};

/**
 * The bytes one package has written so far, shared by every member.
 *
 * The ceiling has to be enforced here rather than only over the inventory,
 * because the records member's size is not knowable until it has been
 * generated: a selection with no artifacts at all still produces a member whose
 * length grows with every session, turn, and event it names. Checking only the
 * artifact total would let such a selection publish a package many times the
 * configured limit.
 */
type PackageBudget = {
  spend(bytes: number): ExportError | null;
  spent(): number;
};

function createBudget(ceiling: number): PackageBudget {
  let spent = 0;
  return {
    spend(bytes: number): ExportError | null {
      spent += bytes;
      return spent > ceiling ? oversize("package-bytes", spent, ceiling) : null;
    },
    spent: () => spent,
  };
}

function createSink(
  options: ExportOptions,
  name: ExportName,
  budget: PackageBudget,
  signal: AbortSignal | undefined,
): MemberSink {
  const hasher = options.hasher.create();
  let byteLength = 0;
  return {
    async write(chunk: Uint8Array): Promise<Result<null, ExportError>> {
      // Checked before the chunk is written, so the ceiling bounds what reaches
      // the device rather than what has already reached it.
      const exceeded = budget.spend(chunk.byteLength);
      if (exceeded !== null) {
        return err(exceeded);
      }
      const written = await options.packages.write(name, chunk, signal);
      if (!written.ok) {
        return err({ kind: "export", code: "package", error: written.error });
      }
      hasher.update(chunk);
      byteLength += chunk.byteLength;
      return ok(null);
    },
    finish: () => ({ byteLength, digest: hasher.digest() }),
  };
}

const encoder = new TextEncoder();

/**
 * Writes one package and publishes it atomically.
 *
 * The staged package is discarded on every failure path, including
 * cancellation, so the destination only ever holds a finished export.
 */
export async function writePackage(
  options: ExportOptions,
  name: ExportName,
  selection: ExportSelection,
  inventory: ExportInventory,
  signal?: AbortSignal,
): Promise<Result<ExportResult, ExportError>> {
  if (aborted(signal)) {
    // Checked before the writer is touched, so a cancellation that arrived
    // first reports as cancellation rather than as whatever the device said
    // when it was asked to do something during one.
    return err(cancelled);
  }
  const ceiling = Math.min(options.maxPackageBytes ?? MAX_PACKAGE_BYTES, MAX_PACKAGE_BYTES);

  const space = await options.packages.availableBytes(signal);
  if (!space.ok) {
    return err({ kind: "export", code: "package", error: space.error });
  }
  // `null` means the platform will not say. Refusing every export on that
  // basis, or promising space that was never confirmed, are both worse than
  // proceeding and letting the device report a full disk if it comes to that.
  if (space.value !== null && space.value < inventory.artifactBytes) {
    return err({
      kind: "export",
      code: "insufficient-space",
      requiredBytes: inventory.artifactBytes,
      availableBytes: space.value,
    });
  }

  const configuration = boundConfiguration(options.configuration ?? [], options.redactor);
  if (!configuration.ok) {
    return err(configuration.error);
  }

  const begun = await options.packages.begin(name, signal);
  if (!begun.ok) {
    return err({ kind: "export", code: "package", error: begun.error });
  }
  const budget = createBudget(ceiling);

  const abandon = async (failure: ExportError): Promise<Result<never, ExportError>> => {
    await options.packages.discard(name);
    return err(failure);
  };

  const header = await writeHeader(options, name, budget, signal);
  if (!header.ok) {
    return await abandon(header.error);
  }

  const members: ExportMember[] = [];

  const records = await writeRecords(options, name, inventory, budget, signal);
  if (!records.ok) {
    return await abandon(records.error);
  }
  members.push(records.value.member);

  for (const entry of inventory.artifacts) {
    if (aborted(signal)) {
      return await abandon(cancelled);
    }
    const copied = await copyArtifact(options, name, entry, budget, signal);
    if (!copied.ok) {
      return await abandon(copied.error);
    }
    members.push(copied.value);
  }

  const manifest: ExportManifest = {
    format: EXPORT_FORMAT,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    minimumCompatibleSchemaVersion: MINIMUM_COMPATIBLE_EXPORT_SCHEMA_VERSION,
    schemaFamilies: WRITTEN_SCHEMA_FAMILIES,
    createdAt: timestampFromEpochMilliseconds(options.clock.now()) as Timestamp,
    createdBy: options.buildIdentity,
    selection: summarize(selection, inventory.counts.sessions),
    counts: inventory.counts,
    members,
    omissions: inventory.omissions,
    redactions: records.value.redactions,
    configuration: configuration.value,
  };

  const trailer = encoder.encode(`${JSON.stringify(manifest)}\n`);
  if (trailer.byteLength > MAX_MANIFEST_BYTES) {
    return await abandon(oversize("manifest-bytes", trailer.byteLength, MAX_MANIFEST_BYTES));
  }
  const spentTrailer = budget.spend(trailer.byteLength);
  if (spentTrailer !== null) {
    return await abandon(spentTrailer);
  }
  const written = await options.packages.write(name, trailer, signal);
  if (!written.ok) {
    return await abandon({ kind: "export", code: "package", error: written.error });
  }

  // Fixed width, so a reader finds the trailer by arithmetic rather than by
  // scanning backwards for a delimiter that could occur inside the manifest.
  const footer = encoder.encode(
    `${String(trailer.byteLength).padStart(EXPORT_FOOTER_DIGITS, "0")}\n`,
  );
  const spentFooter = budget.spend(footer.byteLength);
  if (spentFooter !== null) {
    return await abandon(spentFooter);
  }
  const stamped = await options.packages.write(name, footer, signal);
  if (!stamped.ok) {
    return await abandon({ kind: "export", code: "package", error: stamped.error });
  }

  const closed = await options.packages.close(name, signal);
  if (!closed.ok) {
    return await abandon({ kind: "export", code: "package", error: closed.error });
  }
  if (aborted(signal)) {
    // Nothing has been published, so this cancellation still means "did not
    // happen" — which is exactly why it is checked before finalize and not
    // after.
    return await abandon(cancelled);
  }

  const finalized = await options.packages.finalize(name);
  if (!finalized.ok) {
    return await abandon({ kind: "export", code: "package", error: finalized.error });
  }

  return ok({
    name,
    manifest,
    byteLength: budget.spent(),
    // The publish stands. Reporting it as cancelled would tell a caller nothing
    // happened when a package is sitting at the destination.
    cancelledAfterFinalize: aborted(signal),
  });
}

async function writeHeader(
  options: ExportOptions,
  name: ExportName,
  budget: PackageBudget,
  signal: AbortSignal | undefined,
): Promise<Result<number, ExportError>> {
  const header = encoder.encode(`${EXPORT_FORMAT}\n`);
  const exceeded = budget.spend(header.byteLength);
  if (exceeded !== null) {
    return err(exceeded);
  }
  const written = await options.packages.write(name, header, signal);
  return written.ok
    ? ok(header.byteLength)
    : err({ kind: "export", code: "package", error: written.error });
}

/**
 * Streams every record the selection reached, one JSON object per line.
 *
 * Generated as it is written and hashed as it is generated, so the manifest can
 * declare its digest without the member ever existing twice. Secrets are
 * rewritten before a line is encoded; the original record is not mutated.
 */
async function writeRecords(
  options: ExportOptions,
  name: ExportName,
  inventory: ExportInventory,
  budget: PackageBudget,
  signal: AbortSignal | undefined,
): Promise<Result<{ member: ExportMember; redactions: readonly ExportRedaction[] }, ExportError>> {
  const sink = createSink(options, name, budget, signal);
  const redactions: ExportRedaction[] = [];

  for (const id of inventory.sessionIds) {
    if (aborted(signal)) {
      return err(cancelled);
    }
    const session = options.repositories.sessions.get(id);
    if (!session.ok) {
      return err(fromRecordError(session.error));
    }
    if (session.value === null) {
      return err({ kind: "export", code: "not-found", sessionId: id });
    }
    const wrote = await writeRedacted(
      options,
      sink,
      { entity: "session", record: session.value },
      redactions,
    );
    if (!wrote.ok) {
      return err(wrote.error);
    }

    const turns = options.repositories.turns.listByParent(id, MAX_RECORD_LIST_LIMIT);
    if (!turns.ok) {
      return err(fromRecordError(turns.error));
    }
    for (const turn of turns.value) {
      const wroteTurn = await writeRedacted(
        options,
        sink,
        { entity: "turn", record: turn },
        redactions,
      );
      if (!wroteTurn.ok) {
        return err(wroteTurn.error);
      }
      const children = await writeTurnChildren(options, sink, turn.turnId, redactions);
      if (!children.ok) {
        return err(children.error);
      }
    }

    const events = await eachEvent(
      options,
      id,
      (event) => writeRedacted(options, sink, { entity: "event", record: event }, redactions),
      signal,
    );
    if (!events.ok) {
      return err(events.error);
    }
  }

  const finished = sink.finish();
  return ok({
    member: {
      name: RECORDS_MEMBER,
      kind: "records",
      byteLength: finished.byteLength,
      digest: finished.digest,
    },
    redactions,
  });
}

async function writeRedacted(
  options: ExportOptions,
  sink: MemberSink,
  value: unknown,
  redactions: ExportRedaction[],
): Promise<Result<null, ExportError>> {
  const walked = redactExportValue(value, options.redactor, redactions);
  if (!walked.ok) {
    return walked;
  }
  return sink.write(line(walked.value));
}

async function writeTurnChildren(
  options: ExportOptions,
  sink: MemberSink,
  turnId: Parameters<RecordRepositories["modelAttempts"]["listByParent"]>[0],
  redactions: ExportRedaction[],
): Promise<Result<null, ExportError>> {
  const attempts = options.repositories.modelAttempts.listByParent(turnId, MAX_RECORD_LIST_LIMIT);
  if (!attempts.ok) {
    return err(fromRecordError(attempts.error));
  }
  for (const attempt of attempts.value) {
    const wrote = await writeRedacted(
      options,
      sink,
      { entity: "model-attempt", record: attempt },
      redactions,
    );
    if (!wrote.ok) {
      return err(wrote.error);
    }
  }

  const invocations = options.repositories.invocations.listByParent(turnId, MAX_RECORD_LIST_LIMIT);
  if (!invocations.ok) {
    return err(fromRecordError(invocations.error));
  }
  for (const invocation of invocations.value) {
    const wrote = await writeRedacted(
      options,
      sink,
      { entity: "invocation", record: invocation },
      redactions,
    );
    if (!wrote.ok) {
      return err(wrote.error);
    }
  }
  return ok(null);
}

function boundConfiguration(
  entries: readonly ExportConfigurationEntry[],
  redactor: SensitiveValueRedactor,
): Result<readonly ExportConfigurationEntry[], ExportError> {
  if (entries.length > MAX_EXPORT_CONFIGURATION_ENTRIES) {
    return err(oversize("configuration-entries", entries.length, MAX_EXPORT_CONFIGURATION_ENTRIES));
  }
  const next: ExportConfigurationEntry[] = [];
  for (const entry of entries) {
    if (entry.key.length < 1 || entry.key.length > MAX_EXPORT_CONFIGURATION_KEY) {
      return err(oversize("configuration-entries", entry.key.length, MAX_EXPORT_CONFIGURATION_KEY));
    }
    if (entry.source.length < 1 || entry.source.length > MAX_EXPORT_CONFIGURATION_KEY) {
      return err(
        oversize("configuration-entries", entry.source.length, MAX_EXPORT_CONFIGURATION_KEY),
      );
    }
    if (entry.value.length > MAX_EXPORT_CONFIGURATION_VALUE) {
      return err(
        oversize("configuration-entries", entry.value.length, MAX_EXPORT_CONFIGURATION_VALUE),
      );
    }
    const value = redactor.isSecretName(entry.key)
      ? redactor.placeholder
      : redactor.redactText(entry.value, MAX_EXPORT_CONFIGURATION_VALUE);
    next.push({ key: entry.key, source: entry.source, value });
  }
  return ok(next);
}

function line(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

/**
 * Copies one artifact's bytes into the package, re-hashing as it goes.
 *
 * The re-hash is the check the issue's edge case names: if the digest no longer
 * matches, the bytes moved underneath the export, and the package is abandoned
 * rather than written around.
 */
async function copyArtifact(
  options: ExportOptions,
  name: ExportName,
  entry: ExportArtifactEntry,
  budget: PackageBudget,
  signal: AbortSignal | undefined,
): Promise<Result<ExportMember, ExportError>> {
  const sink = createSink(options, name, budget, signal);
  let offset = 0;

  while (offset < entry.byteLength) {
    if (aborted(signal)) {
      return err(cancelled);
    }
    const length = Math.min(EXPORT_CHUNK_BYTES, entry.byteLength - offset);
    const read = await options.blobs.readRange(
      { scope: "content", digest: entry.digest },
      offset,
      length,
      signal,
    );
    if (!read.ok) {
      return err({ kind: "export", code: "bytes", error: read.error });
    }
    if (read.value.byteLength === 0) {
      // Fewer bytes than the record claims. Advancing by the requested length
      // would loop forever, and the package would carry a short member.
      return err({ kind: "export", code: "digest-mismatch", artifactId: entry.artifactId });
    }
    const wrote = await sink.write(read.value);
    if (!wrote.ok) {
      return err(wrote.error);
    }
    offset += read.value.byteLength;
  }

  const finished = sink.finish();
  if (finished.digest !== entry.digest || finished.byteLength !== entry.byteLength) {
    return err({ kind: "export", code: "digest-mismatch", artifactId: entry.artifactId });
  }
  return ok({
    name: artifactMemberName(entry.digest),
    kind: "artifact",
    byteLength: finished.byteLength,
    digest: finished.digest,
  });
}

/**
 * Reads a finished package and proves it is what its manifest says.
 *
 * Deliberately not an import: nothing here becomes domain state. It opens the
 * trailer, refuses an incompatible or malformed manifest, and re-hashes every
 * member against what was declared — which is what makes an export claim
 * checkable in a release where nothing can import one.
 */
export async function verifyPackage(
  options: ExportOptions,
  name: ExportName,
  signal?: AbortSignal,
): Promise<Result<ExportVerification, ExportError>> {
  const total = await options.packages.byteLength(name, signal);
  if (!total.ok) {
    return err({ kind: "export", code: "package", error: total.error });
  }
  if (total.value === null || total.value < EXPORT_FOOTER_BYTES) {
    return err({
      kind: "export",
      code: "truncated-package",
      expectedBytes: EXPORT_FOOTER_BYTES,
      observedBytes: total.value ?? 0,
    });
  }

  const footer = await read(
    options,
    name,
    total.value - EXPORT_FOOTER_BYTES,
    EXPORT_FOOTER_BYTES,
    signal,
  );
  if (!footer.ok) {
    return err(footer.error);
  }
  const manifestBytes = Number.parseInt(new TextDecoder().decode(footer.value).trim(), 10);
  if (
    !Number.isSafeInteger(manifestBytes) ||
    manifestBytes <= 0 ||
    manifestBytes > MAX_MANIFEST_BYTES ||
    manifestBytes + EXPORT_FOOTER_BYTES > total.value
  ) {
    return err({
      kind: "export",
      code: "truncated-package",
      expectedBytes: manifestBytes,
      observedBytes: total.value,
    });
  }

  const manifestStart = total.value - EXPORT_FOOTER_BYTES - manifestBytes;
  const raw = await read(options, name, manifestStart, manifestBytes, signal);
  if (!raw.ok) {
    return err(raw.error);
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(new TextDecoder().decode(raw.value));
  } catch {
    return err({
      kind: "export",
      code: "malformed-manifest",
      issues: [{ path: "manifest", code: "invalid_type" }],
    });
  }

  const manifest = parseExportManifest(candidate);
  if (!manifest.ok) {
    return err({ kind: "export", code: "malformed-manifest", issues: manifest.error });
  }
  if (!isCompatible(manifest.value, EXPORT_SCHEMA_VERSION)) {
    return err({
      kind: "export",
      code: "incompatible-version",
      packageSchemaVersion: manifest.value.schemaVersion,
      packageRequiresAtLeast: manifest.value.minimumCompatibleSchemaVersion,
      readerSchemaVersion: EXPORT_SCHEMA_VERSION,
    });
  }

  const checks: ExportMemberCheck[] = [];
  let offset = encoder.encode(`${EXPORT_FORMAT}\n`).byteLength;
  for (const member of manifest.value.members) {
    if (aborted(signal)) {
      return err(cancelled);
    }
    const check = await checkMember(options, name, member, offset, manifestStart, signal);
    if (!check.ok) {
      return err(check.error);
    }
    checks.push(check.value);
    offset += member.byteLength;
  }

  return ok({
    manifest: manifest.value,
    members: checks,
    verified: checks.every((check) => check.status === "verified"),
  });
}

async function checkMember(
  options: ExportOptions,
  name: ExportName,
  member: ExportMember,
  offset: number,
  bodyEnd: number,
  signal: AbortSignal | undefined,
): Promise<Result<ExportMemberCheck, ExportError>> {
  if (offset + member.byteLength > bodyEnd) {
    return ok({ name: member.name, status: "missing" });
  }
  const hasher = options.hasher.create();
  let consumed = 0;
  while (consumed < member.byteLength) {
    const length = Math.min(EXPORT_CHUNK_BYTES, member.byteLength - consumed);
    const chunk = await read(options, name, offset + consumed, length, signal);
    if (!chunk.ok) {
      return err(chunk.error);
    }
    if (chunk.value.byteLength === 0) {
      return ok({ name: member.name, status: "wrong-length" });
    }
    hasher.update(chunk.value);
    consumed += chunk.value.byteLength;
  }
  return ok({
    name: member.name,
    status: hasher.digest() === member.digest ? "verified" : "digest-mismatch",
  });
}

async function read(
  options: ExportOptions,
  name: ExportName,
  offset: number,
  length: number,
  signal: AbortSignal | undefined,
): Promise<Result<Uint8Array, ExportError>> {
  const bytes = await options.packages.readRange(name, offset, length, signal);
  return bytes.ok ? ok(bytes.value) : err({ kind: "export", code: "package", error: bytes.error });
}
