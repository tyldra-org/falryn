/**
 * Symbol and changed-region readers (#492).
 *
 * The backend supplies derived language evidence. This application seam binds
 * every backend path and verifies current source ranges through #56 before
 * returning a result.
 */

import {
  assertNever,
  type BoundWorkspacePath,
  bindWorkspacePath,
  DEFAULT_MAX_FILE_BYTES,
  type LanguageBackendChangedRegion,
  type LanguageBackendChangedRegionsOutcome,
  type LanguageBackendEvidence,
  type LanguageBackendLocation,
  type LanguageBackendPort,
  type LanguageBackendSymbolOutcome,
  type LanguageCapability,
  type LanguageChangedRegion,
  type LanguageChangedRegionsRead,
  type LanguageComparison,
  type LanguageDiagnostic,
  type LanguageEvidence,
  type LanguageLocation,
  type LanguageOmission,
  type LanguageRange,
  type LanguageReadError,
  type LanguageRelatedEvidence,
  type LanguageSourceExcerpt,
  type LanguageSymbolRead,
  type LocalPath,
  normalizeLanguageBackendChangedRegionsOutcome,
  normalizeLanguageBackendSymbolOutcome,
  parseLanguageChangedRegionsReadRequest,
  parseLanguageSymbolReadRequest,
  type WorkspaceFileRead,
  type WorkspaceReadError,
  type WorkspaceReadRange,
} from "../domain/index.ts";
import type { WorkspaceReader } from "./workspace-read.ts";

export type LanguageReader = {
  readSymbol(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: LanguageSymbolRead }
    | { readonly ok: false; readonly error: LanguageReadError }
  >;
  readChangedRegions(
    root: LocalPath,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly value: LanguageChangedRegionsRead }
    | { readonly ok: false; readonly error: LanguageReadError }
  >;
};

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function logicalPath(path: BoundWorkspacePath): string {
  return path.logical === "" ? "." : path.logical;
}

function bindBackendPath(
  root: LocalPath,
  path: string,
):
  | { readonly ok: true; readonly value: BoundWorkspacePath }
  | { readonly ok: false; readonly error: LanguageReadError } {
  return bindWorkspacePath(root, path);
}

function mapSourceReadError(error: WorkspaceReadError): LanguageReadError {
  switch (error.code) {
    case "malformed":
    case "escaped":
    case "absolute-unscoped":
      return error;
    case "symlink-escape":
    case "not-found":
    case "not-a-file":
    case "oversized":
    case "binary":
    case "malformed-encoding":
    case "malformed-range":
      return { code: "source", reason: error.code };
    case "cancelled":
      return { code: "cancelled" };
    case "too-many-targets":
    case "filesystem":
      return { code: "source", reason: "filesystem" };
    default:
      return assertNever(error, "unhandled workspace read error");
  }
}

function exactSourceText(lines: WorkspaceFileRead["lines"], range: LanguageRange): string | null {
  if (lines.length === 0) {
    return null;
  }
  const selected = lines.map((line) => line.text);
  const first = selected[0];
  const last = selected[selected.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }
  if (range.start.line === range.end.line) {
    return first.slice(range.start.character, range.end.character);
  }
  return [
    first.slice(range.start.character),
    ...selected.slice(1, -1),
    last.slice(0, range.end.character),
  ].join("\n");
}

async function readExactSource(
  workspaceReader: WorkspaceReader,
  root: LocalPath,
  path: string,
  range: LanguageRange,
  maxSourceBytes: number,
  maxSourceLines: number,
  expectedGeneration: string,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly value: LanguageSourceExcerpt }
  | { readonly ok: false; readonly error: LanguageReadError }
> {
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const lineCount = range.end.line - range.start.line + 1;
  if (lineCount > maxSourceLines) {
    return {
      ok: false,
      error: {
        code: "capped",
        limit: "maxSourceLines",
        requested: lineCount,
        maximum: maxSourceLines,
      },
    };
  }
  const readRange: WorkspaceReadRange = {
    kind: "line",
    range: {
      start: range.start.line + 1,
      end: range.end.line + 1,
    },
  };
  const read = await workspaceReader.read(
    root,
    path,
    readRange,
    { maxFileBytes: DEFAULT_MAX_FILE_BYTES },
    signal,
  );
  if (!read.ok) {
    return { ok: false, error: mapSourceReadError(read.error) };
  }
  const firstLine = read.value.lines[0];
  const lastLine = read.value.lines[read.value.lines.length - 1];
  if (
    firstLine === undefined ||
    lastLine === undefined ||
    firstLine.number !== range.start.line + 1 ||
    lastLine.number !== range.end.line + 1 ||
    range.start.character > firstLine.text.length ||
    range.end.character > lastLine.text.length
  ) {
    return {
      ok: false,
      error: {
        code: "stale",
        expectedGeneration,
        actualGeneration: undefined,
      },
    };
  }
  const text = exactSourceText(read.value.lines, range);
  if (text === null) {
    return {
      ok: false,
      error: {
        code: "stale",
        expectedGeneration,
        actualGeneration: undefined,
      },
    };
  }
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > maxSourceBytes) {
    return {
      ok: false,
      error: {
        code: "capped",
        limit: "maxSourceBytes",
        requested: byteLength,
        maximum: maxSourceBytes,
      },
    };
  }
  return {
    ok: true,
    value: {
      bound: read.value.bound,
      range,
      text,
      byteLength,
      newline: read.value.newline,
      exact: true,
    },
  };
}

