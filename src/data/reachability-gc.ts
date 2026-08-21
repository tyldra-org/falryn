/**
 * Reachability garbage collection over durable sessions and artifacts (#725).
 *
 * Seeds are pinned sessions, open sessions, and sessions named by verified export
 * packages. Reachability walks invocation links and the provenance graph from
 * those seeds. Candidates are closed, unreachable sessions and available
 * artifacts with no retained reference. Execution rechecks each candidate before
 * deleting metadata and bytes.
 */

import {
  type ArtifactId,
  type ArtifactProvenancePort,
  type ArtifactRepositoryPort,
  artifactId,
  type BlobStorePort,
  type ContentDigest,
  type ExportName,
  err,
  exportName,
  type GcCandidate,
  type GcConfirmation,
  type GcOmission,
  type GcOutcome,
  type GcPlan,
  type GcPlanId,
  type GcRefusal,
  type GcRetainedCount,
  type GcRetentionReason,
  MAX_ARTIFACT_LINEAGE_DEPTH,
  MAX_EXPORTED_ARTIFACTS,
  MAX_EXPORTED_SESSIONS,
  type MeasurementCompleteness,
  ok,
  type PackageWriterPort,
  type ReachabilityGcError,
  type RecordRepositories,
  type Result,
  type SessionId,
  type SqliteStorePort,
  sessionId,
  walkArtifactLineage,
} from "../domain/index.ts";
import { createArtifactProvenanceRepository } from "./artifact-provenance-repository.ts";
import { ARTIFACT_TRANSFORMATIONS_TABLE } from "./artifact-provenance-schema.ts";
import { ARTIFACTS_TABLE } from "./artifact-schema.ts";
import { type ExportOptions, verifyPackage } from "./export.ts";
import {
  EVENTS_TABLE,
  INVOCATIONS_TABLE,
  MODEL_ATTEMPTS_TABLE,
  PROJECTION_CURSORS_TABLE,
  SESSIONS_TABLE,
  TURNS_TABLE,
} from "./schema.ts";

/** Sessions one plan may examine before reporting partial. */
export const MAX_GC_EXAMINED_SESSIONS = MAX_EXPORTED_SESSIONS;

/** Artifacts one plan may examine before reporting partial. */
export const MAX_GC_EXAMINED_ARTIFACTS = MAX_EXPORTED_ARTIFACTS;

/** Verified export packages consulted for session seeds. */
export const MAX_GC_EXPORT_PACKAGES = 32;

const SELECT_SESSIONS = `SELECT session_id AS sessionId, closed_at AS closedAt, stream_id AS streamId
  FROM ${SESSIONS_TABLE} ORDER BY started_at, session_id LIMIT $limit`;

const SELECT_SESSION_ARTIFACTS = `SELECT DISTINCT a.artifact_id AS artifactId
  FROM ${ARTIFACTS_TABLE} a
  JOIN ${INVOCATIONS_TABLE} i ON i.invocation_id = a.invocation_id
  JOIN ${TURNS_TABLE} t ON t.turn_id = i.turn_id
  WHERE t.session_id = $sessionId
  LIMIT $limit`;

const SELECT_ARTIFACTS = `SELECT artifact_id AS artifactId, digest AS digest,
  byte_length AS byteLength, availability AS availability
  FROM ${ARTIFACTS_TABLE} ORDER BY created_at, artifact_id LIMIT $limit`;

const SELECT_DIGEST_REFERENCES = `SELECT COUNT(*) AS count FROM ${ARTIFACTS_TABLE}
  WHERE digest = $digest AND artifact_id <> $artifactId`;

type SessionRow = {
  readonly sessionId: SessionId;
  readonly closedAt: string | null;
  readonly streamId: string;
};

type ArtifactRow = {
  readonly artifactId: ArtifactId;
  readonly digest: ContentDigest;
  readonly byteLength: number;
  readonly availability: string;
};

export type ReachabilityGcOptions = {
  readonly store: SqliteStorePort;
  readonly repositories: RecordRepositories;
  readonly blobs: BlobStorePort;
  readonly packages: PackageWriterPort;
  readonly exportOptions: ExportOptions;
  readonly pinnedSessionIds: readonly SessionId[];
  readonly exportPackageNames: readonly ExportName[];
};

export type ReachabilityGcInputs = ReachabilityGcOptions;

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function integerOf(value: unknown): number | null {
  if (typeof value === "bigint") {
    return Number(value);
  }
  return typeof value === "number" ? value : null;
}

