/**
 * Context-engine evidence candidates, provenance, freshness, and exact-source
 * handles (#82).
 *
 * Admission is a pure gate: it classifies and bounds a candidate without
 * ranking, budgeting, pack composition, or provider rendering. Retrieval packs
 * from #65 remain planner inputs; they are not this type. Exact-source
 * fidelity requires a digest handle. An expansion handle never upgrades a
 * lossy or extractive projection to exact source.
 */

import {
  ARTIFACT_SENSITIVITIES,
  type ArtifactId,
  type ArtifactSensitivity,
  artifactId,
  type ContentDigest,
  contentDigest,
} from "./artifact.ts";
import {
  type EvidenceId,
  evidenceId,
  type ScopeId,
  scopeId,
  type WorkspaceId,
  workspaceId,
} from "./identity.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const MAX_EVIDENCE_INLINE_BYTES = 64 * 1_024;
export const MAX_EVIDENCE_ESTIMATED_TOKENS = 32_768;
export const MAX_EVIDENCE_ORIGIN_LENGTH = 512;
export const MAX_EVIDENCE_LINEAGE_STEPS = 8;
export const MAX_EVIDENCE_LINEAGE_STEP_LENGTH = 64;
export const MAX_EVIDENCE_RELATIONSHIPS = 16;
export const MAX_EVIDENCE_RETRIEVAL_COST = 1_000_000;
export const MAX_EVIDENCE_BATCH = 64;

export const EVIDENCE_SOURCE_KINDS = [
  "instruction",
  "conversation",
  "file",
  "symbol",
  "diagnostic",
  "search",
  "tool",
  "memory",
  "artifact",
  "plan",
  "attachment",
  "process",
] as const;
export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];

export const EVIDENCE_FRESHNESSES = ["live", "snapshot", "indexed", "stale"] as const;
export type EvidenceFreshness = (typeof EVIDENCE_FRESHNESSES)[number];

export const EVIDENCE_FIDELITIES = [
  "exact-source",
  "bounded-excerpt",
  "deterministic-transform",
  "extractive-summary",
  "lossy-synthesis",
] as const;
export type EvidenceFidelity = (typeof EVIDENCE_FIDELITIES)[number];

export const EVIDENCE_TRUSTS = [
  "user-confirmed",
  "adapter-declared",
  "inferred",
  "untrusted",
] as const;
export type EvidenceTrust = (typeof EVIDENCE_TRUSTS)[number];

export type EvidenceAdmissionErrorCode =
  | "malformed"
  | "unsupported"
  | "oversized"
  | "secret"
  | "wrong-workspace"
  | "exact-source-missing"
  | "fidelity-upgrade";

export type EvidenceAdmissionError = {
  readonly kind: "evidence-admission";
  readonly code: EvidenceAdmissionErrorCode;
  readonly field: string | null;
};

export type ExactSourceHandle =
  | {
      readonly kind: "inline";
      readonly digest: ContentDigest;
      readonly byteLength: number;
    }
  | {
      readonly kind: "artifact";
      readonly artifactId: ArtifactId;
      readonly digest: ContentDigest;
      readonly byteLength: number;
    };

export type EvidenceExpansionHandle = ExactSourceHandle;

export type EvidencePayload =
  | {
      readonly kind: "inline";
      readonly text: string;
      readonly byteLength: number;
    }
  | {
      readonly kind: "artifact";
      readonly artifactId: ArtifactId;
      readonly digest: ContentDigest;
      readonly byteLength: number;
    };

export type EvidenceCandidate = {
  readonly id: EvidenceId;
  readonly sourceKind: EvidenceSourceKind;
  readonly origin: string;
  readonly workspaceId: WorkspaceId | null;
  readonly scopeId: ScopeId | null;
  readonly payload: EvidencePayload;
  readonly estimatedTokens: number;
  readonly freshness: EvidenceFreshness;
  readonly sensitivity: ArtifactSensitivity;
  readonly trust: EvidenceTrust;
  readonly fidelity: EvidenceFidelity;
  readonly lineage: readonly string[];
  readonly relationships: readonly EvidenceId[];
  readonly retrievalCost: number;
  readonly exactSource: ExactSourceHandle | null;
  readonly expansion: EvidenceExpansionHandle | null;
};