function bindLocation(
  root: LocalPath,
  location: LanguageBackendLocation,
):
  | { readonly ok: true; readonly value: LanguageLocation }
  | { readonly ok: false; readonly error: LanguageReadError } {
  const bound = bindBackendPath(root, location.path);
  if (!bound.ok) {
    return bound;
  }
  return {
    ok: true,
    value: {
      path: bound.value,
      range: location.range,
    },
  };
}

function toEvidence(provenance: Omit<LanguageEvidence, "derived">): LanguageEvidence {
  return {
    ...provenance,
    derived: true,
  };
}

function appendOmission(
  omissions: LanguageOmission[],
  kind: LanguageOmission["kind"],
  count: number,
): void {
  if (count > 0) {
    omissions.push({ kind, count });
  }
}

function backendFailure(
  outcome: LanguageBackendSymbolOutcome | LanguageBackendChangedRegionsOutcome,
  capability: LanguageCapability,
): LanguageReadError | null {
  switch (outcome.status) {
    case "found":
    case "partial":
      return null;
    case "not-found":
      return {
        code: "not-found",
        target: capability === "read_symbol" ? "symbol" : "changed-regions",
      };
    case "unsupported":
      return { code: "unsupported", capability };
    case "unavailable":
      return { code: "unavailable", capability, retryable: outcome.retryable };
    case "stale":
      return {
        code: "stale",
        expectedGeneration: outcome.expectedGeneration,
        actualGeneration: outcome.actualGeneration ?? undefined,
      };
    case "denied":
      return { code: "denied", capability };
    case "timed-out":
      return { code: "timed-out", capability };
    case "cancelled":
      return { code: "cancelled" };
    default:
      return assertNever(outcome, "unhandled language backend outcome");
  }
}

function bindDocumentPath(
  root: LocalPath,
  requestedPath: BoundWorkspacePath,
  returnedPath: string,
):
  | { readonly ok: true; readonly value: BoundWorkspacePath }
  | { readonly ok: false; readonly error: LanguageReadError } {
  const bound = bindBackendPath(root, returnedPath);
  if (!bound.ok) {
    return bound;
  }
  if (logicalPath(bound.value) !== logicalPath(requestedPath)) {
    return { ok: false, error: { code: "malformed-backend", field: "path" } };
  }
  return bound;
}

function mapRelatedEvidence(
  root: LocalPath,
  related: readonly LanguageBackendEvidence[],
  maximum: number,
):
  | {
      readonly ok: true;
      readonly value: readonly LanguageRelatedEvidence[];
      readonly omitted: number;
    }
  | { readonly ok: false; readonly error: LanguageReadError } {
  const values: LanguageRelatedEvidence[] = [];
  const selected = related.slice(0, maximum);
  for (const evidence of selected) {
    const location = bindLocation(root, evidence.location);
    if (!location.ok) {
      return location;
    }
    values.push({
      kind: evidence.kind,
      label: evidence.label,
      location: location.value,
    });
  }
  return {
    ok: true,
    value: values,
    omitted: related.length - selected.length,
  };
}

async function readSymbol(
  backend: LanguageBackendPort,
  workspaceReader: WorkspaceReader,
  root: LocalPath,
  request: unknown,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly value: LanguageSymbolRead }
  | { readonly ok: false; readonly error: LanguageReadError }
