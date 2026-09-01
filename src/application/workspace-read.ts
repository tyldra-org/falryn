/**
 * Workspace source reads and bounded expansion (#59).
 *
 * Binds caller paths, records an exact source digest/revision, and keeps
 * partial inline projections visibly separate from their artifact expansion.
 */

import { createHash } from "node:crypto";

import {
  type ArtifactError,
  type ArtifactRecord,
  type ArtifactStorePort,
  applyLineRange,
  artifactId,
  assertNever,
  type BoundWorkspacePath,
  type ByteRange,
  bindWorkspacePath,
  contentDigest,
  decodeWorkspaceText,
  detectNewline,
  type FileSystemError,
  type FileSystemPort,
  isBinaryText,
  isInside,
  type LocalPath,
  MAX_READ_MANY_TARGETS,
  numberLines,
  type PathEntry,
  parseReadLimits,
  type WorkspaceBytesRead,
  type WorkspaceFileRead,
  type WorkspaceReadContinuation,
  type WorkspaceReadDiagnostic,
  type WorkspaceReadEncoding,
  type WorkspaceReadError,
  type WorkspaceReadExpansion,
  type WorkspaceReadLimits,
  type WorkspaceReadManyItem,
  type WorkspaceReadRange,
} from "../domain/index.ts";

import type { WorkspaceReader, WorkspaceReaderOptions } from "./workspace-reader/contracts.ts";

export * from "./workspace-reader/contracts.ts";

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

type ReadSettings = WorkspaceReadLimits;

type ReadSnapshot = {
  readonly stated: PathEntry;
  readonly inlineBytes: Uint8Array;
  readonly inlineByteLength: number;
  readonly expansion: WorkspaceReadExpansion | null;
  readonly digest: WorkspaceFileRead["digest"];
  readonly encoding: WorkspaceReadEncoding;
  readonly text: string | null;
};

type RangeReadResult =
  | { readonly ok: true; readonly value: Uint8Array }
  | { readonly ok: false; readonly error: WorkspaceReadError };

function digestOf(bytes: Uint8Array): WorkspaceFileRead["digest"] {
  const hash = createHash("sha256");
  hash.update(bytes);
  return contentDigest.from(`sha-256:${hash.digest("hex")}`);
}

async function bindReadPath(
  fileSystem: FileSystemPort,
  root: LocalPath,
  value: unknown,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: BoundWorkspacePath }
  | { readonly ok: false; readonly error: WorkspaceReadError }
> {
  const lexical = bindWorkspacePath(root, value);
  if (!lexical.ok) {
    return lexical;
  }
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const real = await fileSystem.realPath(lexical.value.resolved, signal);
  if (!real.ok) {
    if (real.error.code === "cancelled") {
      return { ok: false, error: { code: "cancelled" } };
    }
    if (real.error.code === "not-found") {
      return { ok: false, error: { code: "not-found" } };
    }
    return { ok: false, error: { code: "filesystem", reason: real.error.code } };
  }
  if (!isInside(root, real.value)) {
    return { ok: false, error: { code: "symlink-escape" } };
  }
  return {
    ok: true,
    value: {
      ...lexical.value,
      resolved: real.value,
      logical:
        real.value === root
          ? ""
          : real.value.slice(root.endsWith("/") ? root.length : root.length + 1),
    },
  };
}

async function readBound(
  fileSystem: FileSystemPort,
  bound: BoundWorkspacePath,
  range: WorkspaceReadRange | undefined,
  settings: ReadSettings,
  artifacts: ArtifactStorePort | undefined,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: WorkspaceFileRead }
  | { readonly ok: false; readonly error: WorkspaceReadError }
