/**
 * Context-governed memory admission and sensitivity rules (#110).
 *
 * A defined record is not yet durable truth. Admission checks source trust,
 * destination sensitivity, workspace identity, and whether consolidation would
 * broaden a sensitive fact. Repository and web sources cannot write memory
 * directly. Recall, correction operations, and product tools remain later.
 */

import { z } from "zod";

import type { ArtifactSensitivity } from "./artifact.ts";
import { EVIDENCE_TRUSTS, type EvidenceTrust } from "./context-evidence.ts";
import { type WorkspaceId, workspaceId } from "./identity.ts";
import {
  defineMemoryRecord,
  MEMORY_RECORD_VERSION,
  type MemoryError,
  type MemoryKind,
  type MemoryRecord,
  type MemoryRecordInput,
  type MemoryScope,
  memoryScopeWorkspaceId,
} from "./memory-record.ts";
import { assertNever, err, ok, type Result } from "./result.ts";

export const MEMORY_ADMISSION_VERSION = "memory-admit.v1";

export const MEMORY_SOURCE_KINDS = ["user", "tool", "reflection", "repository", "web"] as const;
export type MemorySourceKind = (typeof MEMORY_SOURCE_KINDS)[number];

export type MemoryAdmissionContextInput = {
  readonly sourceKind?: unknown;
  readonly sourceTrust?: unknown;
  readonly workspaceId?: unknown;
  readonly priors?: unknown;
  readonly cancelled?: unknown;
};

export type MemoryAdmissionResult = {
  readonly strategyVersion: typeof MEMORY_ADMISSION_VERSION;
  readonly record: MemoryRecord;
  readonly sourceKind: MemorySourceKind;
  readonly sourceTrust: EvidenceTrust;
};

const sourceKindSchema = z.enum(MEMORY_SOURCE_KINDS);
const sourceTrustSchema = z.enum(EVIDENCE_TRUSTS);

const PROJECT_LOCAL_KINDS: readonly MemoryKind[] = [
  "project-fact",
  "workflow-convention",
  "recurring-task-context",
  "reusable-technical-knowledge",
];

function memoryError(code: MemoryError["code"], field: string | null): MemoryError {
  return { kind: "memory", code, field };
}

function scopeBreadth(scope: MemoryScope): number {
  switch (scope.kind) {
    case "user":
      return 4;
    case "provider":
    case "collection":
      return 3;
    case "workspace":
      return 2;
    case "repository":
    case "branch":
    case "worktree":
    case "agent":
      return 1;
    default:
      return assertNever(scope, "unhandled memory scope breadth");
  }
}

function isBroadScope(scope: MemoryScope): boolean {
  return scope.kind === "user" || scope.kind === "provider" || scope.kind === "collection";
}

function allowsSensitivity(scope: MemoryScope, sensitivity: ArtifactSensitivity): boolean {
  switch (sensitivity) {
    case "public":
      return true;
    case "user-content":
      return scope.kind !== "user";
    case "sensitive":
      return !isBroadScope(scope);
    case "restricted":
      return false;
    default:
      return assertNever(sensitivity, "unhandled memory sensitivity");
  }
}

function isMemoryRecord(value: object): value is MemoryRecord {
  return (
    "schemaVersion" in value &&
    value.schemaVersion === MEMORY_RECORD_VERSION &&
    "memoryId" in value &&
    "scope" in value &&
    "sensitivity" in value &&
    "kind" in value
  );
}

function parsePriors(value: unknown): Result<readonly MemoryRecord[], MemoryError> {
  if (value === undefined) {
    return ok([]);
  }
  if (!Array.isArray(value)) {
    return err(memoryError("malformed", "priors"));
  }
  const priors: MemoryRecord[] = [];
  for (const [index, entry] of value.entries()) {
    if (entry === null || typeof entry !== "object") {
      return err(memoryError("malformed", `priors.${index}`));
    }
    if (isMemoryRecord(entry)) {
      priors.push(entry);
      continue;
    }
    const parsed = defineMemoryRecord(entry as MemoryRecordInput);
    if (!parsed.ok) {
      return err(memoryError(parsed.error.code, `priors.${index}`));
    }
    priors.push(parsed.value);
  }
  return ok(priors);
}