/** FNV-1a plan identity, matching the removal plan shape. */
export function computeGcPlanId(candidates: readonly GcCandidate[]): GcPlanId {
  const canonical = [
    "gc",
    ...candidates.map((entry) => [entry.kind, entry.identity, entry.byteCount].join(":")),
  ].join("|");

  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `plan-gc-${hash.toString(16).padStart(8, "0")}-${canonical.length}` as GcPlanId;
}

function retain(
  counts: Map<GcRetentionReason, number>,
  reason: GcRetentionReason,
  amount = 1,
): void {
  counts.set(reason, (counts.get(reason) ?? 0) + amount);
}

function retainedList(counts: Map<GcRetentionReason, number>): readonly GcRetainedCount[] {
  return [...counts].map(([reason, count]) => ({ reason, count }));
}

function listSessions(
  store: SqliteStorePort,
  limit: number,
): Result<
  { readonly rows: readonly SessionRow[]; readonly partial: boolean },
  ReachabilityGcError
> {
  const rows = store.read(SELECT_SESSIONS, { limit });
  if (!rows.ok) {
    return err({ kind: "reachability-gc", code: "storage", detail: "list sessions" });
  }
  const parsed: SessionRow[] = [];
  for (const row of rows.value) {
    const id = textOf(row.sessionId);
    const parsedId = id === null ? null : sessionId.parse(id);
    if (parsedId === null || !parsedId.ok) {
      continue;
    }
    parsed.push({
      sessionId: parsedId.value,
      closedAt: textOf(row.closedAt),
      streamId: textOf(row.streamId) ?? "",
    });
  }
  return ok({ rows: parsed, partial: parsed.length >= limit });
}

function listArtifacts(
  store: SqliteStorePort,
  limit: number,
): Result<
  { readonly rows: readonly ArtifactRow[]; readonly partial: boolean },
  ReachabilityGcError
> {
  const rows = store.read(SELECT_ARTIFACTS, { limit });
  if (!rows.ok) {
    return err({ kind: "reachability-gc", code: "storage", detail: "list artifacts" });
  }
  const parsed: ArtifactRow[] = [];
  for (const row of rows.value) {
    const id = textOf(row.artifactId);
    const digest = textOf(row.digest);
    const parsedId = id === null ? null : artifactId.parse(id);
    const byteLength = integerOf(row.byteLength);
    const availability = textOf(row.availability);
    if (
      parsedId === null ||
      !parsedId.ok ||
      digest === null ||
      byteLength === null ||
      availability === null
    ) {
      continue;
    }
    parsed.push({
      artifactId: parsedId.value,
      digest: digest as ContentDigest,
      byteLength,
      availability,
    });
  }
  return ok({ rows: parsed, partial: parsed.length >= limit });
}

function sessionArtifacts(
  store: SqliteStorePort,
  session: SessionId,
): Result<readonly ArtifactId[], ReachabilityGcError> {
  const rows = store.read(SELECT_SESSION_ARTIFACTS, {
    sessionId: session,
    limit: MAX_GC_EXAMINED_ARTIFACTS,
  });
  if (!rows.ok) {
    return err({ kind: "reachability-gc", code: "storage", detail: "list session artifacts" });
  }
  const ids: ArtifactId[] = [];
  for (const row of rows.value) {
    const id = textOf(row.artifactId);
    const parsed = id === null ? null : artifactId.parse(id);
    if (parsed?.ok) {
      ids.push(parsed.value);
    }
  }
  return ok(ids);
}

function expandArtifacts(
  provenance: ArtifactProvenancePort,
  seeds: ReadonlySet<string>,
  signal?: AbortSignal,
): ReadonlySet<string> {
  const reachable = new Set(seeds);
  for (const seed of seeds) {
    if (aborted(signal)) {
      break;
    }
    const parsed = artifactId.parse(seed);
    if (!parsed.ok) {
      continue;
    }
    const parents = walkArtifactLineage(
      parsed.value,
      (from) => provenance.listParents(from),
      (edge) => edge.parentArtifactId,
      MAX_ARTIFACT_LINEAGE_DEPTH,
    );
    if (parents.ok) {
      for (const edge of parents.value) {
        reachable.add(String(edge.parentArtifactId));
        reachable.add(String(edge.childArtifactId));
      }
    }
    const children = walkArtifactLineage(
      parsed.value,
      (from) => provenance.listChildren(from),
      (edge) => edge.childArtifactId,
      MAX_ARTIFACT_LINEAGE_DEPTH,
    );
    if (children.ok) {
      for (const edge of children.value) {
        reachable.add(String(edge.parentArtifactId));
        reachable.add(String(edge.childArtifactId));
      }
    }
  }
  return reachable;
}