export type ExactSourceHandleInput =
  | {
      readonly kind: "inline";
      readonly digest: string;
      readonly byteLength: number;
    }
  | {
      readonly kind: "artifact";
      readonly artifactId: string;
      readonly digest: string;
      readonly byteLength: number;
    };

export type EvidencePayloadInput =
  | { readonly kind: "inline"; readonly text: string }
  | {
      readonly kind: "artifact";
      readonly artifactId: string;
      readonly digest: string;
      readonly byteLength: number;
    };

export type EvidenceCandidateInput = {
  readonly id: string;
  readonly sourceKind: string;
  readonly origin: string;
  readonly workspaceId?: string | null;
  readonly scopeId?: string | null;
  readonly payload: EvidencePayloadInput;
  readonly estimatedTokens: number;
  readonly freshness: string;
  readonly sensitivity: string;
  readonly trust: string;
  readonly fidelity: string;
  readonly lineage?: readonly string[];
  readonly relationships?: readonly string[];
  readonly retrievalCost?: number;
  readonly exactSource?: ExactSourceHandleInput | null;
  readonly expansion?: ExactSourceHandleInput | null;
};

export type AdmitEvidenceOptions = {
  readonly expectedWorkspaceId?: WorkspaceId;
};

const encoder = new TextEncoder();

function admissionError(
  code: EvidenceAdmissionErrorCode,
  field: string | null,
): EvidenceAdmissionError {
  return { kind: "evidence-admission", code, field };
}

function parseClosedUnion<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  unsupported = false,
): Result<T, EvidenceAdmissionError> {
  if (typeof value !== "string") {
    return err(admissionError("malformed", field));
  }
  if ((allowed as readonly string[]).includes(value)) {
    return ok(value as T);
  }
  return err(admissionError(unsupported ? "unsupported" : "malformed", field));
}

function parseByteLength(value: unknown, field: string): Result<number, EvidenceAdmissionError> {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return err(admissionError("malformed", field));
  }
  if (value > MAX_EVIDENCE_INLINE_BYTES) {
    return err(admissionError("oversized", field));
  }
  return ok(value);
}

function parseHandle(
  value: ExactSourceHandleInput,
  field: string,
): Result<ExactSourceHandle, EvidenceAdmissionError> {
  if (value.kind === "inline") {
    const digest = contentDigest.parse(value.digest);
    if (!digest.ok) {
      return err(admissionError("malformed", `${field}.digest`));
    }
    const byteLength = parseByteLength(value.byteLength, `${field}.byteLength`);
    if (!byteLength.ok) {
      return byteLength;
    }
    return ok({ kind: "inline", digest: digest.value, byteLength: byteLength.value });
  }
  if (value.kind === "artifact") {
    const id = artifactId.parse(value.artifactId);
    if (!id.ok) {
      return err(admissionError("malformed", `${field}.artifactId`));
    }
    const digest = contentDigest.parse(value.digest);
    if (!digest.ok) {
      return err(admissionError("malformed", `${field}.digest`));
    }
    const byteLength = parseByteLength(value.byteLength, `${field}.byteLength`);
    if (!byteLength.ok) {
      return byteLength;
    }
    return ok({
      kind: "artifact",
      artifactId: id.value,
      digest: digest.value,
      byteLength: byteLength.value,
    });
  }
  return assertNever(value, "unhandled exact-source handle kind");
}

function parseOptionalHandle(
  value: ExactSourceHandleInput | null | undefined,
  field: string,
): Result<ExactSourceHandle | null, EvidenceAdmissionError> {
  if (value === undefined || value === null) {
    return ok(null);
  }
  return parseHandle(value, field);
}

function parsePayload(
  value: EvidencePayloadInput,
): Result<EvidencePayload, EvidenceAdmissionError> {
  if (value.kind === "inline") {
    if (typeof value.text !== "string" || value.text.length === 0) {
      return err(admissionError("malformed", "payload"));
    }
    const byteLength = encoder.encode(value.text).byteLength;
    if (byteLength > MAX_EVIDENCE_INLINE_BYTES) {
      return err(admissionError("oversized", "payload"));
    }
    return ok({ kind: "inline", text: value.text, byteLength });
  }
  if (value.kind === "artifact") {
    const id = artifactId.parse(value.artifactId);
    if (!id.ok) {
      return err(admissionError("malformed", "payload.artifactId"));
    }
    const digest = contentDigest.parse(value.digest);
    if (!digest.ok) {
      return err(admissionError("malformed", "payload.digest"));
    }
    const byteLength = parseByteLength(value.byteLength, "payload.byteLength");
    if (!byteLength.ok) {
      return byteLength;
    }
    return ok({
      kind: "artifact",
      artifactId: id.value,
      digest: digest.value,
      byteLength: byteLength.value,
    });
  }
  return assertNever(value, "unhandled evidence payload kind");
}

