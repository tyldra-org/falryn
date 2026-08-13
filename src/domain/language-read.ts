/**
 * Symbol and changed-region reader contracts (#492).
 *
 * Language backends return derived, bounded evidence through Falryn-owned
 * shapes. The application layer binds every returned path and re-reads current
 * source ranges through the workspace reader before exposing them.
 */

import { z } from "zod";
import type { LocalPath } from "./filesystem.ts";
import { MAX_LOCAL_PATH_LENGTH } from "./filesystem.ts";
import { assertNever, err, ok, type Result } from "./result.ts";
import type { BoundWorkspacePath, WorkspacePathBindError } from "./workspace-path.ts";
import type { NewlineStyle } from "./workspace-read.ts";

export const LANGUAGE_CAPABILITIES = ["read_symbol", "read_changed_regions"] as const;
export type LanguageCapability = (typeof LANGUAGE_CAPABILITIES)[number];

export const LANGUAGE_BACKENDS = ["language-server", "symbol-index", "syntax", "lexical"] as const;
export type LanguageBackend = (typeof LANGUAGE_BACKENDS)[number];

export const LANGUAGE_CONFIDENCES = ["semantic", "structural", "lexical"] as const;
export type LanguageConfidence = (typeof LANGUAGE_CONFIDENCES)[number];

export const LANGUAGE_SYMBOL_KINDS = [
  "file",
  "module",
  "namespace",
  "class",
  "method",
  "function",
  "property",
  "field",
  "constructor",
  "enum",
  "interface",
  "variable",
  "constant",
  "type",
  "unknown",
] as const;
export type LanguageSymbolKind = (typeof LANGUAGE_SYMBOL_KINDS)[number];

export const LANGUAGE_EVIDENCE_KINDS = [
  "signature",
  "doc-comment",
  "caller",
  "implementation",
  "test",
] as const;
export type LanguageEvidenceKind = (typeof LANGUAGE_EVIDENCE_KINDS)[number];

export const LANGUAGE_CHANGE_KINDS = ["added", "modified", "deleted"] as const;
export type LanguageChangeKind = (typeof LANGUAGE_CHANGE_KINDS)[number];

export const LANGUAGE_DIAGNOSTIC_SEVERITIES = ["error", "warning", "info", "hint"] as const;
export type LanguageDiagnosticSeverity = (typeof LANGUAGE_DIAGNOSTIC_SEVERITIES)[number];

export const LANGUAGE_OMISSION_KINDS = [
  "related-evidence",
  "regions",
  "diagnostics",
  "dependencies",
  "source-bytes",
  "paths",
] as const;
export type LanguageOmissionKind = (typeof LANGUAGE_OMISSION_KINDS)[number];

export const DEFAULT_MAX_LANGUAGE_SOURCE_BYTES = 64 * 1024;
export const DEFAULT_MAX_LANGUAGE_SOURCE_LINES = 512;
export const DEFAULT_MAX_LANGUAGE_AGGREGATE_SOURCE_BYTES = 256 * 1024;
export const DEFAULT_MAX_LANGUAGE_REGIONS = 64;
export const DEFAULT_MAX_LANGUAGE_RELATED_EVIDENCE = 8;
export const DEFAULT_MAX_LANGUAGE_DIAGNOSTICS = 16;
export const DEFAULT_MAX_LANGUAGE_DEPENDENCIES = 16;
export const DEFAULT_MAX_LANGUAGE_PATHS = 64;

export const MAX_LANGUAGE_SOURCE_BYTES = 256 * 1024;
export const MAX_LANGUAGE_SOURCE_LINES = 4_096;
export const MAX_LANGUAGE_AGGREGATE_SOURCE_BYTES = 1024 * 1024;
export const MAX_LANGUAGE_REGIONS = 256;
export const MAX_LANGUAGE_RELATED_EVIDENCE = 64;
export const MAX_LANGUAGE_DIAGNOSTICS = 64;
export const MAX_LANGUAGE_DEPENDENCIES = 64;
export const MAX_LANGUAGE_PATHS = 256;
export const MAX_LANGUAGE_BACKEND_ARRAY = 1_024;

