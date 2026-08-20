/**
 * The artifact metadata repository.
 *
 * Three transitions and three reads over one table, returning domain records
 * and no row shape — the same contract the record repositories hold, for the
 * same reason: the storage shape has to be able to change without a provider, a
 * renderer, or an agent path noticing.
 *
 * Three rules the implementation carries rather than documents:
 *
 * - **A row is created `reserved` and moves exactly once.** There is no general
 *   update. `finalize` and `quarantine` each match only a row still in the
 *   reserved state, which is what makes a repeated finalize a reported fact
 *   rather than a second write.
 * - **Existence is decided inside the write transaction.** A reserve of a row
 *   that is already there reports `already-exists`, a transition on an absent
 *   row reports `not-found`, and a transition on a row that already moved
 *   reports `already-exists` — all read from the committed rows in the same
 *   `immediate` transaction that writes, so no caller has to interpret a
 *   constraint violation or a zero-row update.
 * - **Every row read back is parsed.** A record leaves this module only after
 *   its identities, timestamps, closed unions, and the finalized-time pairing
 *   have been validated, so a hand-edited database is refused at the boundary
 *   with a path and an issue code and never the rejected value.
 */

import {
  type ArtifactError,
  type ArtifactId,
  type ArtifactRecord,
  type ArtifactRepositoryPort,
  type ArtifactWrite,
  type CodecIssue,
  type ContentDigest,
  err,
  MAX_ARTIFACT_LIST_LIMIT,
  MAX_DIGEST_BATCH,
  ok,
  parseArtifactRecord,
  type Result,
  type RunId,
  type SqliteBindings,
  type SqliteRow,
  type SqliteStatements,
  type SqliteStoreError,
  type SqliteStorePort,
  type Timestamp,
} from "../domain/index.ts";
import { ARTIFACTS_TABLE } from "./artifact-schema.ts";

/** `column AS field` for every column, so a row arrives with record keys. */
const SELECT_LIST = `artifact_id AS artifactId, digest AS digest, media_type AS mediaType,
  encoding AS encoding, byte_length AS byteLength, sensitivity AS sensitivity,
  origin AS origin, invocation_id AS invocationId, created_at AS createdAt,
  finalized_at AS finalizedAt, availability AS availability`;

const INSERT_RESERVED = `INSERT INTO ${ARTIFACTS_TABLE}
  (artifact_id, digest, media_type, encoding, byte_length, sensitivity, origin,
   invocation_id, created_at, finalized_at, availability, run_id)
  VALUES ($artifactId, $digest, $mediaType, $encoding, $byteLength, $sensitivity, $origin,
          $invocationId, $createdAt, NULL, 'reserved', $runId)`;

const SELECT_EXISTING = `SELECT artifact_id AS artifactId FROM ${ARTIFACTS_TABLE}
  WHERE artifact_id = $id`;

const SELECT_BY_ID = `SELECT ${SELECT_LIST} FROM ${ARTIFACTS_TABLE} WHERE artifact_id = $id`;

const SELECT_BY_DIGEST = `SELECT ${SELECT_LIST} FROM ${ARTIFACTS_TABLE}
  WHERE digest = $digest ORDER BY created_at, artifact_id LIMIT $limit`;

const SELECT_BY_INVOCATION = `SELECT ${SELECT_LIST} FROM ${ARTIFACTS_TABLE}
  WHERE invocation_id = $invocationId ORDER BY created_at, artifact_id LIMIT $limit`;

const SELECT_ALL = `SELECT ${SELECT_LIST} FROM ${ARTIFACTS_TABLE}
  ORDER BY created_at DESC, artifact_id ASC LIMIT $limit`;

/**
 * The one statement either transition runs.
 *
 * `availability = 'reserved'` in the predicate is what makes the move
 * single-shot: a second finalize matches nothing, and the zero-row result is
 * then explained from the committed rows rather than reported as success.
 */
const MOVE_FROM_RESERVED = `UPDATE ${ARTIFACTS_TABLE}
  SET availability = $availability, finalized_at = $finalizedAt
  WHERE artifact_id = $id AND availability = 'reserved'`;

function storageError(error: SqliteStoreError, id: ArtifactId | null): ArtifactError {
  return {
    kind: "artifact",
    code: "storage",
    failure: { medium: "metadata", error },
    artifactId: id,
  };
}

function malformedRow(issues: readonly CodecIssue[]): ArtifactError {
  return { kind: "artifact", code: "malformed-row", issues };
}

function bindingsFor(record: ArtifactRecord, run: RunId): SqliteBindings {
  return {
    runId: run,
    artifactId: record.artifactId,
    digest: record.digest,
    mediaType: record.mediaType,
    encoding: record.encoding,
    byteLength: record.byteLength,
    sensitivity: record.sensitivity,
    origin: record.origin,
    invocationId: record.invocationId,
    createdAt: record.createdAt,
  };
}

function parseRow(row: SqliteRow): Result<ArtifactRecord, ArtifactError> {
  const parsed = parseArtifactRecord(row);
  return parsed.ok ? ok(parsed.value) : err(malformedRow(parsed.error));
}