function parseLineage(
  value: readonly string[] | undefined,
): Result<readonly string[], EvidenceAdmissionError> {
  if (value === undefined) {
    return ok([]);
  }
  if (value.length > MAX_EVIDENCE_LINEAGE_STEPS) {
    return err(admissionError("oversized", "lineage"));
  }
  for (const step of value) {
    if (
      typeof step !== "string" ||
      step.length === 0 ||
      step.length > MAX_EVIDENCE_LINEAGE_STEP_LENGTH
    ) {
      return err(admissionError("malformed", "lineage"));
    }
  }
  return ok(value);
}

function parseRelationships(
  value: readonly string[] | undefined,
): Result<readonly EvidenceId[], EvidenceAdmissionError> {
  if (value === undefined) {
    return ok([]);
  }
  if (value.length > MAX_EVIDENCE_RELATIONSHIPS) {
    return err(admissionError("oversized", "relationships"));
  }
  const ids: EvidenceId[] = [];
  for (const raw of value) {
    const parsed = evidenceId.parse(raw);
    if (!parsed.ok) {
      return err(admissionError("malformed", "relationships"));
    }
    ids.push(parsed.value);
  }
  return ok(ids);
}

function payloadMatchesHandle(payload: EvidencePayload, handle: ExactSourceHandle): boolean {
  if (payload.kind === "inline") {
    return handle.kind === "inline" && payload.byteLength === handle.byteLength;
  }
  return (
    handle.kind === "artifact" &&
    payload.artifactId === handle.artifactId &&
    payload.digest === handle.digest &&
    payload.byteLength === handle.byteLength
  );
}

export function claimsExactSource(candidate: EvidenceCandidate): boolean {
  return candidate.fidelity === "exact-source" && candidate.exactSource !== null;
}

export function describeEvidenceAdmissionError(error: EvidenceAdmissionError): string {
  const field = error.field === null ? "evidence" : error.field;
  switch (error.code) {
    case "malformed":
      return `malformed ${field}`;
    case "unsupported":
      return `unsupported ${field}`;
    case "oversized":
      return `oversized ${field}`;
    case "secret":
      return "secret evidence";
    case "wrong-workspace":
      return "wrong workspace";
    case "exact-source-missing":
      return "exact-source handle required";
    case "fidelity-upgrade":
      return "fidelity upgrade refused";
    default:
      return assertNever(error.code, "unhandled evidence admission error");
  }
}