export const LANGUAGE_LIMIT_NAMES = [
  "maxSourceBytes",
  "maxSourceLines",
  "maxAggregateSourceBytes",
  "maxRegions",
  "maxRelatedEvidence",
  "maxDiagnostics",
  "maxDependencies",
  "maxPaths",
] as const;
export type LanguageLimitName = (typeof LANGUAGE_LIMIT_NAMES)[number];

const languageLimitsInputSchema = z
  .object({
    maxSourceBytes: z.number().int().positive().optional(),
    maxSourceLines: z.number().int().positive().optional(),
    maxAggregateSourceBytes: z.number().int().positive().optional(),
    maxRegions: z.number().int().positive().optional(),
    maxRelatedEvidence: z.number().int().positive().optional(),
    maxDiagnostics: z.number().int().positive().optional(),
    maxDependencies: z.number().int().positive().optional(),
    maxPaths: z.number().int().positive().optional(),
  })
  .strict();

export type LanguageReadLimitsInput = z.infer<typeof languageLimitsInputSchema>;

export type LanguageReadLimits = {
  readonly maxSourceBytes: number;
  readonly maxSourceLines: number;
  readonly maxAggregateSourceBytes: number;
  readonly maxRegions: number;
  readonly maxRelatedEvidence: number;
  readonly maxDiagnostics: number;
  readonly maxDependencies: number;
  readonly maxPaths: number;
};

export const DEFAULT_LANGUAGE_READ_LIMITS: LanguageReadLimits = {
  maxSourceBytes: DEFAULT_MAX_LANGUAGE_SOURCE_BYTES,
  maxSourceLines: DEFAULT_MAX_LANGUAGE_SOURCE_LINES,
  maxAggregateSourceBytes: DEFAULT_MAX_LANGUAGE_AGGREGATE_SOURCE_BYTES,
  maxRegions: DEFAULT_MAX_LANGUAGE_REGIONS,
  maxRelatedEvidence: DEFAULT_MAX_LANGUAGE_RELATED_EVIDENCE,
  maxDiagnostics: DEFAULT_MAX_LANGUAGE_DIAGNOSTICS,
  maxDependencies: DEFAULT_MAX_LANGUAGE_DEPENDENCIES,
  maxPaths: DEFAULT_MAX_LANGUAGE_PATHS,
};

const MAX_LANGUAGE_LIMITS: LanguageReadLimits = {
  maxSourceBytes: MAX_LANGUAGE_SOURCE_BYTES,
  maxSourceLines: MAX_LANGUAGE_SOURCE_LINES,
  maxAggregateSourceBytes: MAX_LANGUAGE_AGGREGATE_SOURCE_BYTES,
  maxRegions: MAX_LANGUAGE_REGIONS,
  maxRelatedEvidence: MAX_LANGUAGE_RELATED_EVIDENCE,
  maxDiagnostics: MAX_LANGUAGE_DIAGNOSTICS,
  maxDependencies: MAX_LANGUAGE_DEPENDENCIES,
  maxPaths: MAX_LANGUAGE_PATHS,
};

export type LanguageLimitError =
  | { readonly code: "malformed-limits"; readonly field: LanguageLimitName }
  | {
      readonly code: "limit-too-large";
      readonly field: LanguageLimitName;
      readonly maximum: number;
    };

function limitFieldFromIssue(path: readonly PropertyKey[]): LanguageLimitName {
  const field = path[0];
  return typeof field === "string" && LANGUAGE_LIMIT_NAMES.includes(field as LanguageLimitName)
    ? (field as LanguageLimitName)
    : "maxSourceBytes";
}

