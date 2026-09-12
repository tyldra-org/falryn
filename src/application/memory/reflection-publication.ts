import type {
  ReflectionAuthority,
  ReflectionCommand,
  ReflectionRecord,
  ReflectionTransaction,
} from "../../domain/memory/reflection.ts";
import { REFLECTION_LIMITS, refuseReflection } from "../../domain/memory/reflection.ts";
import {
  rangeContains,
  rangesOverlap,
  reflectionBytes,
  reflectionDigest,
  reflectionProgress,
  reflectionPublicationDigest,
  reflectionPublicationState,
  validReflectionPrepared,
} from "../../domain/memory/reflection-state.ts";
import { containsRedactableSecret } from "../diagnostics/redaction.ts";

export function reflectionHasSecret(value: unknown): boolean {
  if (typeof value === "string") return containsRedactableSecret(value);
  if (Array.isArray(value)) return value.some(reflectionHasSecret);
  return (
    value !== null && typeof value === "object" && Object.values(value).some(reflectionHasSecret)
  );
}
export function validateReflectionEvidence(
  record: ReflectionRecord,
  tx: ReflectionTransaction,
  authority: ReflectionAuthority,
): boolean {
  return (
    record.sources.every((s) => authority.sourceAllowed(s)) &&
    record.candidates.every(
      (candidate) =>
        candidate.sensitivity !== "restricted" &&
        authority.candidateAllowed(candidate) &&
        candidate.artifacts.every(
          (artifact) =>
            tx.artifact(artifact.artifactId, artifact.digest) &&
            authority.artifactAllowed(artifact),
        ),
    ) &&
    record.publications.every((p) => p.prepared === null || authority.preparedAllowed(p.prepared))
  );
}
/** Publication does not evaluate candidate truth or make a canonical memory record. */
export function publishReflection(
  record: ReflectionRecord,
  command: Extract<ReflectionCommand, { action: "publish" }>,
  tx: ReflectionTransaction,
  authority: ReflectionAuthority,
): ReflectionRecord {
  if (
    !rangeContains(record.range, command.range) ||
    record.publications.some((p) => rangesOverlap(p.range, command.range))
  )
    refuseReflection("source-overlap");
  if (record.publications.length >= REFLECTION_LIMITS.publications)
    refuseReflection("resource-exhausted");
  if (command.disposition !== "processed" && command.candidates.length > 0)
    refuseReflection("malformed");
  const selected = new Set(
    record.sources
      .filter((s) => s.sequence >= command.range.first && s.sequence <= command.range.last)
      .map((s) => s.eventId),
  );
  const candidates = command.candidates.map((input) => {
    if (
      new Set(input.sources).size !== input.sources.length ||
      input.sources.some((s) => !selected.has(s)) ||
      input.sensitivity === "restricted" ||
      !authority.candidateAllowed(input)
    )
      refuseReflection("denied");
    if (
      Buffer.byteLength(input.subject) > 256 ||
      Buffer.byteLength(input.content) > REFLECTION_LIMITS.contentBytes
    )
      refuseReflection("resource-exhausted");
    if (
      input.artifacts.some(
        (a) => !tx.artifact(a.artifactId, a.digest) || !authority.artifactAllowed(a),
      )
    )
      refuseReflection("source-unavailable");
    return {
      ...input,
      id: reflectionDigest({ request: record.id, candidate: input }),
      decision: "pending" as const,
      authority: "derived" as const,
    };
  });
  if (new Set(candidates.map((c) => c.id)).size !== candidates.length) refuseReflection("conflict");
  if (record.candidates.length + candidates.length > REFLECTION_LIMITS.candidates)
    refuseReflection("resource-exhausted");
  const prepared = command.prepared;
  if (prepared !== null) {
    if (command.disposition === "unavailable" || !authority.preparedAllowed(prepared))
      refuseReflection("denied");
    if (Buffer.byteLength(prepared.summary) > REFLECTION_LIMITS.projectionBytes)
      refuseReflection("resource-exhausted");
    if (!validReflectionPrepared(record, command.range, prepared)) refuseReflection("malformed");
  }
  const updated: ReflectionRecord = {
    ...record,
    revision: record.revision + 1,
    candidates: [...record.candidates, ...candidates],
    publications: [
      ...record.publications,
      {
        id: command.publicationId,
        digest: reflectionPublicationDigest(command),
        generation: record.publications.length + 1,
        range: command.range,
        disposition: command.disposition,
        candidates: candidates.map((c) => c.id),
        prepared,
      },
    ],
  };
  updated.state = reflectionPublicationState(updated);
  if (
    reflectionProgress(updated).pending.length === 0 ||
    updated.publications.length >= REFLECTION_LIMITS.publications
  )
    updated.lease = null;
  if (reflectionBytes(updated) > REFLECTION_LIMITS.recordBytes)
    refuseReflection("resource-exhausted");
  return updated;
}
