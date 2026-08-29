/** SQLite repository for immutable scratch-resource revisions (#848). */

import {
  artifactId,
  contentDigest,
  err,
  instant,
  invocationId,
  ok,
  type PublishScratchRevision,
  parseScratchMediaType,
  parseScratchName,
  type Result,
  type ScratchRepositoryError,
  type ScratchResource,
  type ScratchResourceRepositoryPort,
  type ScratchResourceRevision,
  type ScratchResourceView,
  type SqliteStatements,
  type SqliteStorePort,
  scratchRevision,
  sessionId,
} from "../domain/index.ts";
import { SCRATCH_RESOURCES_TABLE, SCRATCH_REVISIONS_TABLE } from "./scratch-resource-schema.ts";

function failure(code: ScratchRepositoryError["code"]): ScratchRepositoryError {
  return { kind: "scratch-resource", code };
}

function parseResource(row: Readonly<Record<string, unknown>>): ScratchResource | null {
  const owner = sessionId.parse(row.sessionId);
  const name = parseScratchName(row.name);
  const revision = scratchRevision(row.currentRevision);
  if (
    !owner.ok ||
    !name.ok ||
    !revision.ok ||
    (row.status !== "active" && row.status !== "discarded") ||
    typeof row.createdAt !== "number" ||
    !Number.isSafeInteger(row.createdAt) ||
    typeof row.updatedAt !== "number" ||
    !Number.isSafeInteger(row.updatedAt)
  ) {
    return null;
  }
  return {
    sessionId: owner.value,
    name: name.value,
    status: row.status,
    currentRevision: revision.value,
    createdAt: instant(row.createdAt),
    updatedAt: instant(row.updatedAt),
  };
}

function parseRevision(row: Readonly<Record<string, unknown>>): ScratchResourceRevision | null {
  const owner = sessionId.parse(row.sessionId);
  const name = parseScratchName(row.name);
  const revision = scratchRevision(row.revision);
  const artifact = artifactId.parse(row.artifactId);
  const digest = contentDigest.parse(row.digest);
  const mediaType = parseScratchMediaType(row.mediaType);
  const invocation = invocationId.parse(row.invocationId);
  if (
    !owner.ok ||
    !name.ok ||
    !revision.ok ||
    !artifact.ok ||
    !digest.ok ||
    !mediaType.ok ||
    !invocation.ok ||
    typeof row.byteLength !== "number" ||
    !Number.isSafeInteger(row.byteLength) ||
    row.byteLength < 0 ||
    typeof row.revisionCreatedAt !== "number" ||
    !Number.isSafeInteger(row.revisionCreatedAt)
  ) {
    return null;
  }
  return {
    sessionId: owner.value,
    name: name.value,
    revision: revision.value,
    artifactId: artifact.value,
    digest: digest.value,
    mediaType: mediaType.value,
    byteLength: row.byteLength,
    invocationId: invocation.value,
    createdAt: instant(row.revisionCreatedAt),
  };
}

const SELECT_VIEW = `SELECT resource.session_id AS sessionId,
    resource.name AS name, resource.status AS status,
    resource.current_revision AS currentRevision,
    resource.created_at AS createdAt, resource.updated_at AS updatedAt,
    revision.revision AS revision, revision.artifact_id AS artifactId,
    revision.digest AS digest, revision.media_type AS mediaType,
    revision.byte_length AS byteLength, revision.invocation_id AS invocationId,
    revision.created_at AS revisionCreatedAt
  FROM ${SCRATCH_RESOURCES_TABLE} AS resource
  INNER JOIN ${SCRATCH_REVISIONS_TABLE} AS revision
    ON revision.session_id = resource.session_id
   AND revision.name = resource.name`;

function parseView(
  row: Readonly<Record<string, unknown>>,
): Result<ScratchResourceView, ScratchRepositoryError> {
  const resource = parseResource(row);
  const revision = parseRevision(row);
  return resource === null || revision === null
    ? err(failure("malformed"))
    : ok({ resource, revision });
}

function writeRevision(statements: SqliteStatements, input: PublishScratchRevision): void {
  statements.run(
    `INSERT INTO ${SCRATCH_REVISIONS_TABLE}
      (session_id, name, revision, artifact_id, digest, media_type, byte_length,
       invocation_id, created_at)
     VALUES ($sessionId, $name, $revision, $artifactId, $digest, $mediaType,
       $byteLength, $invocationId, $createdAt)`,
    {
      sessionId: input.sessionId,
      name: input.name,
      revision: input.revision.revision,
      artifactId: input.revision.artifactId,
      digest: input.revision.digest,
      mediaType: input.revision.mediaType,
      byteLength: input.revision.byteLength,
      invocationId: input.revision.invocationId,
      createdAt: input.revision.createdAt,
    },
  );
}