> {
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const parsed = parseLanguageSymbolReadRequest(request);
  if (!parsed.ok) {
    return parsed;
  }
  const requestedPath = bindBackendPath(root, parsed.value.path);
  if (!requestedPath.ok) {
    return requestedPath;
  }
  let raw: unknown;
  try {
    raw = await backend.readSymbol({
      root,
      path: logicalPath(requestedPath.value),
      symbol: parsed.value.symbol,
      related: parsed.value.related,
      expectedGeneration: parsed.value.expectedGeneration,
      limits: parsed.value.limits,
      signal,
    });
  } catch {
    return {
      ok: false,
      error: { code: "unavailable", capability: "read_symbol", retryable: false },
    };
  }
  const normalized = normalizeLanguageBackendSymbolOutcome(raw);
  if (!normalized.ok) {
    return normalized;
  }
  if (normalized.value.status !== "found" && normalized.value.status !== "partial") {
    const failure = backendFailure(normalized.value, "read_symbol");
    if (failure === null) {
      return { ok: false, error: { code: "malformed-backend", field: "symbol" } };
    }
    return { ok: false, error: failure };
  }
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const payload = normalized.value.value;
  const document = bindDocumentPath(root, requestedPath.value, payload.document.path);
  if (!document.ok) {
    return document;
  }
  if (payload.document.generation !== payload.provenance.generation) {
    return { ok: false, error: { code: "malformed-backend", field: "provenance" } };
  }
  if (
    parsed.value.expectedGeneration !== undefined &&
    parsed.value.expectedGeneration !== payload.provenance.generation
  ) {
    return {
      ok: false,
      error: {
        code: "stale",
        expectedGeneration: parsed.value.expectedGeneration,
        actualGeneration: payload.provenance.generation,
      },
    };
  }
  const source = await readExactSource(
    workspaceReader,
    root,
    logicalPath(document.value),
    payload.symbol.range,
    parsed.value.limits.maxSourceBytes,
    parsed.value.limits.maxSourceLines,
    payload.provenance.generation,
    signal,
  );
  if (!source.ok) {
    return source;
  }
  const related = mapRelatedEvidence(root, payload.related, parsed.value.limits.maxRelatedEvidence);
  if (!related.ok) {
    return related;
  }
  const omissions = [...payload.omissions];
  appendOmission(omissions, "related-evidence", related.omitted);
  return {
    ok: true,
    value: {
      capability: "read_symbol",
      status:
        normalized.value.status === "partial" || omissions.length > 0 ? "partial" : "complete",
      document: {
        path: document.value,
        version: payload.document.version,
        generation: payload.document.generation,
      },
      symbol: {
        name: payload.symbol.name,
        kind: payload.symbol.kind,
        range: payload.symbol.range,
        declarationRange: payload.symbol.declarationRange ?? null,
        selectionRange: payload.symbol.selectionRange ?? null,
        containerName: payload.symbol.containerName ?? null,
      },
      source: source.value,
      related: related.value,
      provenance: toEvidence(payload.provenance),
      omissions,
    },
  };
}

function compareLanguageComparisons(left: LanguageComparison, right: LanguageComparison): boolean {
  switch (left.kind) {
    case "working-tree":
      return right.kind === "working-tree";
    case "git":
      return right.kind === "git" && left.base === right.base;
    case "document-generation":
      return right.kind === "document-generation" && left.generation === right.generation;
    default:
      return assertNever(left, "unhandled language comparison");
  }
}

function mapDiagnostic(
  root: LocalPath,
  diagnostic: LanguageBackendChangedRegion["diagnostics"][number],
):
  | { readonly ok: true; readonly value: LanguageDiagnostic }
  | { readonly ok: false; readonly error: LanguageReadError } {
  if (diagnostic.location === null) {
    return {
      ok: true,
      value: {
        severity: diagnostic.severity,
        code: diagnostic.code,
        message: diagnostic.message,
        location: null,
      },
    };
  }
  const location = bindLocation(root, diagnostic.location);
  if (!location.ok) {
    return location;
  }
  return {
    ok: true,
    value: {
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
      location: location.value,
    },
  };
}

async function mapChangedRegion(
  workspaceReader: WorkspaceReader,
  root: LocalPath,
  region: LanguageBackendChangedRegion,
  limits: {
    readonly maxSourceBytes: number;
    readonly maxSourceLines: number;
    readonly maxDiagnostics: number;
    readonly maxDependencies: number;
  },
  generation: string,
  signal: AbortSignal | undefined,
): Promise<
  | {
      readonly ok: true;
      readonly value: LanguageChangedRegion;
      readonly omissions: readonly LanguageOmission[];
    }
  | { readonly ok: false; readonly error: LanguageReadError }
> {
  const path = bindBackendPath(root, region.path);
  if (!path.ok) {
    return path;
  }
  const omissions: LanguageOmission[] = [];
  const diagnostics: LanguageDiagnostic[] = [];
  for (const diagnostic of region.diagnostics.slice(0, limits.maxDiagnostics)) {
    const mapped = mapDiagnostic(root, diagnostic);
    if (!mapped.ok) {
      return mapped;
    }
    diagnostics.push(mapped.value);
  }
  appendOmission(omissions, "diagnostics", region.diagnostics.length - diagnostics.length);

  const dependencies: LanguageLocation[] = [];
  for (const dependency of region.dependencies.slice(0, limits.maxDependencies)) {
    const mapped = bindLocation(root, dependency);
    if (!mapped.ok) {
      return mapped;
    }
    dependencies.push(mapped.value);
  }
  appendOmission(omissions, "dependencies", region.dependencies.length - dependencies.length);

  let source: LanguageSourceExcerpt | null = null;
  if (region.change !== "deleted") {
    const exact = await readExactSource(
      workspaceReader,
      root,
      logicalPath(path.value),
      region.range,
      limits.maxSourceBytes,
      limits.maxSourceLines,
      generation,
      signal,
    );
    if (!exact.ok) {
      return exact;
    }
    source = exact.value;
  }
  return {
    ok: true,
    value: {
      path: path.value,
      range: region.range,
      change: region.change,
      symbol:
        region.symbol === null
          ? null
          : {
              name: region.symbol.name,
              kind: region.symbol.kind,
              range: region.symbol.range,
            },
      diagnostics,
      dependencies,
      source,
    },
    omissions,
  };
}