> {
  for (let attempt = 1; attempt <= settings.maxStaleRetries + 1; attempt += 1) {
    const snapshot = await readTextSnapshot(fileSystem, bound, settings, artifacts, signal);
    if (!snapshot.ok) {
      return snapshot;
    }
    const current = await fileSystem.stat(bound.resolved, signal);
    if (!current.ok) {
      return mapFileSystemError(current.error);
    }
    if (
      current.value === null ||
      current.value.kind !== "file" ||
      current.value.revision !== snapshot.value.stated.revision ||
      current.value.byteLength !== snapshot.value.stated.byteLength
    ) {
      if (attempt <= settings.maxStaleRetries) {
        continue;
      }
      return { ok: false, error: { code: "stale", attempts: attempt } };
    }

    const sourcePartial = snapshot.value.inlineByteLength < snapshot.value.stated.byteLength;
    const diagnostics: WorkspaceReadDiagnostic[] = sourcePartial
      ? [
          {
            code: "inline-limit",
            returnedBytes: snapshot.value.inlineByteLength,
            sourceBytes: snapshot.value.stated.byteLength,
          },
        ]
      : [];
    const continuation: WorkspaceReadContinuation | null = sourcePartial
      ? {
          kind: "byte",
          offset: snapshot.value.inlineByteLength,
          length: snapshot.value.stated.byteLength - snapshot.value.inlineByteLength,
          reason: "inline-limit",
        }
      : null;
    const newline = detectNewline(snapshot.value.text ?? "");
    let text = snapshot.value.text ?? "";
    let actualRange: WorkspaceReadRange | null = range ?? null;
    let truncated = sourcePartial;

    if (range !== undefined) {
      if (range.kind === "line") {
        const sliced = applyLineRange(text, range.range);
        if ("error" in sliced) {
          return { ok: false, error: { code: "malformed-range" } };
        }
        text = sliced.lines.map((line) => line.text).join("\n");
        truncated ||= sliced.truncated;
        actualRange =
          sliced.lines.length === 0
            ? null
            : {
                kind: "line",
                range: {
                  start: sliced.lines[0]?.number ?? range.range.start,
                  end: sliced.lines[sliced.lines.length - 1]?.number ?? range.range.start,
                },
              };
        return {
          ok: true,
          value: workspaceTextResult(
            bound,
            snapshot.value,
            range,
            actualRange,
            text,
            newline,
            truncated,
            continuation,
            diagnostics,
            sliced.lines[0]?.number ?? range.range.start,
          ),
        };
      }
      const sliced = applySourceByteRange(
        snapshot.value.inlineBytes,
        range.range,
        snapshot.value.stated.byteLength,
        snapshot.value.encoding,
      );
      if (!sliced.ok) {
        return sliced;
      }
      text = sliced.value.text;
      truncated ||= sliced.value.truncated;
      actualRange = {
        kind: "byte",
        range: {
          start: Math.min(range.range.start, snapshot.value.inlineByteLength),
          end: Math.min(range.range.end, snapshot.value.inlineByteLength),
        },
      };
    }

    return {
      ok: true,
      value: workspaceTextResult(
        bound,
        snapshot.value,
        range ?? undefined,
        actualRange,
        text,
        newline,
        truncated,
        continuation,
        diagnostics,
      ),
    };
  }
  return { ok: false, error: { code: "stale", attempts: settings.maxStaleRetries + 1 } };
}

async function readBytesBound(
  fileSystem: FileSystemPort,
  bound: BoundWorkspacePath,
  settings: ReadSettings,
  artifacts: ArtifactStorePort | undefined,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: WorkspaceBytesRead }
  | { readonly ok: false; readonly error: WorkspaceReadError }