async function exportSessionSeeds(
  options: ReachabilityGcOptions,
  signal?: AbortSignal,
): Promise<Result<ReadonlySet<SessionId>, ReachabilityGcError>> {
  const seeds = new Set<SessionId>();
  const names = options.exportPackageNames.slice(0, MAX_GC_EXPORT_PACKAGES);
  for (const name of names) {
    if (aborted(signal)) {
      return err({ kind: "reachability-gc", code: "cancelled" });
    }
    const verified = await verifyPackage(options.exportOptions, name, signal);
    if (!verified.ok || !verified.value.verified) {
      continue;
    }
    const recordsMember = verified.value.manifest.members.find(
      (member) => member.name === "records.jsonl",
    );
    if (recordsMember === undefined) {
      continue;
    }
    const headerLength = new TextEncoder().encode("falryn-export/1\n").byteLength;
    const offset = headerLength;
    let consumed = 0;
    const buffer: string[] = [];
    while (consumed < recordsMember.byteLength) {
      const length = Math.min(64 * 1024, recordsMember.byteLength - consumed);
      const chunk = await options.packages.readRange(name, offset + consumed, length, signal);
      if (!chunk.ok) {
        break;
      }
      buffer.push(new TextDecoder().decode(chunk.value));
      consumed += chunk.value.byteLength;
      if (chunk.value.byteLength === 0) {
        break;
      }
    }
    for (const line of buffer.join("").split("\n")) {
      if (line.length === 0) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { entity?: unknown; record?: { sessionId?: unknown } };
        if (parsed.entity !== "session" || typeof parsed.record?.sessionId !== "string") {
          continue;
        }
        const id = sessionId.parse(parsed.record.sessionId);
        if (id.ok) {
          seeds.add(id.value);
        }
      } catch {
        // Malformed lines are skipped; the package was already verified.
      }
    }
  }
  return ok(seeds);
}