export function createScratchResourceRepository(
  store: SqliteStorePort,
): ScratchResourceRepositoryPort {
  const readOne = (
    owner: string,
    name: string,
    revision?: number,
  ): Result<ScratchResourceView | null, ScratchRepositoryError> => {
    const rows = store.read(
      `${SELECT_VIEW}
       WHERE resource.session_id = $sessionId AND resource.name = $name
         AND revision.revision = ${revision === undefined ? "resource.current_revision" : "$revision"}
       LIMIT 1`,
      { sessionId: owner, name, ...(revision === undefined ? {} : { revision }) },
    );
    if (!rows.ok) return err(failure("unavailable"));
    const row = rows.value[0];
    return row === undefined ? ok(null) : parseView(row);
  };

  return {
    publish(input, signal) {
      const written = store.write((statements) => {
        const current = statements.all(
          `SELECT status AS status, current_revision AS currentRevision
             FROM ${SCRATCH_RESOURCES_TABLE}
            WHERE session_id = $sessionId AND name = $name`,
          { sessionId: input.sessionId, name: input.name },
        )[0];
        if (current === undefined) {
          if (input.expectedRevision !== null || input.revision.revision !== 1) return "conflict";
          statements.run(
            `INSERT INTO ${SCRATCH_RESOURCES_TABLE}
              (session_id, name, status, current_revision, created_at, updated_at)
             VALUES ($sessionId, $name, 'active', 1, $createdAt, $updatedAt)`,
            {
              sessionId: input.sessionId,
              name: input.name,
              createdAt: input.revision.createdAt,
              updatedAt: input.revision.createdAt,
            },
          );
          writeRevision(statements, input);
          return "published";
        }
        if (
          current.status !== "active" ||
          typeof current.currentRevision !== "number" ||
          input.expectedRevision === null ||
          current.currentRevision !== input.expectedRevision ||
          input.revision.revision !== current.currentRevision + 1
        ) {
          return "conflict";
        }
        writeRevision(statements, input);
        statements.run(
          `UPDATE ${SCRATCH_RESOURCES_TABLE}
              SET current_revision = $revision, updated_at = $updatedAt
            WHERE session_id = $sessionId AND name = $name`,
          {
            sessionId: input.sessionId,
            name: input.name,
            revision: input.revision.revision,
            updatedAt: input.revision.createdAt,
          },
        );
        return "published";
      }, signal);
      if (!written.ok) {
        return err(failure(written.error.code === "cancelled" ? "cancelled" : "unavailable"));
      }
      if (written.value.value === "conflict") return err(failure("conflict"));
      const published = readOne(input.sessionId, input.name, input.revision.revision);
      return published.ok && published.value !== null
        ? ok(published.value)
        : err(failure(published.ok ? "unavailable" : published.error.code));
    },
    get(owner, name, revision) {
      const found = readOne(owner, name, revision);
      if (!found.ok || found.value === null) return found;
      return found.value.resource.status === "discarded" ? err(failure("discarded")) : found;
    },
    list(owner, limit) {
      const rows = store.read(
        `${SELECT_VIEW}
         WHERE resource.session_id = $sessionId
           AND resource.status = 'active'
           AND revision.revision = resource.current_revision
         ORDER BY resource.updated_at DESC, resource.name ASC
         LIMIT $limit`,
        { sessionId: owner, limit },
      );
      if (!rows.ok) return err(failure("unavailable"));
      const views: ScratchResourceView[] = [];
      for (const row of rows.value) {
        const parsed = parseView(row);
        if (!parsed.ok) return parsed;
        views.push(parsed.value);
      }
      return ok(views);
    },
    discard(owner, name, expectedRevision, updatedAt, signal) {
      const written = store.write((statements) => {
        const current = statements.all(
          `SELECT status AS status, current_revision AS currentRevision
             FROM ${SCRATCH_RESOURCES_TABLE}
            WHERE session_id = $sessionId AND name = $name`,
          { sessionId: owner, name },
        )[0];
        if (current === undefined) return "not-found";
        if (current.status !== "active") return "discarded";
        if (current.currentRevision !== expectedRevision) return "conflict";
        statements.run(
          `UPDATE ${SCRATCH_RESOURCES_TABLE}
              SET status = 'discarded', updated_at = $updatedAt
            WHERE session_id = $sessionId AND name = $name`,
          { sessionId: owner, name, updatedAt },
        );
        return "discarded";
      }, signal);
      if (!written.ok) {
        return err(failure(written.error.code === "cancelled" ? "cancelled" : "unavailable"));
      }
      if (written.value.value !== "discarded") {
        return err(failure(written.value.value));
      }
      const found = readOne(owner, name);
      return found.ok && found.value !== null
        ? ok(found.value)
        : err(failure(found.ok ? "unavailable" : found.error.code));
    },
  };
}
