import { SESSION_ARTIFACT_SEEDS } from "../sessions/history-schema.ts";
/**
 * Reachability garbage collection over durable sessions and artifacts (#725).
 *
 * Seeds are pinned sessions, open sessions, and sessions named by verified export
 * packages. Reachability walks invocation links and the provenance graph from
 * those seeds. Candidates are closed, unreachable sessions and available
 * artifacts with no retained reference. Execution rechecks each candidate before
 * deleting metadata and bytes.
 */

import { randomUUID } from "node:crypto";
import {
  type ArtifactId,
  type ArtifactProvenancePort,
  type ArtifactRepositoryPort,
  artifactId,
  type BlobStorePort,
  type ContentDigest,
  MAX_ARTIFACT_LINEAGE_DEPTH,
  walkArtifactLineage,
} from "../../domain/artifacts/index.ts";
import type { ExportName, PackageWriterPort } from "../../domain/extensions/index.ts";
import { err, ok, type Result, type SessionId, sessionId } from "../../domain/foundation/index.ts";
import { processTaskSnapshotSchema } from "../../domain/orchestration/process-task.ts";
import {
  exportName,
  MAX_EXPORTED_ARTIFACTS,
  MAX_EXPORTED_SESSIONS,
  type RecordRepositories,
} from "../../domain/sessions/index.ts";
import type {
  GcCandidate,
  GcConfirmation,
  GcOmission,
  GcOutcome,
  GcPlan,
  GcPlanId,
  GcRefusal,
  GcRetainedCount,
  GcRetentionReason,
  MeasurementCompleteness,
  ReachabilityGcError,
  SqliteBindings,
  SqliteStatements,
  SqliteStorePort,
} from "../../domain/storage/index.ts";
import { createArtifactProvenanceRepository } from "../artifacts/artifact-provenance-repository.ts";
import { ARTIFACTS_TABLE } from "../artifacts/artifact-schema.ts";
import { SESSIONS_TABLE } from "../sqlite/schema.ts";
import { type ExportOptions, verifyPackage } from "./export.ts";

/** Sessions one plan may examine before reporting partial. */
export const MAX_GC_EXAMINED_SESSIONS = MAX_EXPORTED_SESSIONS;

/** Artifacts one plan may examine before reporting partial. */
export const MAX_GC_EXAMINED_ARTIFACTS = MAX_EXPORTED_ARTIFACTS;

/** Verified export packages consulted for session seeds. */
export const MAX_GC_EXPORT_PACKAGES = 32;

const SELECT_SESSIONS = `SELECT session_id AS sessionId, closed_at AS closedAt, stream_id AS streamId
  FROM ${SESSIONS_TABLE} ORDER BY started_at, session_id LIMIT $limit`;