function textOf(value: SqliteRow[string] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Every repository over one open database, stamping one run.
 *
 * The run is taken here rather than per record because it is ambient to the
 * process: every row this repository reserves was reserved by *this* run, and
 * threading it through each call would invite a caller to pass a different one.
 * Without it the column migration `0003` adds would always be null, and the
 * attribution recovery depends on to tell an abandoned write from a live one
 * would be inert.
 */
export function createArtifactRepository(
  store: SqliteStorePort,
  run: RunId,
): ArtifactRepositoryPort {
  /**
   * Runs one write and folds its two failure sources into one answer.
   *
   * The work returns a rejection rather than throwing, because no rejection
   * this module raises has written anything by the time it is decided — there
   * is nothing for a rollback to undo, and a throw would arrive at the boundary
   * as an unclassifiable statement failure.
   */
  const write = (
    id: ArtifactId,
    work: (statements: SqliteStatements) => ArtifactError | null,
    signal: AbortSignal | undefined,
  ): Result<ArtifactWrite, ArtifactError> => {
    const written = store.write(work, signal);
    if (!written.ok) {
      return err(storageError(written.error, id));
    }
    const rejection = written.value.value;
    return rejection === null
      ? ok({ cancelledAfterCommit: written.value.cancelledAfterCommit })
      : err(rejection);
  };

  const move = (
    id: ArtifactId,
    availability: "available" | "quarantined",
    finalizedAt: Timestamp,
    signal: AbortSignal | undefined,
  ): Result<ArtifactWrite, ArtifactError> =>
    write(
      id,
      (statements) => {
        const changed = statements.run(MOVE_FROM_RESERVED, { id, availability, finalizedAt });
        if (changed.changes > 0) {
          return null;
        }
        // Nothing matched. Which of the two reasons it was is a fact about the
        // committed rows, so it is read here rather than guessed at.
        return statements.all(SELECT_EXISTING, { id }).length === 0
          ? { kind: "artifact", code: "not-found", artifactId: id }
          : { kind: "artifact", code: "already-exists", artifactId: id };
      },
      signal,
    );

  const list = (
    sql: string,
    bindings: SqliteBindings,
    limit: number,
    id: ArtifactId | null,
  ): Result<readonly ArtifactRecord[], ArtifactError> => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ARTIFACT_LIST_LIMIT) {
      return err({
        kind: "artifact",
        code: "invalid-list-limit",
        requestedLimit: limit,
        maximumLimit: MAX_ARTIFACT_LIST_LIMIT,
      });
    }
    const rows = store.read(sql, bindings);
    if (!rows.ok) {
      return err(storageError(rows.error, id));
    }
    const records: ArtifactRecord[] = [];
    for (const row of rows.value) {
      const parsed = parseRow(row);
      if (!parsed.ok) {
        return err(parsed.error);
      }
      records.push(parsed.value);
    }
    return ok(records);
  };

  return {
    reserve(record: ArtifactRecord, signal?: AbortSignal): Result<ArtifactWrite, ArtifactError> {
      if (record.availability !== "reserved" || record.finalizedAt !== null) {
        // A reserve that is already finalized would write a row the schema
        // refuses, and reporting it as a constraint failure would tell the
        // caller about SQLite rather than about its own record.
        return err(malformedRow([{ path: "availability", code: "custom" }]));
      }
      return write(
        record.artifactId,
        (statements) => {
          const identity = record.artifactId;
          if (statements.all(SELECT_EXISTING, { id: identity }).length > 0) {
            return { kind: "artifact", code: "already-exists", artifactId: identity };
          }
          statements.run(INSERT_RESERVED, bindingsFor(record, run));
          return null;
        },
        signal,
      );
    },

    finalize: (id, finalizedAt, signal) => move(id, "available", finalizedAt, signal),

    quarantine: (id, finalizedAt, signal) => move(id, "quarantined", finalizedAt, signal),

    get(id: ArtifactId): Result<ArtifactRecord | null, ArtifactError> {
      const rows = store.read(SELECT_BY_ID, { id });
      if (!rows.ok) {
        return err(storageError(rows.error, id));
      }
      const row = rows.value[0];
      return row === undefined ? ok(null) : parseRow(row);
    },

    findByDigest: (digest, limit) => list(SELECT_BY_DIGEST, { digest, limit }, limit, null),

    listByInvocation: (id, limit) =>
      list(SELECT_BY_INVOCATION, { invocationId: id, limit }, limit, null),

    list: (limit) => list(SELECT_ALL, { limit }, limit, null),

    referencedDigests(
      digests: readonly ContentDigest[],
    ): Result<ReadonlySet<ContentDigest>, ArtifactError> {
      const referenced = new Set<ContentDigest>();
      for (let start = 0; start < digests.length; start += MAX_DIGEST_BATCH) {
        const batch = digests.slice(start, start + MAX_DIGEST_BATCH);
        // One placeholder per digest: `IN` takes no array binding, and building
        // the list from the batch length rather than from its contents is what
        // keeps every value bound rather than interpolated.
        const placeholders = batch.map((_, index) => `$d${index}`).join(", ");
        const bindings: Record<string, string> = {};
        batch.forEach((digest, index) => {
          bindings[`d${index}`] = digest;
        });
        const rows = store.read(
          `SELECT DISTINCT digest AS digest FROM ${ARTIFACTS_TABLE}
           WHERE digest IN (${placeholders})`,
          bindings,
        );
        if (!rows.ok) {
          return err(storageError(rows.error, null));
        }
        for (const row of rows.value) {
          const digest = textOf(row.digest);
          if (digest !== null) {
            referenced.add(digest as ContentDigest);
          }
        }
      }
      return ok(referenced);
    },
  };
}