/** Builds a reachability GC plan without deleting anything. */
export async function planReachabilityGc(
  inputs: ReachabilityGcInputs,
  signal?: AbortSignal,
): Promise<Result<GcPlan, ReachabilityGcError>> {
  if (aborted(signal)) {
    return err({ kind: "reachability-gc", code: "cancelled" });
  }

  const sessionsListed = listSessions(inputs.store, MAX_GC_EXAMINED_SESSIONS);
  if (!sessionsListed.ok) {
    return sessionsListed;
  }
  const artifactsListed = listArtifacts(inputs.store, MAX_GC_EXAMINED_ARTIFACTS);
  if (!artifactsListed.ok) {
    return artifactsListed;
  }

  let completeness: MeasurementCompleteness =
    sessionsListed.value.partial || artifactsListed.value.partial ? "partial" : "complete";

  const pinned = new Set(inputs.pinnedSessionIds.map(String));
  const exportSeeds = await exportSessionSeeds(inputs, signal);
  if (!exportSeeds.ok) {
    return exportSeeds;
  }

  const seedSessions = new Set<string>();
  for (const row of sessionsListed.value.rows) {
    const id = String(row.sessionId);
    if (pinned.has(id)) {
      seedSessions.add(id);
    }
    if (row.closedAt === null) {
      seedSessions.add(id);
    }
  }
  for (const id of exportSeeds.value) {
    seedSessions.add(String(id));
  }

  const provenance = createArtifactProvenanceRepository(inputs.store);
  const invocationSeeds = new Set<string>();
  for (const seed of seedSessions) {
    if (aborted(signal)) {
      completeness = "partial";
      break;
    }
    const parsed = sessionId.parse(seed);
    if (!parsed.ok) {
      continue;
    }
    const artifacts = sessionArtifacts(inputs.store, parsed.value);
    if (!artifacts.ok) {
      return artifacts;
    }
    for (const id of artifacts.value) {
      invocationSeeds.add(String(id));
    }
  }

  const reachableArtifacts = expandArtifacts(provenance, invocationSeeds, signal);
  const retainedCounts = new Map<GcRetentionReason, number>();
  const omissions: GcOmission[] = [];
  const candidates: GcCandidate[] = [];

  for (const row of sessionsListed.value.rows) {
    const id = String(row.sessionId);
    if (seedSessions.has(id)) {
      if (pinned.has(id)) {
        retain(retainedCounts, "pinned");
      } else if (exportSeeds.value.has(row.sessionId)) {
        retain(retainedCounts, "export-seed");
      } else {
        retain(retainedCounts, "open-session");
      }
      continue;
    }
    let sessionReachable = false;
    const artifacts = sessionArtifacts(inputs.store, row.sessionId);
    if (artifacts.ok) {
      for (const artifact of artifacts.value) {
        if (reachableArtifacts.has(String(artifact))) {
          sessionReachable = true;
          break;
        }
      }
    }
    if (sessionReachable) {
      retain(retainedCounts, "reachable");
      continue;
    }
    candidates.push({ kind: "session", identity: id, byteCount: 0 });
  }

  for (const row of artifactsListed.value.rows) {
    const id = String(row.artifactId);
    if (reachableArtifacts.has(id)) {
      retain(retainedCounts, "reachable");
      continue;
    }
    if (row.availability !== "available") {
      retain(retainedCounts, "reserved-or-quarantined");
      omissions.push({ kind: "artifact", identity: id, reason: "reserved-or-quarantined" });
      continue;
    }
    const references = inputs.store.read(SELECT_DIGEST_REFERENCES, {
      digest: row.digest,
      artifactId: row.artifactId,
    });
    if (references.ok && (integerOf(references.value[0]?.count) ?? 0) > 0) {
      retain(retainedCounts, "shared-digest");
      omissions.push({ kind: "artifact", identity: id, reason: "shared-digest" });
      continue;
    }
    candidates.push({ kind: "artifact", identity: id, byteCount: row.byteLength });
  }

  const candidateBytes = candidates.reduce((sum, entry) => sum + entry.byteCount, 0);
  const candidateSessions = candidates.filter((entry) => entry.kind === "session").length;
  const candidateArtifacts = candidates.filter((entry) => entry.kind === "artifact").length;

  return ok({
    planId: computeGcPlanId(candidates),
    candidates,
    retained: retainedList(retainedCounts),
    omissions,
    examinedSessions: sessionsListed.value.rows.length,
    examinedArtifacts: artifactsListed.value.rows.length,
    candidateSessions,
    candidateArtifacts,
    candidateBytes,
    completeness,
  });
}

function gcEffect(deleted: number, failed: number): GcOutcome["effect"] {
  if (deleted === 0) {
    return "none";
  }
  return failed === 0 ? "completed" : "partial";
}

function deleteSessionTree(
  store: SqliteStorePort,
  session: SessionId,
  stream: string,
): Result<null, ReachabilityGcError> {
  const written = store.write((statements) => {
    statements.run(`DELETE FROM ${EVENTS_TABLE} WHERE stream_id = $streamId`, { streamId: stream });
    statements.run(
      `DELETE FROM ${INVOCATIONS_TABLE} WHERE turn_id IN
        (SELECT turn_id FROM ${TURNS_TABLE} WHERE session_id = $sessionId)`,
      { sessionId: session },
    );
    statements.run(
      `DELETE FROM ${MODEL_ATTEMPTS_TABLE} WHERE turn_id IN
        (SELECT turn_id FROM ${TURNS_TABLE} WHERE session_id = $sessionId)`,
      { sessionId: session },
    );
    statements.run(`DELETE FROM ${TURNS_TABLE} WHERE session_id = $sessionId`, {
      sessionId: session,
    });
    statements.run(`DELETE FROM ${PROJECTION_CURSORS_TABLE} WHERE stream_id = $streamId`, {
      streamId: stream,
    });
    statements.run(`DELETE FROM ${SESSIONS_TABLE} WHERE session_id = $sessionId`, {
      sessionId: session,
    });
    return null;
  });
  return written.ok
    ? ok(null)
    : err({ kind: "reachability-gc", code: "storage", detail: "delete session tree" });
}

function deleteArtifactRecord(
  store: SqliteStorePort,
  id: ArtifactId,
): Result<null, ReachabilityGcError> {
  const written = store.write((statements) => {
    statements.run(
      `DELETE FROM ${ARTIFACT_TRANSFORMATIONS_TABLE}
        WHERE child_artifact_id = $id OR parent_artifact_id = $id`,
      { id },
    );
    statements.run(`DELETE FROM ${ARTIFACTS_TABLE} WHERE artifact_id = $id`, { id });
    return null;
  });
  return written.ok
    ? ok(null)
    : err({ kind: "reachability-gc", code: "storage", detail: "delete artifact record" });
}