async function readChangedRegions(
  backend: LanguageBackendPort,
  workspaceReader: WorkspaceReader,
  root: LocalPath,
  request: unknown,
  signal: AbortSignal | undefined,
): Promise<
  | { readonly ok: true; readonly value: LanguageChangedRegionsRead }
  | { readonly ok: false; readonly error: LanguageReadError }
> {
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const parsed = parseLanguageChangedRegionsReadRequest(request);
  if (!parsed.ok) {
    return parsed;
  }
  const paths: string[] = [];
  for (const path of parsed.value.paths) {
    const bound = bindBackendPath(root, path);
    if (!bound.ok) {
      return bound;
    }
    paths.push(logicalPath(bound.value));
  }
  let raw: unknown;
  try {
    raw = await backend.readChangedRegions({
      root,
      comparison: parsed.value.comparison,
      paths,
      expectedGeneration: parsed.value.expectedGeneration,
      limits: parsed.value.limits,
      signal,
    });
  } catch {
    return {
      ok: false,
      error: {
        code: "unavailable",
        capability: "read_changed_regions",
        retryable: false,
      },
    };
  }
  const normalized = normalizeLanguageBackendChangedRegionsOutcome(raw);
  if (!normalized.ok) {
    return normalized;
  }
  if (normalized.value.status !== "found" && normalized.value.status !== "partial") {
    const failure = backendFailure(normalized.value, "read_changed_regions");
    if (failure === null) {
      return { ok: false, error: { code: "malformed-backend", field: "changed-regions" } };
    }
    return { ok: false, error: failure };
  }
  if (isAborted(signal)) {
    return { ok: false, error: { code: "cancelled" } };
  }
  const payload = normalized.value.value;
  if (!compareLanguageComparisons(parsed.value.comparison, payload.comparison)) {
    return { ok: false, error: { code: "malformed-backend", field: "changed-regions" } };
  }
  if (
    parsed.value.expectedGeneration !== undefined &&
    parsed.value.expectedGeneration !== payload.provenance.generation
  ) {
    return {
      ok: false,
      error: {
        code: "stale",
        expectedGeneration: parsed.value.expectedGeneration,
        actualGeneration: payload.provenance.generation,
      },
    };
  }

  const omissions = [...payload.omissions];
  const regions: LanguageChangedRegion[] = [];
  let aggregateSourceBytes = 0;
  const selected = payload.regions.slice(0, parsed.value.limits.maxRegions);
  for (const region of selected) {
    if (isAborted(signal)) {
      return { ok: false, error: { code: "cancelled" } };
    }
    const mapped = await mapChangedRegion(
      workspaceReader,
      root,
      region,
      parsed.value.limits,
      payload.provenance.generation,
      signal,
    );
    if (!mapped.ok) {
      return mapped;
    }
    if (
      mapped.value.source !== null &&
      aggregateSourceBytes + mapped.value.source.byteLength >
        parsed.value.limits.maxAggregateSourceBytes
    ) {
      appendOmission(omissions, "source-bytes", payload.regions.length - regions.length);
      break;
    }
    if (mapped.value.source !== null) {
      aggregateSourceBytes += mapped.value.source.byteLength;
    }
    regions.push(mapped.value);
    omissions.push(...mapped.omissions);
  }
  appendOmission(omissions, "regions", payload.regions.length - selected.length);
  const status =
    normalized.value.status === "partial" || omissions.length > 0
      ? "partial"
      : regions.length === 0
        ? "empty"
        : "complete";
  return {
    ok: true,
    value: {
      capability: "read_changed_regions",
      status,
      comparison: payload.comparison,
      regions,
      provenance: toEvidence(payload.provenance),
      omissions,
    },
  };
}

export function createLanguageReader(
  backend: LanguageBackendPort,
  workspaceReader: WorkspaceReader,
): LanguageReader {
  return {
    readSymbol(root, request, signal) {
      return readSymbol(backend, workspaceReader, root, request, signal);
    },
    readChangedRegions(root, request, signal) {
      return readChangedRegions(backend, workspaceReader, root, request, signal);
    },
  };
}