export function admitEvidenceCandidate(
  input: EvidenceCandidateInput,
  options: AdmitEvidenceOptions = {},
): Result<EvidenceCandidate, EvidenceAdmissionError> {
  const id = evidenceId.parse(input.id);
  if (!id.ok) {
    return err(admissionError("malformed", "id"));
  }

  const sourceKind = parseClosedUnion(input.sourceKind, EVIDENCE_SOURCE_KINDS, "sourceKind", true);
  if (!sourceKind.ok) {
    return sourceKind;
  }

  if (typeof input.origin !== "string" || input.origin.length === 0) {
    return err(admissionError("malformed", "origin"));
  }
  if (input.origin.length > MAX_EVIDENCE_ORIGIN_LENGTH) {
    return err(admissionError("oversized", "origin"));
  }

  let parsedWorkspace: WorkspaceId | null = null;
  if (input.workspaceId !== undefined && input.workspaceId !== null) {
    const parsed = workspaceId.parse(input.workspaceId);
    if (!parsed.ok) {
      return err(admissionError("malformed", "workspaceId"));
    }
    parsedWorkspace = parsed.value;
  }

  if (options.expectedWorkspaceId !== undefined) {
    if (parsedWorkspace !== options.expectedWorkspaceId) {
      return err(admissionError("wrong-workspace", "workspaceId"));
    }
  }

  let parsedScope: ScopeId | null = null;
  if (input.scopeId !== undefined && input.scopeId !== null) {
    const parsed = scopeId.parse(input.scopeId);
    if (!parsed.ok) {
      return err(admissionError("malformed", "scopeId"));
    }
    parsedScope = parsed.value;
  }

  const payload = parsePayload(input.payload);
  if (!payload.ok) {
    return payload;
  }

  if (
    typeof input.estimatedTokens !== "number" ||
    !Number.isSafeInteger(input.estimatedTokens) ||
    input.estimatedTokens < 0
  ) {
    return err(admissionError("malformed", "estimatedTokens"));
  }
  if (input.estimatedTokens > MAX_EVIDENCE_ESTIMATED_TOKENS) {
    return err(admissionError("oversized", "estimatedTokens"));
  }

  const freshness = parseClosedUnion(input.freshness, EVIDENCE_FRESHNESSES, "freshness", true);
  if (!freshness.ok) {
    return freshness;
  }

  const sensitivity = parseClosedUnion(input.sensitivity, ARTIFACT_SENSITIVITIES, "sensitivity");
  if (!sensitivity.ok) {
    return sensitivity;
  }
  if (sensitivity.value === "restricted") {
    return err(admissionError("secret", "sensitivity"));
  }

  const trust = parseClosedUnion(input.trust, EVIDENCE_TRUSTS, "trust", true);
  if (!trust.ok) {
    return trust;
  }

  const fidelity = parseClosedUnion(input.fidelity, EVIDENCE_FIDELITIES, "fidelity", true);
  if (!fidelity.ok) {
    return fidelity;
  }

  const lineage = parseLineage(input.lineage);
  if (!lineage.ok) {
    return lineage;
  }

  const relationships = parseRelationships(input.relationships);
  if (!relationships.ok) {
    return relationships;
  }

  const retrievalCost = input.retrievalCost ?? 0;
  if (
    typeof retrievalCost !== "number" ||
    !Number.isSafeInteger(retrievalCost) ||
    retrievalCost < 0
  ) {
    return err(admissionError("malformed", "retrievalCost"));
  }
  if (retrievalCost > MAX_EVIDENCE_RETRIEVAL_COST) {
    return err(admissionError("oversized", "retrievalCost"));
  }

  const exactSource = parseOptionalHandle(input.exactSource, "exactSource");
  if (!exactSource.ok) {
    return exactSource;
  }
  const expansion = parseOptionalHandle(input.expansion, "expansion");
  if (!expansion.ok) {
    return expansion;
  }

  if (fidelity.value === "exact-source") {
    if (exactSource.value === null) {
      return err(admissionError("exact-source-missing", "exactSource"));
    }
    if (lineage.value.length > 0) {
      return err(admissionError("fidelity-upgrade", "fidelity"));
    }
    if (!payloadMatchesHandle(payload.value, exactSource.value)) {
      return err(admissionError("malformed", "exactSource"));
    }
  } else if (exactSource.value !== null) {
    return err(admissionError("fidelity-upgrade", "exactSource"));
  }

  const candidate: EvidenceCandidate = {
    id: id.value,
    sourceKind: sourceKind.value,
    origin: input.origin,
    workspaceId: parsedWorkspace,
    scopeId: parsedScope,
    payload: payload.value,
    estimatedTokens: input.estimatedTokens,
    freshness: freshness.value,
    sensitivity: sensitivity.value,
    trust: trust.value,
    fidelity: fidelity.value,
    lineage: lineage.value,
    relationships: relationships.value,
    retrievalCost,
    exactSource: exactSource.value,
    expansion: expansion.value,
  };

  return ok(candidate);
}

export function admitEvidenceCandidates(
  inputs: readonly EvidenceCandidateInput[],
  options: AdmitEvidenceOptions = {},
): Result<readonly EvidenceCandidate[], EvidenceAdmissionError> {
  if (inputs.length > MAX_EVIDENCE_BATCH) {
    return err(admissionError("oversized", "batch"));
  }
  const admitted: EvidenceCandidate[] = [];
  for (const input of inputs) {
    const result = admitEvidenceCandidate(input, options);
    if (!result.ok) {
      return result;
    }
    admitted.push(result.value);
  }
  return ok(admitted);
}
