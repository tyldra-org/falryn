/** Streams, verifies, and finalizes versioned export packages. */

import {
  artifactMemberName,
  type ContentDigest,
  EXPORT_FOOTER_BYTES,
  EXPORT_FOOTER_DIGITS,
  EXPORT_FORMAT,
  EXPORT_SCHEMA_VERSION,
  type ExportArtifactEntry,
  type ExportConfigurationEntry,
  type ExportError,
  type ExportInventory,
  type ExportManifest,
  type ExportMember,
  type ExportMemberCheck,
  type ExportName,
  type ExportRedaction,
  type ExportResult,
  type ExportSchemaFamilyDeclaration,
  type ExportSelection,
  type ExportVerification,
  err,
  isCompatible,
  MAX_EXPORT_CONFIGURATION_ENTRIES,
  MAX_EXPORT_CONFIGURATION_KEY,
  MAX_EXPORT_CONFIGURATION_VALUE,
  MAX_MANIFEST_BYTES,
  MAX_PACKAGE_BYTES,
  MAX_RECORD_LIST_LIMIT,
  MINIMUM_COMPATIBLE_EXPORT_SCHEMA_VERSION,
  ok,
  parseArtifactRecord,
  parseExportManifest,
  RECORDS_MEMBER,
  type RecordRepositories,
  type Result,
  RUNTIME_EVENT_SCHEMA_FAMILY,
  RUNTIME_EVENT_SCHEMA_VERSION,
  redactExportValue,
  type SensitiveValueRedactor,
  summarize,
  type Timestamp,
  timestampFromEpochMilliseconds,
} from "../../domain/index.ts";
import { eachEvent, fromRecordError, SELECT_ARTIFACT_RECORD } from "./inventory.ts";
import { aborted, cancelled, type ExportOptions, oversize, storageError } from "./shared.ts";

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

  for (const entry of inventory.artifacts) {
    if (aborted(signal)) {
      return err(cancelled);
    }
    const rows = options.store.read(SELECT_ARTIFACT_RECORD, { artifactId: entry.artifactId });
    if (!rows.ok) {
      return err(storageError(rows.error));
    }
    const row = rows.value[0];
    if (row === undefined) {
      continue;
    }
    const parsed = parseArtifactRecord(row);
    if (!parsed.ok) {
      continue;
    }
    const wroteArtifact = await writeRedacted(
      options,
      sink,
      { entity: "artifact", record: parsed.value },
      redactions,
    );
    if (!wroteArtifact.ok) {
      return err(wroteArtifact.error);
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