> {
  for (let attempt = 1; attempt <= settings.maxStaleRetries + 1; attempt += 1) {
    const snapshot = await readBinarySnapshot(fileSystem, bound, settings, artifacts, signal);
    if (!snapshot.ok) {
      return snapshot;
    }
    const current = await fileSystem.stat(bound.resolved, signal);
    if (!current.ok) {
      return mapFileSystemError(current.error);
    }
    if (
      current.value === null ||
      current.value.kind !== "file" ||
      current.value.revision !== snapshot.value.stated.revision ||
      current.value.byteLength !== snapshot.value.stated.byteLength
    ) {
      if (attempt <= settings.maxStaleRetries) {
        continue;
      }
      return { ok: false, error: { code: "stale", attempts: attempt } };
    }
    const partial = snapshot.value.inlineByteLength < snapshot.value.stated.byteLength;
    const diagnostics: WorkspaceReadDiagnostic[] = partial
      ? [
          {
            code: "inline-limit",
            returnedBytes: snapshot.value.inlineByteLength,
            sourceBytes: snapshot.value.stated.byteLength,
          },
        ]
      : [];
    const continuation: WorkspaceReadContinuation | null = partial
      ? {
          kind: "byte",
          offset: snapshot.value.inlineByteLength,
          length: snapshot.value.stated.byteLength - snapshot.value.inlineByteLength,
          reason: "inline-limit",
        }
      : null;
    return {
      ok: true,
      value: {
        bound,
        kind: snapshot.value.stated.kind,
        byteLength: snapshot.value.stated.byteLength,
        requestedTarget: bound.requested,
        resolvedTarget: snapshot.value.stated.path,
        sourceIdentity: snapshot.value.stated.path,
        revision: snapshot.value.stated.revision,
        digest: snapshot.value.digest,
        completeness: partial ? "partial" : "complete",
        fidelity: "exact",
        encoding: "binary",
        range: { start: 0, end: snapshot.value.inlineByteLength },
        actualRange: { start: 0, end: snapshot.value.inlineByteLength },
        inlineByteLength: snapshot.value.inlineByteLength,
        bytes: snapshot.value.inlineBytes,
        continuation,
        expansion: snapshot.value.expansion,
        diagnostics,
      },
    };
  }
  return { ok: false, error: { code: "stale", attempts: settings.maxStaleRetries + 1 } };
}

type TextSnapshot = ReadSnapshot & {
  readonly encoding: Exclude<WorkspaceReadEncoding, "binary">;
  readonly text: string;
};

function mapFileSystemError(error: FileSystemError): { ok: false; error: WorkspaceReadError } {
  switch (error.code) {
    case "cancelled":
      return { ok: false, error: { code: "cancelled" } };
    case "not-found":
      return { ok: false, error: { code: "not-found" } };
    case "not-a-directory":
      return { ok: false, error: { code: "not-a-file" } };
    case "oversized":
      return { ok: false, error: { code: "oversized", byteLength: 0 } };
    case "malformed-encoding":
      return { ok: false, error: { code: "malformed-encoding" } };
    case "range-out-of-bounds":
      return { ok: false, error: { code: "malformed-range" } };
    case "permission-denied":
    case "not-empty":
    case "io-failure":
    case "unsupported":
    case "cross-device":
      return { ok: false, error: { code: "filesystem", reason: error.code } };
    default:
      return assertNever(error.code, "unhandled filesystem error");
  }
}

async function statFile(
  fileSystem: FileSystemPort,
  bound: BoundWorkspacePath,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: PathEntry }
  | { readonly ok: false; readonly error: WorkspaceReadError }
> {
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const stated = await fileSystem.stat(bound.resolved, signal);
  if (!stated.ok) {
    return mapFileSystemError(stated.error);
  }
  if (stated.value === null) {
    return { ok: false, error: { code: "not-found" } };
  }
  if (stated.value.kind !== "file") {
    return { ok: false, error: { code: "not-a-file" } };
  }
  return { ok: true, value: stated.value };
}

async function readInlineBytes(
  fileSystem: FileSystemPort,
  bound: BoundWorkspacePath,
  length: number,
  signal?: AbortSignal,
): Promise<RangeReadResult> {
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const bytes = await fileSystem.readBytesRange(bound.resolved, 0, length, signal);
  if (!bytes.ok) {
    return mapFileSystemError(bytes.error);
  }
  if (bytes.value.byteLength > length) {
    return { ok: false, error: { code: "filesystem", reason: "range-overflow" } };
  }
  return { ok: true, value: bytes.value };
}

function artifactIdFor(
  bound: BoundWorkspacePath,
  revision: string,
): ReturnType<typeof artifactId.from> {
  const hash = createHash("sha256");
  hash.update(`${bound.root}\0${bound.resolved}\0${revision}`);
  return artifactId.from(`workspace-${hash.digest("hex").slice(0, 48)}`);
}

function expansionFromRecord(
  record: ArtifactRecord,
  mediaType: WorkspaceReadExpansion["mediaType"],
): WorkspaceReadExpansion | null {
  return record.availability === "available"
    ? {
        kind: "artifact",
        artifactId: record.artifactId,
        digest: record.digest,
        byteLength: record.byteLength,
        mediaType,
      }
    : null;
}

