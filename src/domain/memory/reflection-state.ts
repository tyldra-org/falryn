import { createHash } from "node:crypto";
import { canonicalResourceValue } from "../orchestration/resource-admission.ts";
import {
  REFLECTION_LIMITS,
  type ReflectionBinding,
  type ReflectionCommand,
  type ReflectionRange,
  type ReflectionRecord,
  reflectionRecordSchema,
  refuseReflection,
} from "./reflection.ts";

export const reflectionDigest = (value: unknown): string =>
  `sha-256:${createHash("sha256").update(canonicalResourceValue(value)).digest("hex")}`;
export const reflectionBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
export const reflectionLineage = (binding: ReflectionBinding): string => reflectionDigest(binding);
export const rangesOverlap = (a: ReflectionRange, b: ReflectionRange): boolean =>
  a.first <= b.last && b.first <= a.last;
export const rangeContains = (a: ReflectionRange, b: ReflectionRange): boolean =>
  a.first <= b.first && a.last >= b.last;

/** Collapse adjacent intervals, never bridge a missing or unavailable event. */
export function mergeReflectionRanges(ranges: readonly ReflectionRange[]): ReflectionRange[] {
  const merged: ReflectionRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.first - b.first)) {
    const previous = merged.at(-1);
    if (previous && range.first <= previous.last + 1)
      previous.last = Math.max(previous.last, range.last);
    else merged.push({ ...range });
  }
  return merged;
}
export function reflectionGaps(
  range: ReflectionRange,
  covered: readonly ReflectionRange[],
): ReflectionRange[] {
  const gaps: ReflectionRange[] = [];
  let first = range.first;
  for (const item of mergeReflectionRanges(covered)) {
    if (item.last < first || item.first > range.last) continue;
    if (item.first > first) gaps.push({ first, last: item.first - 1 });
    first = Math.max(first, item.last + 1);
  }
  if (first <= range.last) gaps.push({ first, last: range.last });
  return gaps;
}
export function reflectionProgress(record: ReflectionRecord) {
  const processed = mergeReflectionRanges(
    record.publications.filter((p) => p.disposition !== "unavailable").map((p) => p.range),
  );
  const unavailable = mergeReflectionRanges(
    record.publications.filter((p) => p.disposition === "unavailable").map((p) => p.range),
  );
  return {
    processed,
    unavailable,
    pending: reflectionGaps(record.range, [...processed, ...unavailable]),
  };
}
export function reflectionPublicationState(record: ReflectionRecord): ReflectionRecord["state"] {
  const progress = reflectionProgress(record);
  if (progress.pending.length > 0) return "partial";
  if (progress.unavailable.length > 0)
    return progress.processed.length > 0 ? "partial" : "unavailable";
  return record.candidates.length === 0 ? "empty" : "completed";
}
export function reflectionIdentity(
  record: Pick<ReflectionRecord, "binding" | "transform" | "range" | "sourceDigest">,
): string {
  return reflectionDigest({
    binding: record.binding,
    transform: record.transform,
    range: record.range,
    sourceDigest: record.sourceDigest,
  });
}
export function validateReflectionRecord(value: unknown): ReflectionRecord {
  const parsed = reflectionRecordSchema.safeParse(value);
  if (!parsed.success || reflectionBytes(parsed.data) > REFLECTION_LIMITS.recordBytes)
    refuseReflection("corrupt");
  const record = parsed.data;
  if (
    record.id !== reflectionIdentity(record) ||
    record.lineage !== reflectionLineage(record.binding) ||
    record.sourceDigest !== reflectionDigest(record.sources) ||
    record.sources.length !== record.range.last - record.range.first + 1 ||
    record.sources.some((source, index) => source.sequence !== record.range.first + index) ||
    new Set(record.sources.map((s) => s.eventId)).size !== record.sources.length ||
    (record.lease !== null &&
      (record.lease.epoch !== record.epoch || !["leased", "partial"].includes(record.state))) ||
    (record.state === "leased" && record.lease === null) ||
    (record.state === "due" && (record.publications.length > 0 || record.epoch > 0)) ||
    (["empty", "completed"].includes(record.state) &&
      reflectionPublicationState(record) !== record.state) ||
    (record.state !== "stale" && (record.state === "uncertain") !== (record.uncertainty !== "none"))
  )
    refuseReflection("corrupt");
  const sources = new Set(record.sources.map((s) => s.eventId));
  const candidates = new Set<string>();
  for (const candidate of record.candidates) {
    const { id, decision: _decision, authority: _authority, ...input } = candidate;
    if (
      candidates.has(id) ||
      id !== reflectionDigest({ request: record.id, candidate: input }) ||
      input.sources.some((s) => !sources.has(s)) ||
      Buffer.byteLength(input.subject) > 256 ||
      Buffer.byteLength(input.content) > REFLECTION_LIMITS.contentBytes
    )
      refuseReflection("corrupt");
    candidates.add(id);
  }
  const published = new Set<string>();
  for (const [index, publication] of record.publications.entries()) {
    if (
      publication.generation !== index + 1 ||
      !rangeContains(record.range, publication.range) ||
      record.publications
        .slice(0, index)
        .some((p) => p.id === publication.id || rangesOverlap(p.range, publication.range)) ||
      publication.candidates.some((id) => !candidates.has(id) || published.has(id)) ||
      (publication.disposition !== "processed" && publication.candidates.length !== 0)
    )
      refuseReflection("corrupt");
    const inputs = publication.candidates.map((id) => {
      const candidate = record.candidates.find((c) => c.id === id);
      if (!candidate) refuseReflection("corrupt");
      const { id: _id, decision: _decision, authority: _authority, ...input } = candidate;
      const selected = new Set(
        record.sources
          .filter(
            (source) =>
              source.sequence >= publication.range.first &&
              source.sequence <= publication.range.last,
          )
          .map((source) => source.eventId),
      );
      if (input.sources.some((source) => !selected.has(source))) refuseReflection("corrupt");
      return input;
    });
    if (
      publication.digest !==
        reflectionDigest({
          id: publication.id,
          range: publication.range,
          disposition: publication.disposition,
          candidates: inputs,
          prepared: publication.prepared,
        }) ||
      !validReflectionPrepared(record, publication.range, publication.prepared) ||
      (publication.disposition === "unavailable" && publication.prepared !== null)
    )
      refuseReflection("corrupt");
    for (const id of publication.candidates) published.add(id);
  }
  if (
    published.size !== candidates.size ||
    record.invalidations.some((item, index) => item.generation !== index + 1) ||
    (record.invalidations.length > 0 && record.state !== "stale")
  )
    refuseReflection("corrupt");
  return record;
}

