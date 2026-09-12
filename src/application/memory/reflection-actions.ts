import { randomUUID } from "node:crypto";
import { deadlineAt, instant } from "../../domain/foundation/index.ts";
import { err } from "../../domain/foundation/result.ts";
import {
  REFLECTION_LIMITS,
  type ReflectionAuthority,
  type ReflectionBinding,
  type ReflectionCommand,
  type ReflectionFence,
  type ReflectionRecord,
  ReflectionRefusal,
  type ReflectionRepository,
  type ReflectionResult,
  type ReflectionTransaction,
  reflectionBindingSchema,
  reflectionCommandSchema,
  refuseReflection,
} from "../../domain/memory/reflection.ts";
import {
  exportReflection,
  type ReflectionExport,
  type ReflectionView,
  reflectionView,
} from "../../domain/memory/reflection-export.ts";
import {
  mergeReflectionRanges,
  rangesOverlap,
  reflectionBytes,
  reflectionDigest,
  reflectionGaps,
  reflectionIdentity,
  reflectionLineage,
  reflectionProgress,
  reflectionPublicationDigest,
} from "../../domain/memory/reflection-state.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";
import {
  publishReflection,
  reflectionHasSecret,
  validateReflectionEvidence,
} from "./reflection-publication.ts";

export type ReflectionMetadata = Pick<
  ReflectionView,
  | "id"
  | "binding"
  | "transform"
  | "range"
  | "state"
  | "revision"
  | "epoch"
  | "lease"
  | "uncertainty"
  | "invalidations"
> & { readonly reconcilable: boolean };
export type ReflectionCoverage = {
  readonly version: 1;
  readonly lineage: string;
  readonly transform: string;
  readonly committedThrough: number;
  readonly contiguousThrough: number;
  readonly processed: readonly { first: number; last: number }[];
  readonly unavailable: readonly { first: number; last: number }[];
  readonly pending: readonly { first: number; last: number }[];
  readonly partial: boolean;
  readonly limited: boolean;
  readonly semanticCompleteness: "unknown";
  readonly generations: readonly {
    id: string;
    revision: number;
    sourceDigest: string;
    publication: number;
  }[];
};
export type ReflectionResponse =
  | { readonly kind: "record"; readonly record: ReflectionView; readonly fence?: ReflectionFence }
  | {
      readonly kind: "stale";
      readonly id: string;
      readonly revision: number;
      readonly invalidations: ReflectionRecord["invalidations"];
    }
  | {
      readonly kind: "page";
      readonly items: readonly ReflectionMetadata[];
      readonly next: string | null;
    }
  | { readonly kind: "coverage"; readonly coverage: ReflectionCoverage }
  | { readonly kind: "export"; readonly snapshot: ReflectionExport };