function mapArtifactError(error: ArtifactError): { ok: false; error: WorkspaceReadError } {
  switch (error.code) {
    case "cancelled":
      return { ok: false, error: { code: "cancelled" } };
    case "oversize":
      return { ok: false, error: { code: "oversized", byteLength: error.requestedByteLength } };
    case "malformed-row":
    case "storage":
    case "already-exists":
    case "not-found":
    case "digest-mismatch":
    case "size-mismatch":
    case "range-out-of-bounds":
    case "unavailable-bytes":
    case "invalid-list-limit":
      return { ok: false, error: { code: "filesystem", reason: `expansion:${error.code}` } };
    default:
      return assertNever(error, "unhandled artifact error");
  }
}

type ExpansionReadFailure = {
  readonly kind: "workspace-expansion-read-failure";
  readonly error: WorkspaceReadError;
};

async function expandExact(
  fileSystem: FileSystemPort,
  bound: BoundWorkspacePath,
  stated: PathEntry,
  settings: ReadSettings,
  artifacts: ArtifactStorePort,
  mediaType: WorkspaceReadExpansion["mediaType"],
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: WorkspaceReadExpansion }
  | { readonly ok: false; readonly error: WorkspaceReadError }
> {
  if (stated.byteLength > settings.maxExpansionBytes) {
    return { ok: false, error: { code: "oversized", byteLength: stated.byteLength } };
  }
  const id = artifactIdFor(bound, stated.revision);
  const chunks = async function* (): AsyncGenerator<Uint8Array, void, undefined> {
    let offset = 0;
    while (offset < stated.byteLength) {
      if (isAborted(signal)) {
        const failure: ExpansionReadFailure = {
          kind: "workspace-expansion-read-failure",
          error: { code: "cancelled" },
        };
        throw failure;
      }
      const next = await fileSystem.readBytesRange(
        bound.resolved,
        offset,
        Math.min(settings.maxExpansionChunkBytes, stated.byteLength - offset),
        signal,
      );
      if (!next.ok) {
        const failure: ExpansionReadFailure = {
          kind: "workspace-expansion-read-failure",
          error: mapFileSystemError(next.error).error,
        };
        throw failure;
      }
      if (next.value.byteLength === 0) {
        const failure: ExpansionReadFailure = {
          kind: "workspace-expansion-read-failure",
          error: { code: "stale", attempts: 1 },
        };
        throw failure;
      }
      offset += next.value.byteLength;
      yield next.value;
    }
  };

  let ingested: Awaited<ReturnType<ArtifactStorePort["ingest"]>>;
  try {
    ingested = await artifacts.ingest(
      {
        artifactId: id,
        mediaType,
        encoding: "identity",
        sensitivity: "user-content",
        origin: "capture",
        invocationId: null,
        declaredByteLength: stated.byteLength,
        content: chunks(),
      },
      signal,
    );
  } catch (thrown: unknown) {
    const failure = thrown as Partial<ExpansionReadFailure>;
    if (failure.kind === "workspace-expansion-read-failure" && failure.error !== undefined) {
      return { ok: false, error: failure.error };
    }
    return { ok: false, error: { code: "filesystem", reason: "expansion:thrown" } };
  }
  if (!ingested.ok) {
    if (ingested.error.code === "already-exists") {
      const existing = artifacts.get(id);
      if (existing.ok && existing.value !== null) {
        const expansion = expansionFromRecord(existing.value, mediaType);
        if (expansion !== null && expansion.byteLength === stated.byteLength) {
          return { ok: true, value: expansion };
        }
      }
    }
    return mapArtifactError(ingested.error);
  }
  const expansion = expansionFromRecord(ingested.value.record, mediaType);
  return expansion === null
    ? { ok: false, error: { code: "filesystem", reason: "expansion:unavailable" } }
    : { ok: true, value: expansion };
}