function parseWorkspace(value: unknown): Result<WorkspaceId, MemoryError> {
  const parsed = workspaceId.parse(value);
  if (!parsed.ok) {
    return err(memoryError("malformed", "workspaceId"));
  }
  return ok(parsed.value);
}

function sourceMayWrite(sourceKind: MemorySourceKind, sourceTrust: EvidenceTrust): boolean {
  if (sourceKind === "repository" || sourceKind === "web") {
    return false;
  }
  if (sourceTrust === "inferred" || sourceTrust === "untrusted") {
    return false;
  }
  if (sourceKind === "tool" || sourceKind === "reflection") {
    return sourceTrust === "user-confirmed";
  }
  return sourceTrust === "user-confirmed" || sourceTrust === "adapter-declared";
}

/**
 * Applies context-governed admission after a record has a valid shape.
 *
 * Untrusted repository or web sources never write. Restricted content is
 * refused. Sensitive facts cannot broaden onto user-wide or unnamed scopes.
 * Project-local kinds stay inside the admitting workspace.
 */
export function admitMemoryCandidate(
  recordInput: MemoryRecordInput,
  context: MemoryAdmissionContextInput,
): Result<MemoryAdmissionResult, MemoryError> {
  if (context.cancelled === true) {
    return err(memoryError("cancelled", "signal"));
  }
  const sourceKindParsed = sourceKindSchema.safeParse(context.sourceKind);
  if (!sourceKindParsed.success) {
    return err(memoryError("malformed", "sourceKind"));
  }
  const sourceTrustParsed = sourceTrustSchema.safeParse(context.sourceTrust);
  if (!sourceTrustParsed.success) {
    return err(memoryError("malformed", "sourceTrust"));
  }
  const expectedWorkspace = parseWorkspace(context.workspaceId);
  if (!expectedWorkspace.ok) {
    return expectedWorkspace;
  }
  const priors = parsePriors(context.priors);
  if (!priors.ok) {
    return priors;
  }
  if (!sourceMayWrite(sourceKindParsed.data, sourceTrustParsed.data)) {
    const field =
      sourceKindParsed.data === "repository" || sourceKindParsed.data === "web"
        ? "sourceKind"
        : "sourceTrust";
    return err(memoryError("denied", field));
  }
  const defined = defineMemoryRecord(recordInput);
  if (!defined.ok) {
    return defined;
  }
  const record = defined.value;
  if (record.sensitivity === "restricted") {
    return err(memoryError("secret", "sensitivity"));
  }
  if (!allowsSensitivity(record.scope, record.sensitivity)) {
    return err(memoryError("denied", "sensitivity"));
  }
  if (
    record.scope.kind === "user" &&
    (sourceKindParsed.data !== "user" || sourceTrustParsed.data !== "user-confirmed")
  ) {
    return err(memoryError("denied", "scope"));
  }
  if (PROJECT_LOCAL_KINDS.includes(record.kind) && isBroadScope(record.scope)) {
    return err(memoryError("denied", "kind"));
  }
  const recordWorkspace = memoryScopeWorkspaceId(record.scope);
  if (recordWorkspace !== null && recordWorkspace !== expectedWorkspace.value) {
    return err(memoryError("denied", "scope.workspaceId"));
  }
  for (const [index, prior] of priors.value.entries()) {
    const priorWorkspace = memoryScopeWorkspaceId(prior.scope);
    if (priorWorkspace !== null && priorWorkspace !== expectedWorkspace.value) {
      return err(memoryError("denied", `priors.${index}.scope.workspaceId`));
    }
    const sensitive = prior.sensitivity === "sensitive" || prior.sensitivity === "restricted";
    if (sensitive && scopeBreadth(record.scope) > scopeBreadth(prior.scope)) {
      return err(memoryError("denied", "scope"));
    }
  }
  return ok({
    strategyVersion: MEMORY_ADMISSION_VERSION,
    record,
    sourceKind: sourceKindParsed.data,
    sourceTrust: sourceTrustParsed.data,
  });
}