export function languageReadLimits(
  value: unknown = {},
): Result<LanguageReadLimits, LanguageLimitError> {
  const parsed = languageLimitsInputSchema.safeParse(value);
  if (!parsed.success) {
    return err({
      code: "malformed-limits",
      field: limitFieldFromIssue(parsed.error.issues[0]?.path ?? []),
    });
  }
  const candidate: LanguageReadLimits = {
    maxSourceBytes: parsed.data.maxSourceBytes ?? DEFAULT_LANGUAGE_READ_LIMITS.maxSourceBytes,
    maxSourceLines: parsed.data.maxSourceLines ?? DEFAULT_LANGUAGE_READ_LIMITS.maxSourceLines,
    maxAggregateSourceBytes:
      parsed.data.maxAggregateSourceBytes ?? DEFAULT_LANGUAGE_READ_LIMITS.maxAggregateSourceBytes,
    maxRegions: parsed.data.maxRegions ?? DEFAULT_LANGUAGE_READ_LIMITS.maxRegions,
    maxRelatedEvidence:
      parsed.data.maxRelatedEvidence ?? DEFAULT_LANGUAGE_READ_LIMITS.maxRelatedEvidence,
    maxDiagnostics: parsed.data.maxDiagnostics ?? DEFAULT_LANGUAGE_READ_LIMITS.maxDiagnostics,
    maxDependencies: parsed.data.maxDependencies ?? DEFAULT_LANGUAGE_READ_LIMITS.maxDependencies,
    maxPaths: parsed.data.maxPaths ?? DEFAULT_LANGUAGE_READ_LIMITS.maxPaths,
  };
  for (const field of LANGUAGE_LIMIT_NAMES) {
    const selected = candidate[field];
    const maximum = MAX_LANGUAGE_LIMITS[field];
    if (selected === undefined || maximum === undefined) {
      return err({ code: "malformed-limits", field });
    }
    if (selected > maximum) {
      return err({
        code: "limit-too-large",
        field,
        maximum,
      });
    }
  }
  return ok(candidate);
}

const languagePositionSchema = z
  .object({
    line: z.number().int().nonnegative(),
    character: z.number().int().nonnegative(),
  })
  .strict();

export type LanguagePosition = z.infer<typeof languagePositionSchema>;

const languageRangeSchema = z
  .object({
    start: languagePositionSchema,
    end: languagePositionSchema,
  })
  .strict();

export type LanguageRange = z.infer<typeof languageRangeSchema>;

export function isLanguageRange(value: unknown): value is LanguageRange {
  const parsed = languageRangeSchema.safeParse(value);
  if (!parsed.success) {
    return false;
  }
  const { start, end } = parsed.data;
  return start.line < end.line || (start.line === end.line && start.character <= end.character);
}

function hasNoControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) {
      return false;
    }
  }
  return true;
}

const generationSchema = z.string().min(1).max(128).refine(hasNoControlCharacters);

const pathTextSchema = z.string().min(1).max(MAX_LOCAL_PATH_LENGTH).refine(hasNoControlCharacters);

const symbolNameSchema = z.string().min(1).max(512).refine(hasNoControlCharacters);

const languageComparisonSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("working-tree") }).strict(),
  z.object({ kind: z.literal("git"), base: pathTextSchema }).strict(),
  z.object({ kind: z.literal("document-generation"), generation: generationSchema }).strict(),
]);

export type LanguageComparison = z.infer<typeof languageComparisonSchema>;

const provenanceSchema = z
  .object({
    backend: z.enum(LANGUAGE_BACKENDS),
    generation: generationSchema,
    confidence: z.enum(LANGUAGE_CONFIDENCES),
    fallback: z.boolean(),
  })
  .strict();

export type LanguageEvidence = z.infer<typeof provenanceSchema> & {
  readonly derived: true;
};

const omissionSchema = z
  .object({
    kind: z.enum(LANGUAGE_OMISSION_KINDS),
    count: z.number().int().positive(),
  })
  .strict();

export type LanguageOmission = z.infer<typeof omissionSchema>;