function decodePrefix(
  bytes: Uint8Array,
  complete: boolean,
):
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly text: string;
      readonly encoding: TextSnapshot["encoding"];
    }
  | { readonly ok: false; readonly error: WorkspaceReadError } {
  const attempts = complete ? 1 : Math.min(5, bytes.byteLength + 1);
  for (let trim = 0; trim < attempts; trim += 1) {
    const candidate = trim === 0 ? bytes : bytes.subarray(0, bytes.byteLength - trim);
    const decoded = decodeWorkspaceText(candidate);
    if (decoded.ok) {
      return { ok: true, bytes: candidate, ...decoded.value };
    }
  }
  return { ok: false, error: { code: "malformed-encoding" } };
}

async function readTextSnapshot(
  fileSystem: FileSystemPort,
  bound: BoundWorkspacePath,
  settings: ReadSettings,
  artifacts: ArtifactStorePort | undefined,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: TextSnapshot }
  | { readonly ok: false; readonly error: WorkspaceReadError }
> {
  const stated = await statFile(fileSystem, bound, signal);
  if (!stated.ok) {
    return stated;
  }
  const needsExpansion = stated.value.byteLength > settings.maxFileBytes;
  if (needsExpansion && artifacts === undefined) {
    return { ok: false, error: { code: "oversized", byteLength: stated.value.byteLength } };
  }
  const inline = await readInlineBytes(
    fileSystem,
    bound,
    Math.min(stated.value.byteLength, settings.maxFileBytes),
    signal,
  );
  if (!inline.ok) {
    return inline;
  }
  const decoded = decodePrefix(inline.value, !needsExpansion);
  if (!decoded.ok) {
    return decoded;
  }
  if (isBinaryText(decoded.text)) {
    return { ok: false, error: { code: "binary" } };
  }
  const expansion =
    needsExpansion && artifacts !== undefined
      ? await expandExact(
          fileSystem,
          bound,
          stated.value,
          settings,
          artifacts,
          "text/plain",
          signal,
        )
      : { ok: true as const, value: null };
  if (!expansion.ok) {
    return expansion;
  }
  return {
    ok: true,
    value: {
      stated: stated.value,
      inlineBytes: decoded.bytes,
      inlineByteLength: decoded.bytes.byteLength,
      expansion: expansion.value,
      digest:
        expansion.value?.digest ??
        (needsExpansion ? digestOf(decoded.bytes) : digestOf(inline.value)),
      encoding: decoded.encoding,
      text: decoded.text,
    },
  };
}

async function readBinarySnapshot(
  fileSystem: FileSystemPort,
  bound: BoundWorkspacePath,
  settings: ReadSettings,
  artifacts: ArtifactStorePort | undefined,
  signal?: AbortSignal,
): Promise<
  | { readonly ok: true; readonly value: ReadSnapshot }
  | { readonly ok: false; readonly error: WorkspaceReadError }
> {
  const stated = await statFile(fileSystem, bound, signal);
  if (!stated.ok) {
    return stated;
  }
  const needsExpansion = stated.value.byteLength > settings.maxFileBytes;
  if (needsExpansion && artifacts === undefined) {
    return { ok: false, error: { code: "oversized", byteLength: stated.value.byteLength } };
  }
  const inline = await readInlineBytes(
    fileSystem,
    bound,
    Math.min(stated.value.byteLength, settings.maxFileBytes),
    signal,
  );
  if (!inline.ok) {
    return inline;
  }
  const expansion =
    needsExpansion && artifacts !== undefined
      ? await expandExact(
          fileSystem,
          bound,
          stated.value,
          settings,
          artifacts,
          "application/octet-stream",
          signal,
        )
      : { ok: true as const, value: null };
  if (!expansion.ok) {
    return expansion;
  }
  return {
    ok: true,
    value: {
      stated: stated.value,
      inlineBytes: inline.value,
      inlineByteLength: inline.value.byteLength,
      expansion: expansion.value,
      digest: expansion.value?.digest ?? digestOf(inline.value),
      encoding: "binary",
      text: null,
    },
  };
}