const SELECT_SESSION_ARTIFACTS = `SELECT seeds.artifactId AS artifactId
  FROM (${SESSION_ARTIFACT_SEEDS}) seeds
  WHERE ($includeReleased = 1 OR NOT EXISTS (
      SELECT 1 FROM process_task_artifacts p WHERE p.artifact_id = seeds.artifactId
    ) OR EXISTS (
      SELECT 1 FROM process_task_artifacts p WHERE p.artifact_id = seeds.artifactId AND p.released = 0
    )) LIMIT $limit`;

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
  includeReleased = true,
): Result<readonly ArtifactId[], ReachabilityGcError> {
  const rows = store.read(SELECT_SESSION_ARTIFACTS, {
    sessionId: session,
    includeReleased: includeReleased ? 1 : 0,
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
): Result<ReadonlySet<string>, ReachabilityGcError> {
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
    if (!parents.ok)
      return err({ kind: "reachability-gc", code: "storage", detail: "read artifact lineage" });
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
    if (!children.ok)
      return err({ kind: "reachability-gc", code: "storage", detail: "read artifact lineage" });
    if (children.ok) {
      for (const edge of children.value) {
        reachable.add(String(edge.parentArtifactId));
        reachable.add(String(edge.childArtifactId));
      }
    }
  }
  return ok(reachable);
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

/** Also used inside the metadata transaction, after asynchronous export verification. */
function gcRoots(
  store: SqliteStorePort,
  pinned: ReadonlySet<string>,
  exports: ReadonlySet<SessionId>,
): Result<
  {
    seedSessions: Set<string>;
    taskSessions: Set<string>;
    reachableArtifacts: ReadonlySet<string>;
  },
  ReachabilityGcError
> {
  const sessions = listSessions(store, MAX_GC_EXAMINED_SESSIONS);
  if (!sessions.ok) return sessions;
  const tasks = store.read("SELECT snapshot FROM process_tasks LIMIT 257");
  const owned = store.read(
    "SELECT DISTINCT artifact_id FROM process_task_artifacts WHERE released = 0 LIMIT $limit",
    { limit: MAX_GC_EXAMINED_ARTIFACTS + 1 },
  );
  const mailed = store.read(
    "SELECT DISTINCT json_extract(a.value,'$.artifactId') AS artifact_id FROM peer_messages m,json_each(m.payload,'$.artifacts') a WHERE json_extract(m.receipt,'$.tombstoned')=0 LIMIT $limit",
    { limit: MAX_GC_EXAMINED_ARTIFACTS + 1 },
  );
  const packages = store.read(
    "SELECT DISTINCT artifact_id FROM package_data_artifacts LIMIT $limit",
    { limit: MAX_GC_EXAMINED_ARTIFACTS + 1 },
  );
  if (!tasks.ok || !owned.ok || !mailed.ok || !packages.ok)
    return err({ kind: "reachability-gc", code: "storage", detail: "read task retention roots" });
  if (
    tasks.value.length > 256 ||
    owned.value.length > MAX_GC_EXAMINED_ARTIFACTS ||
    mailed.value.length > MAX_GC_EXAMINED_ARTIFACTS ||
    packages.value.length > MAX_GC_EXAMINED_ARTIFACTS
  )
    return err({ kind: "reachability-gc", code: "bound-exceeded", bound: "task retention roots" });
  const taskSessions = new Set<string>();
  for (const row of tasks.value) {
    try {
      const task = processTaskSnapshotSchema.parse(JSON.parse(String(row.snapshot)));
      taskSessions.add(task.owner.sessionId);
    } catch {
      return err({
        kind: "reachability-gc",
        code: "storage",
        detail: "invalid task retention root",
      });
    }
  }
  const seedSessions = new Set<string>([...pinned, ...exports, ...taskSessions]);
  for (const row of sessions.value.rows) if (row.closedAt === null) seedSessions.add(row.sessionId);
  const artifactSeeds = new Set<string>();
  for (const row of [...owned.value, ...mailed.value, ...packages.value]) {
    const id = artifactId.parse(row.artifact_id);
    if (!id.ok)
      return err({
        kind: "reachability-gc",
        code: "storage",
        detail: "invalid task artifact root",
      });
    artifactSeeds.add(id.value);
  }
  for (const seed of seedSessions) {
    const parsed = sessionId.parse(seed);
    if (!parsed.ok) continue;
    const artifacts = sessionArtifacts(
      store,
      parsed.value,
      pinned.has(seed) || exports.has(parsed.value),
    );
    if (!artifacts.ok) return artifacts;
    for (const id of artifacts.value) artifactSeeds.add(id);
  }
  const reachable = expandArtifacts(createArtifactProvenanceRepository(store), artifactSeeds);
  if (!reachable.ok) return reachable;
  return ok({ seedSessions, taskSessions, reachableArtifacts: reachable.value });
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

  const roots = gcRoots(inputs.store, pinned, exportSeeds.value);
  if (!roots.ok) return roots;
  const { seedSessions, reachableArtifacts, taskSessions } = roots.value;
  const retainedCounts = new Map<GcRetentionReason, number>();
  const omissions: GcOmission[] = [];
  const candidates: GcCandidate[] = [];
  const claims = inputs.store.read("SELECT digest, artifact_id FROM artifact_gc_claims LIMIT 257");
  if (!claims.ok)
    return err({ kind: "reachability-gc", code: "storage", detail: "read GC claims" });
  if (claims.value.length > 256)
    return err({ kind: "reachability-gc", code: "bound-exceeded", bound: "GC claims" });
  const claimedDigests = new Set(claims.value.map((row) => String(row.digest)));
  for (const claim of claims.value) {
    omissions.push({
      kind: "artifact",
      identity: String(claim.artifact_id),
      reason: "gc-claim-outstanding",
    });
    retain(retainedCounts, "gc-claim-outstanding");
    completeness = "partial";
  }

  for (const row of sessionsListed.value.rows) {
    const id = String(row.sessionId);
    if (seedSessions.has(id)) {
      if (pinned.has(id)) {
        retain(retainedCounts, "pinned");
      } else if (exportSeeds.value.has(row.sessionId)) {
        retain(retainedCounts, "export-seed");
      } else {
        retain(retainedCounts, taskSessions.has(id) ? "reachable" : "open-session");
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
    if (claimedDigests.has(row.digest)) continue;
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
    if (!references.ok)
      return err({ kind: "reachability-gc", code: "storage", detail: "read digest references" });
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

function transactionView(store: SqliteStorePort, statements: SqliteStatements): SqliteStorePort {
  return {
    ...store,
    read: (sql: string, bindings?: SqliteBindings) => ok(statements.all(sql, bindings)),
  };
}

function deleteSessionTree(
  inputs: ReachabilityGcInputs,
  exports: ReadonlySet<SessionId>,
  session: SessionId,
  stream: string,
): Result<boolean, ReachabilityGcError> {
  const store = inputs.store;
  const written = store.write((statements): Result<boolean, ReachabilityGcError> => {
    const transactional = transactionView(store, statements);
    const roots = gcRoots(transactional, new Set(inputs.pinnedSessionIds), exports);
    if (!roots.ok) return roots;
    if (roots.value.seedSessions.has(session)) return ok(false);
    const artifacts = sessionArtifacts(transactional, session);
    if (!artifacts.ok) return artifacts;
    if (artifacts.value.some((id) => roots.value.reachableArtifacts.has(id))) return ok(false);
    statements.run("DELETE FROM events WHERE stream_id = $streamId", { streamId: stream });
    statements.run(
      `DELETE FROM invocations WHERE turn_id IN
        (SELECT turn_id FROM turns WHERE session_id = $sessionId)`,
      { sessionId: session },
    );
    statements.run(
      `DELETE FROM model_attempts WHERE turn_id IN
        (SELECT turn_id FROM turns WHERE session_id = $sessionId)`,
      { sessionId: session },
    );
    statements.run("DELETE FROM turns WHERE session_id = $sessionId", {
      sessionId: session,
    });
    statements.run("DELETE FROM projection_cursors WHERE stream_id = $streamId", {
      streamId: stream,
    });
    statements.run("DELETE FROM sessions WHERE session_id = $sessionId", {
      sessionId: session,
    });
    return ok(true);
  });
  return written.ok
    ? written.value.value
    : err({ kind: "reachability-gc", code: "storage", detail: "delete session tree" });
}

function deleteArtifactRecord(
  inputs: ReachabilityGcInputs,
  exports: ReadonlySet<SessionId>,
  id: ArtifactId,
  digest: ContentDigest,
  owner: string,
): Result<"deleted" | GcRetentionReason, ReachabilityGcError> {
  const store = inputs.store;
  const written = store.write(
    (statements): Result<"deleted" | GcRetentionReason, ReachabilityGcError> => {
      const transactional = transactionView(store, statements);
      const roots = gcRoots(transactional, new Set(inputs.pinnedSessionIds), exports);
      if (!roots.ok) return roots;
      if (roots.value.reachableArtifacts.has(id)) return ok("referenced");
      const record = statements.all(
        "SELECT digest, availability FROM artifacts WHERE artifact_id = $id",
        { id },
      )[0];
      if (record?.digest !== digest || record.availability !== "available")
        return ok("reserved-or-quarantined");
      if (
        statements.all("SELECT digest FROM artifact_gc_claims WHERE digest = $digest", { digest })
          .length > 0
      )
        return ok("gc-claim-outstanding");
      const shared = statements.all(SELECT_DIGEST_REFERENCES, { digest, artifactId: id });
      if ((integerOf(shared[0]?.count) ?? 0) > 0) return ok("shared-digest");
      statements.run(
        "INSERT INTO artifact_gc_claims (digest, artifact_id, owner_id) VALUES ($digest, $id, $owner)",
        { digest, id, owner },
      );
      statements.run(
        `DELETE FROM artifact_transformations
        WHERE child_artifact_id = $id OR parent_artifact_id = $id`,
        { id },
      );
      statements.run("DELETE FROM artifacts WHERE artifact_id = $id", { id });
      return ok("deleted");
    },
  );
  return written.ok
    ? written.value.value
    : err({ kind: "reachability-gc", code: "storage", detail: "claim and delete artifact record" });
}

/** Never adopts a prior invocation's claim, even after its process has disappeared. */
async function removeClaimedBlob(
  inputs: ReachabilityGcInputs,
  digest: ContentDigest,
  owner: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const claim = inputs.store.read(
    "SELECT owner_id FROM artifact_gc_claims WHERE digest = $digest",
    { digest },
  );
  if (!claim.ok || claim.value[0]?.owner_id !== owner) return false;
  const removed = await inputs.blobs.remove({ scope: "content", digest }, signal);
  if (!removed.ok) return false;
  const released = inputs.store.write((sql) =>
    sql.run("DELETE FROM artifact_gc_claims WHERE digest = $digest AND owner_id = $owner", {
      digest,
      owner,
    }),
  );
  return released.ok && released.value.value.changes === 1;
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
    return err(refreshed.error);
  }
  if (refreshed.value.planId !== plan.planId) {
    return err({ code: "plan-mismatch", expected: refreshed.value.planId, confirmed: plan.planId });
  }
  const exportSeeds = await exportSessionSeeds(inputs, signal);
  if (!exportSeeds.ok) return err(exportSeeds.error);
  const owner = randomUUID();

  let deletedSessions = 0;
  let deletedArtifacts = 0;
  let deletedBytes = 0;
  let failed = 0;
  let completeness: MeasurementCompleteness = refreshed.value.completeness;
  const retainedCounts = new Map<GcRetentionReason, number>();
  const omissions: GcOmission[] = [...refreshed.value.omissions];

  const sessionRows = listSessions(inputs.store, MAX_GC_EXAMINED_SESSIONS);
  const streamBySession = new Map<string, string>();
  if (sessionRows.ok) {
    for (const row of sessionRows.value.rows) {
      streamBySession.set(String(row.sessionId), row.streamId);
    }
  }

  for (const candidate of [...plan.candidates].sort((a, b) => a.kind.localeCompare(b.kind))) {
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
      const removed = deleteSessionTree(inputs, exportSeeds.value, parsed.value, stream);
      if (!removed.ok) {
        failed += 1;
        continue;
      }
      if (removed.value) deletedSessions += 1;
      else {
        retain(retainedCounts, "referenced");
        omissions.push({ kind: "session", identity: candidate.identity, reason: "referenced" });
      }
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
    const removedRecord = deleteArtifactRecord(
      inputs,
      exportSeeds.value,
      parsed.value,
      record.value.digest,
      owner,
    );
    if (!removedRecord.ok) {
      failed += 1;
      continue;
    }
    if (removedRecord.value !== "deleted") {
      retain(retainedCounts, removedRecord.value);
      omissions.push({
        kind: "artifact",
        identity: candidate.identity,
        reason: removedRecord.value,
      });
      continue;
    }
    deletedArtifacts += 1;
    if (await removeClaimedBlob(inputs, record.value.digest, owner, signal)) {
      deletedBytes += record.value.byteLength;
    } else {
      failed += 1;
      completeness = "partial";
      omissions.push({
        kind: "artifact",
        identity: candidate.identity,
        reason: "gc-claim-outstanding",
      });
    }
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