const backendLocationSchema = z
  .object({
    path: pathTextSchema,
    range: languageRangeSchema,
  })
  .strict();

export type LanguageBackendLocation = z.infer<typeof backendLocationSchema>;

const backendSymbolReferenceSchema = z
  .object({
    name: symbolNameSchema,
    kind: z.enum(LANGUAGE_SYMBOL_KINDS),
    range: languageRangeSchema,
  })
  .strict();

export type LanguageBackendSymbolReference = z.infer<typeof backendSymbolReferenceSchema>;

const backendSymbolSchema = z
  .object({
    name: symbolNameSchema,
    kind: z.enum(LANGUAGE_SYMBOL_KINDS),
    range: languageRangeSchema,
    declarationRange: languageRangeSchema.nullable().optional(),
    selectionRange: languageRangeSchema.nullable().optional(),
    containerName: symbolNameSchema.nullable().optional(),
  })
  .strict();

export type LanguageBackendSymbol = z.infer<typeof backendSymbolSchema>;

const backendEvidenceSchema = z
  .object({
    kind: z.enum(LANGUAGE_EVIDENCE_KINDS),
    label: symbolNameSchema,
    location: backendLocationSchema,
  })
  .strict();

export type LanguageBackendEvidence = z.infer<typeof backendEvidenceSchema>;

const backendDocumentSchema = z
  .object({
    path: pathTextSchema,
    version: z.number().int().nonnegative().nullable(),
    generation: generationSchema,
  })
  .strict();

export type LanguageBackendDocument = z.infer<typeof backendDocumentSchema>;

const backendDiagnosticSchema = z
  .object({
    severity: z.enum(LANGUAGE_DIAGNOSTIC_SEVERITIES),
    code: symbolNameSchema.nullable(),
    message: z.string().max(1_024).refine(hasNoControlCharacters),
    location: backendLocationSchema.nullable(),
  })
  .strict();

export type LanguageBackendDiagnostic = z.infer<typeof backendDiagnosticSchema>;

const backendProvenanceSchema = provenanceSchema;

const backendSymbolPayloadSchema = z
  .object({
    document: backendDocumentSchema,
    symbol: backendSymbolSchema,
    related: z.array(backendEvidenceSchema).max(MAX_LANGUAGE_BACKEND_ARRAY),
    provenance: backendProvenanceSchema,
    omissions: z.array(omissionSchema).max(MAX_LANGUAGE_BACKEND_ARRAY),
  })
  .strict();

export type LanguageBackendSymbolPayload = z.infer<typeof backendSymbolPayloadSchema>;

const backendChangedRegionSchema = z
  .object({
    path: pathTextSchema,
    range: languageRangeSchema,
    change: z.enum(LANGUAGE_CHANGE_KINDS),
    symbol: backendSymbolReferenceSchema.nullable(),
    diagnostics: z.array(backendDiagnosticSchema).max(MAX_LANGUAGE_BACKEND_ARRAY),
    dependencies: z.array(backendLocationSchema).max(MAX_LANGUAGE_BACKEND_ARRAY),
  })
  .strict();

export type LanguageBackendChangedRegion = z.infer<typeof backendChangedRegionSchema>;

const backendChangedPayloadSchema = z
  .object({
    comparison: languageComparisonSchema,
    regions: z.array(backendChangedRegionSchema).max(MAX_LANGUAGE_BACKEND_ARRAY),
    provenance: backendProvenanceSchema,
    omissions: z.array(omissionSchema).max(MAX_LANGUAGE_BACKEND_ARRAY),
  })
  .strict();

export type LanguageBackendChangedPayload = z.infer<typeof backendChangedPayloadSchema>;

const languageSymbolOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), value: backendSymbolPayloadSchema }).strict(),
  z.object({ status: z.literal("partial"), value: backendSymbolPayloadSchema }).strict(),
  z.object({ status: z.literal("not-found") }).strict(),
  z
    .object({
      status: z.literal("unsupported"),
      capability: z.literal("read_symbol"),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      capability: z.literal("read_symbol"),
      retryable: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("stale"),
      expectedGeneration: generationSchema,
      actualGeneration: generationSchema.nullable(),
    })
    .strict(),
  z.object({ status: z.literal("denied"), capability: z.literal("read_symbol") }).strict(),
  z.object({ status: z.literal("timed-out"), capability: z.literal("read_symbol") }).strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
]);

export type LanguageBackendSymbolOutcome = z.infer<typeof languageSymbolOutcomeSchema>;

const changedRegionsOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), value: backendChangedPayloadSchema }).strict(),
  z.object({ status: z.literal("partial"), value: backendChangedPayloadSchema }).strict(),
  z.object({ status: z.literal("not-found") }).strict(),
  z
    .object({
      status: z.literal("unsupported"),
      capability: z.literal("read_changed_regions"),
    })
    .strict(),
  z
    .object({
      status: z.literal("unavailable"),
      capability: z.literal("read_changed_regions"),
      retryable: z.boolean(),
    })
    .strict(),
  z
    .object({
      status: z.literal("stale"),
      expectedGeneration: generationSchema,
      actualGeneration: generationSchema.nullable(),
    })
    .strict(),
  z.object({ status: z.literal("denied"), capability: z.literal("read_changed_regions") }).strict(),
  z
    .object({ status: z.literal("timed-out"), capability: z.literal("read_changed_regions") })
    .strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
]);

export type LanguageBackendChangedRegionsOutcome = z.infer<typeof changedRegionsOutcomeSchema>;

export type LanguageSymbolReadRequest = {
  readonly path: string;
  readonly symbol: string;
  readonly related?: readonly LanguageEvidenceKind[];
  readonly expectedGeneration?: string;
  readonly limits?: LanguageReadLimitsInput;
};

export type LanguageChangedRegionsReadRequest = {
  readonly comparison?: LanguageComparison;
  readonly paths?: readonly string[];
  readonly expectedGeneration?: string;
  readonly limits?: LanguageReadLimitsInput;
};

export type LanguageRequestField =
  | "request"
  | "path"
  | "symbol"
  | "related"
  | "comparison"
  | "paths"
  | "generation"
  | "limits";

export type LanguageRequestError = {
  readonly code: "malformed-request";
  readonly field: LanguageRequestField;
};

export type NormalizedLanguageSymbolReadRequest = {
  readonly path: string;
  readonly symbol: string;
  readonly related: readonly LanguageEvidenceKind[];
  readonly expectedGeneration: string | undefined;
  readonly limits: LanguageReadLimits;
};

export type NormalizedLanguageChangedRegionsReadRequest = {
  readonly comparison: LanguageComparison;
  readonly paths: readonly string[];
  readonly expectedGeneration: string | undefined;
  readonly limits: LanguageReadLimits;
};

const languageSymbolReadRequestSchema = z
  .object({
    path: pathTextSchema,
    symbol: symbolNameSchema,
    related: z.array(z.enum(LANGUAGE_EVIDENCE_KINDS)).max(MAX_LANGUAGE_BACKEND_ARRAY).optional(),
    expectedGeneration: generationSchema.optional(),
    limits: languageLimitsInputSchema.optional(),
  })
  .strict();

const languageChangedRegionsReadRequestSchema = z
  .object({
    comparison: languageComparisonSchema.optional(),
    paths: z.array(pathTextSchema).max(MAX_LANGUAGE_BACKEND_ARRAY).optional(),
    expectedGeneration: generationSchema.optional(),
    limits: languageLimitsInputSchema.optional(),
  })
  .strict();

function requestFieldFromIssue(path: readonly PropertyKey[]): LanguageRequestField {
  const field = path[0];
  return field === "path" ||
    field === "symbol" ||
    field === "related" ||
    field === "comparison" ||
    field === "paths" ||
    field === "expectedGeneration" ||
    field === "limits"
    ? field === "expectedGeneration"
      ? "generation"
      : field
    : "request";
}