function applySourceByteRange(
  bytes: Uint8Array,
  range: ByteRange,
  sourceByteLength: number,
  encoding: TextSnapshot["encoding"],
):
  | { readonly ok: true; readonly value: { readonly text: string; readonly truncated: boolean } }
  | { readonly ok: false; readonly error: WorkspaceReadError } {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start
  ) {
    return { ok: false, error: { code: "malformed-range" } };
  }
  const end = Math.min(range.end, bytes.byteLength);
  const start = Math.min(range.start, bytes.byteLength);
  const source = bytes.subarray(start, end);
  const decodeBytes =
    encoding === "utf-16le" || encoding === "utf-16be"
      ? decodeUtf16Range(source, start, encoding)
      : source;
  if (decodeBytes === null) {
    return { ok: false, error: { code: "malformed-encoding" } };
  }
  const decoded = decodeWorkspaceText(decodeBytes);
  if (!decoded.ok) {
    return { ok: false, error: { code: "malformed-encoding" } };
  }
  if (isBinaryText(decoded.value.text)) {
    return { ok: false, error: { code: "binary" } };
  }
  return {
    ok: true,
    value: {
      text: decoded.value.text,
      truncated: range.end < sourceByteLength,
    },
  };
}

function decodeUtf16Range(
  bytes: Uint8Array,
  sourceStart: number,
  encoding: "utf-16le" | "utf-16be",
): Uint8Array | null {
  if (sourceStart === 0) {
    return bytes;
  }
  if (sourceStart < 2 || (sourceStart - 2) % 2 !== 0) {
    return null;
  }
  const bom = encoding === "utf-16le" ? [0xff, 0xfe] : [0xfe, 0xff];
  const withBom = new Uint8Array(bytes.byteLength + bom.length);
  withBom.set(bom);
  withBom.set(bytes, bom.length);
  return withBom;
}

function workspaceTextResult(
  bound: BoundWorkspacePath,
  snapshot: TextSnapshot,
  requestedRange: WorkspaceReadRange | undefined,
  actualRange: WorkspaceReadRange | null,
  text: string,
  newline: WorkspaceFileRead["newline"],
  truncated: boolean,
  continuation: WorkspaceReadContinuation | null,
  diagnostics: readonly WorkspaceReadDiagnostic[],
  lineStart = 1,
): WorkspaceFileRead {
  return {
    bound,
    kind: snapshot.stated.kind,
    byteLength: snapshot.stated.byteLength,
    requestedTarget: bound.requested,
    resolvedTarget: snapshot.stated.path,
    sourceIdentity: snapshot.stated.path,
    revision: snapshot.stated.revision,
    digest: snapshot.digest,
    completeness: truncated ? "partial" : "complete",
    fidelity: "exact",
    encoding: snapshot.encoding,
    newline,
    range: requestedRange ?? null,
    actualRange,
    inlineByteLength: snapshot.inlineByteLength,
    lines: numberLines(text, lineStart),
    truncated,
    continuation,
    expansion: snapshot.expansion,
    diagnostics,
  };
}