function metadata(record: ReflectionRecord, now: number): ReflectionMetadata {
  const {
    id,
    binding,
    transform,
    range,
    state,
    revision,
    epoch,
    lease,
    uncertainty,
    invalidations,
  } = reflectionView(record);
  return {
    id,
    binding,
    transform,
    range,
    state,
    revision,
    epoch,
    lease,
    uncertainty,
    invalidations,
    reconcilable: lease !== null && lease.expiresAt <= now,
  };
}
function invalidationReason(
  record: ReflectionRecord,
  binding: ReflectionBinding,
): ReflectionRecord["invalidations"][number]["reason"] | null {
  const previous = record.binding;
  if (previous.authorizationGeneration !== binding.authorizationGeneration) return "authorization";
  if (
    previous.policyGeneration !== binding.policyGeneration ||
    previous.configurationGeneration !== binding.configurationGeneration
  )
    return "policy";
  if (previous.sourceGeneration !== binding.sourceGeneration) return "source";
  return reflectionLineage(binding) !== record.lineage ? "scope" : null;
}
/** One application owner governs reads and fenced mutations. No turn hook or executor is installed. */
export function createReflectionActions(
  repository: ReflectionRepository,
  options: {
    readonly authority: ReflectionAuthority;
    readonly resources: ProductTaskResources;
    readonly now?: () => number;
  },
) {
  const now = options.now ?? Date.now;
  const authority = options.authority;
  function current(): ReflectionBinding {
    const binding = reflectionBindingSchema.safeParse(authority.current());
    if (!binding.success || reflectionHasSecret(binding.data)) refuseReflection("denied");
    return binding.data;
  }
  function invalidate(
    tx: ReflectionTransaction,
    record: ReflectionRecord,
    reason: ReflectionRecord["invalidations"][number]["reason"],
  ): ReflectionRecord {
    if (record.invalidations.length >= REFLECTION_LIMITS.invalidations)
      refuseReflection("resource-exhausted");
    const updated: ReflectionRecord = {
      ...record,
      revision: record.revision + 1,
      state: "stale",
      lease: null,
      invalidations: [
        ...record.invalidations,
        { generation: record.invalidations.length + 1, reason, at: now() },
      ],
    };
    tx.save(updated, record.revision);
    return updated;
  }
  function refresh(
    tx: ReflectionTransaction,
    record: ReflectionRecord,
    binding: ReflectionBinding,
  ): ReflectionRecord {
    if (
      record.binding.sessionId !== binding.sessionId ||
      record.binding.workspaceId !== binding.workspaceId
    )
      refuseReflection("denied");
    if (record.state === "stale") return record;
    let reason = invalidationReason(record, binding);
    if (reason === null) {
      try {
        const sources = tx.source(binding, record.range);
        if (reflectionDigest(sources) !== record.sourceDigest) reason = "source";
        else if (!validateReflectionEvidence(record, tx, authority)) reason = "sensitivity";
      } catch (error) {
        if (
          error instanceof ReflectionRefusal &&
          ["source-unavailable", "source-too-large"].includes(error.code)
        )
          reason = "retention";
        else throw error;
      }
    }
    return reason === null ? record : invalidate(tx, record, reason);
  }
  function scan(
    tx: ReflectionTransaction,
    binding: ReflectionBinding,
    check: () => void,
    visit: (record: ReflectionRecord) => void,
  ) {
    let after: string | null = null,
      count = 0;
    for (;;) {
      check();
      const page = tx.list(binding.sessionId, after, REFLECTION_LIMITS.page);
      for (const record of page) {
        if (++count > REFLECTION_LIMITS.requestsPerSession) refuseReflection("corrupt");
        check();
        visit(record);
      }
      if (page.length < REFLECTION_LIMITS.page) return;
      after = page.at(-1)?.id ?? null;
    }
  }
  function perform(
    tx: ReflectionTransaction,
    command: ReflectionCommand,
    check: () => void,
  ): ReflectionResponse {
    const binding = current();
    if (command.action === "create") {
      if (reflectionLineage(binding) !== reflectionLineage(command.binding))
        refuseReflection("denied");
      const sources = [...tx.source(binding, command.range)];
      if (!sources.every((s) => authority.sourceAllowed(s))) refuseReflection("denied");
      const sourceDigest = reflectionDigest(sources);
      const identity = {
        binding,
        transform: command.transform,
        range: command.range,
        sourceDigest,
      };
      const id = reflectionIdentity(identity);
      const existing = tx.get(id);
      if (existing) {
        const record = refresh(tx, existing, binding);
        return record.state === "stale"
          ? { kind: "stale", id, revision: record.revision, invalidations: record.invalidations }
          : { kind: "record", record: reflectionView(record) };
      }
      const transforms = new Set<string>();
      scan(tx, binding, check, (record) => {
        transforms.add(record.transform);
        if (
          record.lineage === reflectionLineage(binding) &&
          record.transform === command.transform &&
          rangesOverlap(record.range, command.range)
        )
          refuseReflection("source-overlap");
      });
      if (!transforms.has(command.transform) && transforms.size >= REFLECTION_LIMITS.generations)
        refuseReflection("resource-exhausted");
      const record: ReflectionRecord = {
        version: 1,
        id,
        lineage: reflectionLineage(binding),
        ...identity,
        sources,
        reason: command.reason,
        createdAt: now(),
        revision: 1,
        state: "due",
        epoch: 0,
        lease: null,
        candidates: [],
        publications: [],
        invalidations: [],
        uncertainty: "none",
      };
      tx.save(record, null);
      return { kind: "record", record: reflectionView(record) };
    }
    if (command.action === "list" || command.action === "reconcile") {
      const page = tx.list(binding.sessionId, command.after, command.limit);
      const items = page.map((record) => {
        check();
        return metadata(refresh(tx, record, binding), now());
      });
      return {
        kind: "page",
        items,
        next: page.length === command.limit ? (page.at(-1)?.id ?? null) : null,
      };
    }
    if (command.action === "coverage") {
      const committedThrough = tx.committedThrough(binding);
      if (committedThrough !== command.committedThrough) refuseReflection("stale");
      const processed: { first: number; last: number }[] = [],
        unavailable: { first: number; last: number }[] = [];
      const generations: {
        id: string;
        revision: number;
        sourceDigest: string;
        publication: number;
      }[] = [];
      scan(tx, binding, check, (input) => {
        if (input.transform !== command.transform) return;
        const record = refresh(tx, input, binding);
        if (record.state === "stale") return;
        const progress = reflectionProgress(record);
        processed.push(...progress.processed);
        unavailable.push(...progress.unavailable);
        generations.push({
          id: record.id,
          revision: record.revision,
          sourceDigest: record.sourceDigest,
          publication: record.publications.length,
        });
      });
      const allCompleted = mergeReflectionRanges(processed);
      const allMissing = mergeReflectionRanges(unavailable);
      // A bounded receipt conservatively leaves overflow outstanding. Stored publications remain intact.
      const completed = allCompleted.slice(0, REFLECTION_LIMITS.coverageRanges);
      const missing = allMissing.slice(
        0,
        Math.max(0, REFLECTION_LIMITS.coverageRanges - completed.length),
      );
      const limited = completed.length < allCompleted.length || missing.length < allMissing.length;
      const pending = reflectionGaps({ first: 1, last: committedThrough }, [
        ...completed,
        ...missing,
      ]);
      const contiguousThrough = completed[0]?.first === 1 ? completed[0].last : 0;
      return {
        kind: "coverage",
        coverage: {
          version: 1,
          lineage: reflectionLineage(binding),
          transform: command.transform,
          committedThrough,
          contiguousThrough,
          processed: completed,
          unavailable: missing,
          pending,
          partial: limited || pending.length > 0 || missing.length > 0,
          limited,
          semanticCompleteness: "unknown",
          generations,
        },
      };
    }
    const existing = tx.get(command.id);
    if (!existing) refuseReflection("unavailable");
    if (
      existing.binding.sessionId !== binding.sessionId ||
      existing.binding.workspaceId !== binding.workspaceId
    )
      refuseReflection("denied");
    if (command.action === "invalidate") {
      if (existing.revision !== command.expectedRevision) refuseReflection("conflict");
      const record = invalidate(tx, existing, command.reason);
      return {
        kind: "stale",
        id: record.id,
        revision: record.revision,
        invalidations: record.invalidations,
      };
    }
    let record = refresh(tx, existing, binding);
    if (record.state === "stale")
      return {
        kind: "stale",
        id: record.id,
        revision: record.revision,
        invalidations: record.invalidations,
      };
    if (command.action === "inspect") return { kind: "record", record: reflectionView(record) };
    if (command.action === "export") {
      if (record.revision !== command.expectedRevision) refuseReflection("conflict");
      return { kind: "export", snapshot: exportReflection(record) };
    }
    if (command.action === "publish") {
      const previous = record.publications.find((p) => p.id === command.publicationId);
      if (previous) {
        if (previous.digest !== reflectionPublicationDigest(command)) refuseReflection("conflict");
        // Acknowledgement recovery returns existing data; it never executes or writes again.
        return { kind: "record", record: reflectionView(record) };
      }
    }
    if (command.action === "lease") {
      if (
        !["due", "leased", "partial"].includes(record.state) ||
        reflectionProgress(record).pending.length === 0 ||
        (record.lease !== null && record.lease.expiresAt > now())
      )
        refuseReflection("conflict");
      if (record.publications.length >= REFLECTION_LIMITS.publications)
        refuseReflection("resource-exhausted");
      record = {
        ...record,
        revision: record.revision + 1,
        epoch: record.epoch + 1,
        state: "leased",
        lease: {
          token: randomUUID(),
          epoch: record.epoch + 1,
          expiresAt: now() + command.durationMs,
          process: command.process,
        },
      };
      tx.save(record, existing.revision);
      if (!record.lease) refuseReflection("corrupt");
      return {
        kind: "record",
        record: reflectionView(record),
        fence: { token: record.lease.token, epoch: record.lease.epoch },
      };
    }
    const lease = record.lease;
    if (
      !lease ||
      lease.expiresAt <= now() ||
      lease.token !== command.fence.token ||
      lease.epoch !== command.fence.epoch
    )
      refuseReflection("stale-lease");
    switch (command.action) {
      case "heartbeat":
        record = {
          ...record,
          revision: record.revision + 1,
          lease: { ...lease, expiresAt: now() + command.durationMs },
        };
        break;
      case "publish":
        record = publishReflection(record, command, tx, authority);
        break;
      case "settle":
        if ((command.state === "uncertain") !== (command.uncertainty !== "none"))
          refuseReflection("malformed");
        record = {
          ...record,
          revision: record.revision + 1,
          state: command.state,
          lease: null,
          uncertainty: command.uncertainty,
        };
        break;
    }
    tx.save(record, existing.revision);
    return { kind: "record", record: reflectionView(record) };
  }
  return {
    async execute(
      json: string,
      signal = new AbortController().signal,
    ): Promise<ReflectionResult<ReflectionResponse>> {
      if (signal.aborted) return err({ kind: "reflection", code: "cancelled" });
      if (typeof json !== "string" || Buffer.byteLength(json) > REFLECTION_LIMITS.recordBytes)
        return err({ kind: "reflection", code: "resource-exhausted" });
      let value: unknown;
      try {
        value = JSON.parse(json);
      } catch {
        return err({ kind: "reflection", code: "malformed" });
      }
      const parsed = reflectionCommandSchema.safeParse(value);
      if (!parsed.success) return err({ kind: "reflection", code: "malformed" });
      if (reflectionHasSecret(parsed.data)) return err({ kind: "reflection", code: "denied" });
      const deadline =
        now() + Math.min(REFLECTION_LIMITS.validationMs, options.resources.remaining("wallTimeMs"));
      const observed: { value?: ReflectionResult<ReflectionResponse> } = {};
      const execution = await options.resources.execute({
        operation: `reflection:${randomUUID()}`,
        attempt: randomUUID(),
        generation: options.resources.generation,
        unit: {
          id: workUnitId(`reflection:${randomUUID()}`),
          effect: "mutation",
          priority: "interactive",
          conflictKeys: [conflictKey("reflection", "shared-state")],
          dependencies: [],
          deadline: deadlineAt(instant(deadline)),
          expectedOutputBytes: REFLECTION_LIMITS.recordBytes + 1024,
          retry: NO_RETRY,
          scopeId: null,
        },
        inputBytes: Buffer.byteLength(json),
        amounts: { operations: 1 },
        signal,
        async run(admittedSignal) {
          const result = repository.transaction((tx) => {
            const check = () => {
              if (admittedSignal.aborted) refuseReflection("cancelled");
              if (now() >= deadline) refuseReflection("resource-exhausted");
            };
            check();
            const initial = reflectionLineage(current());
            const response = perform(tx, parsed.data, check);
            check();
            if (reflectionLineage(current()) !== initial) refuseReflection("stale");
            if (reflectionBytes(response) > REFLECTION_LIMITS.recordBytes + 1024)
              refuseReflection("resource-exhausted");
            return response;
          }, admittedSignal);
          observed.value = result;
          return {
            value: result,
            terminated: true,
            observedEffect: result.ok
              ? ("completed" as const)
              : result.error.code === "uncertain"
                ? ("uncertain" as const)
                : ("none" as const),
          };
        },
      });
      return execution.kind === "completed"
        ? execution.value
        : (observed.value ??
            err({ kind: "reflection", code: signal.aborted ? "cancelled" : "resource-exhausted" }));
    },
  };
}