function requestError(path: readonly PropertyKey[]): LanguageRequestError {
  return { code: "malformed-request", field: requestFieldFromIssue(path) };
}

export type LanguageReadError =
  | WorkspacePathBindError
  | LanguageRequestError
  | LanguageLimitError
  | {
      readonly code: "capped";
      readonly limit: LanguageLimitName;
      readonly requested: number;
      readonly maximum: number;
    }
  | {
      readonly code: "malformed-backend";
      readonly field: "symbol" | "changed-regions" | "path" | "range" | "provenance";
    }
  | { readonly code: "not-found"; readonly target: "symbol" | "changed-regions" }
  | { readonly code: "unsupported"; readonly capability: LanguageCapability }
  | {
      readonly code: "unavailable";
      readonly capability: LanguageCapability;
      readonly retryable: boolean;
    }
  | {
      readonly code: "stale";
      readonly expectedGeneration: string | undefined;
      readonly actualGeneration: string | undefined;
    }
  | { readonly code: "denied"; readonly capability: LanguageCapability }
  | { readonly code: "timed-out"; readonly capability: LanguageCapability }
  | { readonly code: "cancelled" }
  | { readonly code: "source"; readonly reason: LanguageSourceReason };

export type LanguageSourceReason =
  | "symlink-escape"
  | "not-found"
  | "not-a-file"
  | "oversized"
  | "binary"
  | "malformed-encoding"
  | "malformed-range"
  | "filesystem";

export function parseLanguageSymbolReadRequest(
  value: unknown,
): Result<NormalizedLanguageSymbolReadRequest, LanguageReadError> {
  const parsed = languageSymbolReadRequestSchema.safeParse(value);
  if (!parsed.success) {
    return err(requestError(parsed.error.issues[0]?.path ?? []));
  }
  const limits = languageReadLimits(parsed.data.limits);
  if (!limits.ok) {
    return limits;
  }
  if (
    parsed.data.related !== undefined &&
    parsed.data.related.length > limits.value.maxRelatedEvidence
  ) {
    return err({
      code: "capped",
      limit: "maxRelatedEvidence",
      requested: parsed.data.related.length,
      maximum: limits.value.maxRelatedEvidence,
    });
  }
  return ok({
    path: parsed.data.path,
    symbol: parsed.data.symbol,
    related: parsed.data.related ?? [],
    expectedGeneration: parsed.data.expectedGeneration,
    limits: limits.value,
  });
}

export function parseLanguageChangedRegionsReadRequest(
  value: unknown,
): Result<NormalizedLanguageChangedRegionsReadRequest, LanguageReadError> {
  const parsed = languageChangedRegionsReadRequestSchema.safeParse(value);
  if (!parsed.success) {
    return err(requestError(parsed.error.issues[0]?.path ?? []));
  }
  const limits = languageReadLimits(parsed.data.limits);
  if (!limits.ok) {
    return limits;
  }
  if (parsed.data.paths !== undefined && parsed.data.paths.length > limits.value.maxPaths) {
    return err({
      code: "capped",
      limit: "maxPaths",
      requested: parsed.data.paths.length,
      maximum: limits.value.maxPaths,
    });
  }
  return ok({
    comparison: parsed.data.comparison ?? { kind: "working-tree" },
    paths: parsed.data.paths ?? [],
    expectedGeneration: parsed.data.expectedGeneration,
    limits: limits.value,
  });
}

export type LanguageBackendSymbolRequest = {
  readonly root: LocalPath;
  readonly path: string;
  readonly symbol: string;
  readonly related: readonly LanguageEvidenceKind[];
  readonly expectedGeneration: string | undefined;
  readonly limits: LanguageReadLimits;
  readonly signal: AbortSignal | undefined;
};