export function reflectionPublicationDigest(
  command: Extract<ReflectionCommand, { action: "publish" }>,
): string {
  return reflectionDigest({
    id: command.publicationId,
    range: command.range,
    disposition: command.disposition,
    candidates: command.candidates,
    prepared: command.prepared,
  });
}

export function validReflectionPrepared(
  record: ReflectionRecord,
  range: ReflectionRange,
  prepared: ReflectionRecord["publications"][number]["prepared"],
): boolean {
  if (prepared === null) return true;
  const selected = new Set(
    record.sources
      .filter((source) => source.sequence >= range.first && source.sequence <= range.last)
      .map((source) => source.eventId),
  );
  const references = [
    ...prepared.represented,
    ...prepared.omissions.map((omission) => omission.source),
  ];
  return (
    Buffer.byteLength(prepared.summary) <= REFLECTION_LIMITS.projectionBytes &&
    references.length === selected.size &&
    new Set(references).size === references.length &&
    references.every((source) => selected.has(source)) &&
    new Set(prepared.protectedSources).size === prepared.protectedSources.length &&
    prepared.protectedSources.every((source) => prepared.represented.includes(source)) &&
    (prepared.fidelity !== "exact-source-references" || prepared.summary === "") &&
    (prepared.recovery !== "available" ||
      !prepared.omissions.some((o) => ["restricted", "expired", "unavailable"].includes(o.reason)))
  );
}