export function createWorkspaceReader(
  fileSystem: FileSystemPort,
  options: WorkspaceReaderOptions = {},
): WorkspaceReader {
  return {
    async read(root, value, range, limits, signal) {
      const parsedLimits = parseReadLimits(limits);
      if (!parsedLimits.ok) {
        return parsedLimits;
      }
      const bound = await bindReadPath(fileSystem, root, value, signal);
      if (!bound.ok) {
        return bound;
      }
      return readBound(
        fileSystem,
        bound.value,
        range,
        parsedLimits.value,
        options.artifacts,
        signal,
      );
    },

    async readBytes(root, value, limits, signal) {
      const parsedLimits = parseReadLimits(limits);
      if (!parsedLimits.ok) {
        return parsedLimits;
      }
      const bound = await bindReadPath(fileSystem, root, value, signal);
      if (!bound.ok) {
        return bound;
      }
      return readBytesBound(fileSystem, bound.value, parsedLimits.value, options.artifacts, signal);
    },

    async readMany(root, targets, limits, signal) {
      if (targets.length > MAX_READ_MANY_TARGETS) {
        return { ok: false, error: { code: "too-many-targets" } };
      }
      const parsedLimits = parseReadLimits(limits);
      if (!parsedLimits.ok) {
        return parsedLimits;
      }
      const settings = parsedLimits.value;
      const items: WorkspaceReadManyItem[] = [];
      if (targets.length === 0) {
        return {
          ok: true,
          value: { items, aggregateBytes: 0, completeness: "complete", limitReached: false },
        };
      }

      const boundTargets: (
        | {
            readonly index: number;
            readonly ok: true;
            readonly bound: BoundWorkspacePath;
            readonly range?: WorkspaceReadRange;
          }
        | { readonly index: number; readonly ok: false; readonly error: WorkspaceReadError }
      )[] = [];
      for (let index = 0; index < targets.length; index += 1) {
        if (isAborted(signal)) {
          boundTargets.push({ index, ok: false, error: { code: "cancelled" } });
          continue;
        }
        const target = targets[index];
        if (target === undefined) {
          continue;
        }
        const bound = await bindReadPath(fileSystem, root, target.path, signal);
        if (!bound.ok) {
          boundTargets.push({ index, ok: false, error: bound.error });
          continue;
        }
        if (target.range === undefined) {
          boundTargets.push({ index, ok: true, bound: bound.value });
        } else {
          boundTargets.push({ index, ok: true, bound: bound.value, range: target.range });
        }
      }

      const firstByResolved = new Map<string, number>();
      const uniqueOrder: string[] = [];
      for (const bound of boundTargets) {
        if (!bound.ok) {
          continue;
        }
        if (!firstByResolved.has(bound.bound.resolved)) {
          firstByResolved.set(bound.bound.resolved, bound.index);
          uniqueOrder.push(bound.bound.resolved);
        }
      }

      const uniqueResults = new Map<
        string,
        | { readonly status: "read"; readonly value: WorkspaceFileRead }
        | { readonly status: "failed"; readonly error: WorkspaceReadError }
        | { readonly status: "unscheduled"; readonly error: WorkspaceReadError }
      >();
      let aggregate = 0;
      let nextUnique = 0;

      const runUnique = async (resolved: string): Promise<void> => {
        const firstIndex = firstByResolved.get(resolved);
        const source = boundTargets.find((item) => item.ok && item.index === firstIndex);
        if (firstIndex === undefined || source === undefined || !source.ok) {
          return;
        }
        if (isAborted(signal)) {
          uniqueResults.set(resolved, { status: "failed", error: { code: "cancelled" } });
          return;
        }
        if (aggregate >= settings.maxAggregateBytes) {
          uniqueResults.set(resolved, {
            status: "unscheduled",
            error: { code: "oversized", byteLength: aggregate },
          });
          return;
        }
        const read = await readBound(
          fileSystem,
          source.bound,
          source.range,
          settings,
          options.artifacts,
          signal,
        );
        if (!read.ok) {
          uniqueResults.set(resolved, { status: "failed", error: read.error });
          return;
        }
        const size = read.value.inlineByteLength;
        if (aggregate + size > settings.maxAggregateBytes) {
          uniqueResults.set(resolved, {
            status: "unscheduled",
            error: { code: "oversized", byteLength: aggregate + size },
          });
          return;
        }
        aggregate += size;
        uniqueResults.set(resolved, { status: "read", value: read.value });
      };

      const workers = Array.from(
        { length: Math.min(settings.maxConcurrency, uniqueOrder.length) },
        async () => {
          while (true) {
            const slot = nextUnique;
            nextUnique += 1;
            const resolved = uniqueOrder[slot];
            if (resolved === undefined) {
              break;
            }
            await runUnique(resolved);
          }
        },
      );
      await Promise.all(workers);

      for (const bound of boundTargets) {
        if (!bound.ok) {
          items.push({ index: bound.index, status: "failed", error: bound.error });
          continue;
        }
        const unique = uniqueResults.get(bound.bound.resolved);
        if (unique === undefined) {
          items.push({ index: bound.index, status: "failed", error: { code: "cancelled" } });
          continue;
        }
        if (unique.status === "read") {
          items.push({
            index: bound.index,
            status: "read",
            value: { ...unique.value, bound: bound.bound },
          });
          continue;
        }
        items.push({ index: bound.index, status: unique.status, error: unique.error });
      }
      items.sort((left, right) => left.index - right.index);
      const limitReached = items.some(
        (item) =>
          item.status === "unscheduled" ||
          (item.status === "read" && item.value.completeness === "partial"),
      );
      return {
        ok: true,
        value: {
          items,
          aggregateBytes: aggregate,
          completeness: limitReached ? "partial" : "complete",
          limitReached,
        },
      };
    },
  };
}