export type LanguageBackendChangedRegionsRequest = {
  readonly root: LocalPath;
  readonly comparison: LanguageComparison;
  readonly paths: readonly string[];
  readonly expectedGeneration: string | undefined;
  readonly limits: LanguageReadLimits;
  readonly signal: AbortSignal | undefined;
};

export type LanguageBackendPort = {
  readonly readSymbol: (
    request: LanguageBackendSymbolRequest,
  ) => Promise<LanguageBackendSymbolOutcome>;
  readonly readChangedRegions: (
    request: LanguageBackendChangedRegionsRequest,
  ) => Promise<LanguageBackendChangedRegionsOutcome>;
};

export type LanguageDocumentIdentity = {
  readonly path: BoundWorkspacePath;
  readonly version: number | null;
  readonly generation: string;
};

export type LanguageLocation = {
  readonly path: BoundWorkspacePath;
  readonly range: LanguageRange;
};

export type LanguageSourceExcerpt = {
  readonly bound: BoundWorkspacePath;
  readonly range: LanguageRange;
  readonly text: string;
  readonly byteLength: number;
  readonly newline: NewlineStyle;
  readonly exact: true;
};

export type LanguageSymbol = {
  readonly name: string;
  readonly kind: LanguageSymbolKind;
  readonly range: LanguageRange;
  readonly declarationRange: LanguageRange | null;
  readonly selectionRange: LanguageRange | null;
  readonly containerName: string | null;
};

export type LanguageSymbolReference = {
  readonly name: string;
  readonly kind: LanguageSymbolKind;
  readonly range: LanguageRange;
};

export type LanguageRelatedEvidence = {
  readonly kind: LanguageEvidenceKind;
  readonly label: string;
  readonly location: LanguageLocation;
};

export type LanguageSymbolRead = {
  readonly capability: "read_symbol";
  readonly status: "complete" | "partial";
  readonly document: LanguageDocumentIdentity;
  readonly symbol: LanguageSymbol;
  readonly source: LanguageSourceExcerpt;
  readonly related: readonly LanguageRelatedEvidence[];
  readonly provenance: LanguageEvidence;
  readonly omissions: readonly LanguageOmission[];
};

export type LanguageDiagnostic = {
  readonly severity: LanguageDiagnosticSeverity;
  readonly code: string | null;
  readonly message: string;
  readonly location: LanguageLocation | null;
};

export type LanguageChangedRegion = {
  readonly path: BoundWorkspacePath;
  readonly range: LanguageRange;
  readonly change: LanguageChangeKind;
  readonly symbol: LanguageSymbolReference | null;
  readonly diagnostics: readonly LanguageDiagnostic[];
  readonly dependencies: readonly LanguageLocation[];
  readonly source: LanguageSourceExcerpt | null;
};

export type LanguageChangedRegionsRead = {
  readonly capability: "read_changed_regions";
  readonly status: "complete" | "partial" | "empty";
  readonly comparison: LanguageComparison;
  readonly regions: readonly LanguageChangedRegion[];
  readonly provenance: LanguageEvidence;
  readonly omissions: readonly LanguageOmission[];
};

function isConfidenceValid(provenance: z.infer<typeof provenanceSchema>): boolean {
  if (provenance.backend === "lexical") {
    return provenance.confidence === "lexical" && provenance.fallback;
  }
  if (provenance.fallback && provenance.confidence === "semantic") {
    return false;
  }
  if (provenance.backend === "syntax") {
    return provenance.confidence === "structural";
  }
  return true;
}

function isPayloadValid(
  payload: LanguageBackendSymbolPayload | LanguageBackendChangedPayload,
): boolean {
  return isConfidenceValid(payload.provenance);
}