/** Applies a GC plan bound to that plan's identity. */
export async function executeReachabilityGc(
  inputs: ReachabilityGcInputs,
  plan: GcPlan,
  confirmation: GcConfirmation,
  repository: ArtifactRepositoryPort,
  signal?: AbortSignal,
): Promise<Result<GcOutcome, GcRefusal>> {
  const expected = computeGcPlanId(plan.candidates);
  if (expected !== confirmation.planId || expected !== plan.planId) {
    return err({ code: "plan-mismatch", expected, confirmed: confirmation.planId });
  }
  if (aborted(signal)) {
    return err({ code: "cancelled" });
  }

  const refreshed = await planReachabilityGc(inputs, signal);
  if (!refreshed.ok) {
    return err({ code: "cancelled" });
  }
  if (refreshed.value.planId !== plan.planId) {
    return err({ code: "plan-mismatch", expected: refreshed.value.planId, confirmed: plan.planId });
  }

  let deletedSessions = 0;
  let deletedArtifacts = 0;
  let deletedBytes = 0;
  let failed = 0;
  let completeness: MeasurementCompleteness = "complete";
  const retainedCounts = new Map<GcRetentionReason, number>();
  const omissions: GcOmission[] = [...plan.omissions];

  const sessionRows = listSessions(inputs.store, MAX_GC_EXAMINED_SESSIONS);
  const streamBySession = new Map<string, string>();
  if (sessionRows.ok) {
    for (const row of sessionRows.value.rows) {
      streamBySession.set(String(row.sessionId), row.streamId);
    }
  }

  for (const candidate of plan.candidates) {
    if (aborted(signal)) {
      completeness = "partial";
      retain(retainedCounts, "not-reached");
      continue;
    }
    const stillCandidate = refreshed.value.candidates.find(
      (entry) => entry.kind === candidate.kind && entry.identity === candidate.identity,
    );
    if (stillCandidate === undefined) {
      retain(retainedCounts, "referenced");
      omissions.push({ kind: candidate.kind, identity: candidate.identity, reason: "referenced" });
      continue;
    }

    if (candidate.kind === "session") {
      const parsed = sessionId.parse(candidate.identity);
      const stream = streamBySession.get(candidate.identity);
      if (!parsed.ok || stream === undefined) {
        failed += 1;
        continue;
      }
      const removed = deleteSessionTree(inputs.store, parsed.value, stream);
      if (!removed.ok) {
        failed += 1;
        continue;
      }
      deletedSessions += 1;
      continue;
    }

    const parsed = artifactId.parse(candidate.identity);
    if (!parsed.ok) {
      failed += 1;
      continue;
    }
    const record = repository.get(parsed.value);
    if (!record.ok || record.value === null || record.value.availability !== "available") {
      retain(retainedCounts, "reserved-or-quarantined");
      continue;
    }
    const shared = inputs.store.read(SELECT_DIGEST_REFERENCES, {
      digest: record.value.digest,
      artifactId: parsed.value,
    });
    if (shared.ok && (integerOf(shared.value[0]?.count) ?? 0) > 0) {
      retain(retainedCounts, "shared-digest");
      omissions.push({
        kind: "artifact",
        identity: candidate.identity,
        reason: "shared-digest",
      });
    } else {
      const removedBytes = await inputs.blobs.remove(
        { scope: "content", digest: record.value.digest },
        signal,
      );
      if (!removedBytes.ok) {
        failed += 1;
        continue;
      }
    }
    const removedRecord = deleteArtifactRecord(inputs.store, parsed.value);
    if (!removedRecord.ok) {
      failed += 1;
      continue;
    }
    deletedArtifacts += 1;
    deletedBytes += candidate.byteCount;
  }

  return ok({
    planId: plan.planId,
    deletedSessions,
    deletedArtifacts,
    deletedBytes,
    retained: retainedList(retainedCounts),
    failed,
    omissions,
    completeness,
    effect: gcEffect(deletedSessions + deletedArtifacts, failed),
  });
}

/** Parses export package names from a directory listing. */
export function parseExportDirectoryEntry(name: string): ExportName | null {
  const parsed = exportName.parse(name);
  return parsed.ok ? parsed.value : null;
}