export function normalizeLanguageBackendSymbolOutcome(
  value: unknown,
): Result<LanguageBackendSymbolOutcome, LanguageReadError> {
  const parsed = languageSymbolOutcomeSchema.safeParse(value);
  if (!parsed.success) {
    return err({ code: "malformed-backend", field: "symbol" });
  }
  if (
    (parsed.data.status === "found" || parsed.data.status === "partial") &&
    (!isPayloadValid(parsed.data.value) ||
      !isLanguageRange(parsed.data.value.symbol.range) ||
      (parsed.data.value.symbol.declarationRange !== undefined &&
        parsed.data.value.symbol.declarationRange !== null &&
        !isLanguageRange(parsed.data.value.symbol.declarationRange)) ||
      (parsed.data.value.symbol.selectionRange !== undefined &&
        parsed.data.value.symbol.selectionRange !== null &&
        !isLanguageRange(parsed.data.value.symbol.selectionRange)) ||
      parsed.data.value.related.some((evidence) => !isLanguageRange(evidence.location.range)))
  ) {
    return err({
      code: "malformed-backend",
      field: isConfidenceValid(parsed.data.value.provenance) ? "range" : "provenance",
    });
  }
  return ok(parsed.data);
}

export function normalizeLanguageBackendChangedRegionsOutcome(
  value: unknown,
): Result<LanguageBackendChangedRegionsOutcome, LanguageReadError> {
  const parsed = changedRegionsOutcomeSchema.safeParse(value);
  if (!parsed.success) {
    return err({ code: "malformed-backend", field: "changed-regions" });
  }
  if (parsed.data.status === "found" || parsed.data.status === "partial") {
    if (!isPayloadValid(parsed.data.value)) {
      return err({ code: "malformed-backend", field: "provenance" });
    }
    for (const region of parsed.data.value.regions) {
      if (
        !isLanguageRange(region.range) ||
        (region.symbol !== null && !isLanguageRange(region.symbol.range))
      ) {
        return err({ code: "malformed-backend", field: "range" });
      }
      for (const diagnostic of region.diagnostics) {
        if (diagnostic.location !== null && !isLanguageRange(diagnostic.location.range)) {
          return err({ code: "malformed-backend", field: "range" });
        }
      }
      for (const dependency of region.dependencies) {
        if (!isLanguageRange(dependency.range)) {
          return err({ code: "malformed-backend", field: "range" });
        }
      }
    }
  }
  return ok(parsed.data);
}

function sourceReason(error: string): LanguageSourceReason {
  switch (error) {
    case "symlink-escape":
    case "not-found":
    case "not-a-file":
    case "oversized":
    case "binary":
    case "malformed-encoding":
    case "malformed-range":
    case "filesystem":
      return error;
    default:
      return "filesystem";
  }
}

export function languageSourceError(reason: string): LanguageReadError {
  return { code: "source", reason: sourceReason(reason) };
}

export function describeLanguageReadError(error: LanguageReadError): string {
  switch (error.code) {
    case "malformed":
      return `malformed:${error.reason}`;
    case "escaped":
      return "escaped";
    case "absolute-unscoped":
      return "absolute-unscoped";
    case "malformed-request":
      return `malformed-request:${error.field}`;
    case "malformed-limits":
      return `malformed-limits:${error.field}`;
    case "limit-too-large":
      return `limit-too-large:${error.field}:${error.maximum}`;
    case "capped":
      return `capped:${error.limit}:${error.requested}:${error.maximum}`;
    case "malformed-backend":
      return `malformed-backend:${error.field}`;
    case "not-found":
      return `not-found:${error.target}`;
    case "unsupported":
      return `unsupported:${error.capability}`;
    case "unavailable":
      return `unavailable:${error.capability}:${error.retryable ? "retryable" : "terminal"}`;
    case "stale":
      return `stale:${error.expectedGeneration ?? "unknown"}:${error.actualGeneration ?? "unknown"}`;
    case "denied":
      return `denied:${error.capability}`;
    case "timed-out":
      return `timed-out:${error.capability}`;
    case "cancelled":
      return "cancelled";
    case "source":
      return `source:${error.reason}`;
    default:
      return assertNever(error, "unhandled language read error");
  }
}
