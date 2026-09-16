import { deadlineAt, instant } from "../../domain/foundation/index.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import type {
  PreparedProfileOwner,
  ProfileOwnerReceipt,
  ProfileTransitionPorts,
  ProfileTransitionPreview,
  ProfileTransitionReceipt,
  ProfileTransitionRefusal,
  ProfileTransitions,
  ResolvedProfileTransition,
} from "./transition-contracts.ts";

const refused = (code: string): ProfileTransitionRefusal => ({ kind: "refused", code });

/** One bounded transition at a time. Inspection never acquires resources. */
export function createProfileTransitions(ports: ProfileTransitionPorts): ProfileTransitions {
  if (
    !Number.isInteger(ports.maxOwners) ||
    ports.maxOwners < 1 ||
    ports.maxOwners > 64 ||
    ports.owners.length > ports.maxOwners ||
    new Set(ports.owners.map((owner) => owner.id)).size !== ports.owners.length ||
    !Number.isFinite(ports.deadlineMs) ||
    ports.deadlineMs <= 0
  )
    throw new Error("Invalid profile transition bounds.");
  let epoch = 0;
  let running = false;
  let latest: ProfileTransitionReceipt | null = null;
  let reviewed: {
    readonly preview: ProfileTransitionPreview;
    readonly candidate: ResolvedProfileTransition;
    readonly actor: "user" | "model";
    readonly epoch: number;
  } | null = null;
  const inScope = (scope: { sessionId: string; workspaceId: string }) =>
    scope.sessionId === ports.scope.sessionId && scope.workspaceId === ports.scope.workspaceId;

  async function save(receipt: ProfileTransitionReceipt): Promise<boolean> {
    latest = structuredClone(receipt);
    return (await bounded(ports.record(latest), AbortSignal.timeout(ports.deadlineMs))) ?? false;
  }

  return {
    async sourcesChanged(signal) {
      const selected = reviewed;
      if (selected === null) return;
      const abort = AbortSignal.any([
        AbortSignal.timeout(ports.deadlineMs),
        ...(signal ? [signal] : []),
      ]);
      const valid = await bounded(selected.candidate.validate(abort), abort).catch(() => false);
      // A notification describes a source observation, not a new authority epoch.
      // Applying candidates perform their own source CAS; never revoke a newer
      // preview or an already published owner's acknowledgement with an old event.
      if (!valid && reviewed === selected) {
        epoch++;
        reviewed = null;
      }
    },
    invalidate() {
      epoch++;
      reviewed = null;
    },
    async inspect() {
      const receipt = latest ?? (await ports.recover());
      // Recorded facts are historical evidence, not permission to resume owner work.
      return receipt === null || !inScope(receipt) ? null : structuredClone(receipt);
    },
    async reconcile(actor, signal) {
      if (running) return refused("transition-busy");
      if (!ports.authorize(actor)) return refused("profile-policy-denied");
      running = true;
      const abort = AbortSignal.any([
        AbortSignal.timeout(ports.deadlineMs),
        ...(signal ? [signal] : []),
      ]);
      try {
        const fact = latest ?? (await bounded(ports.recover(), abort));
        if (!fact || !inScope(fact) || fact.publishedGeneration === null)
          return refused("published-transition-missing");
        const before = ports.current();
        if (before.generation !== fact.publishedGeneration) return refused("configuration-changed");
        const owners = [...fact.owners];
        for (const [index, previous] of owners.entries()) {
          const owner = ports.owners.find((entry) => entry.id === previous.owner);
          if (!owner?.inspect || abort.aborted) continue;
          const observed = await bounded(
            owner.inspect(fact.publishedGeneration, abort),
            abort,
          ).catch(() => ({
            state: "failed" as const,
            generation: null,
            code: "owner-inspection-failed",
          }));
          if (
            observed &&
            JSON.stringify(before) === JSON.stringify(ports.current()) &&
            ports.authorize(actor)
          )
            owners[index] = {
              owner: previous.owner,
              ...(observed.state === "applied" && observed.generation !== fact.publishedGeneration
                ? {
                    state: "failed" as const,
                    generation: null,
                    code: "acknowledgement-generation-mismatch",
                  }
                : observed),
            };
        }
        const reconciled = {
          ...fact,
          owners,
          code: owners.every(
            (owner) => owner.state === "applied" && owner.generation === fact.publishedGeneration,
          )
            ? "applied"
            : "partial",
        };
        await save(reconciled);
        return { kind: "receipt", receipt: reconciled };
      } finally {
        running = false;
      }
    },
    async preview(request, signal) {
      if (!inScope(request)) return refused("session-target-mismatch");
      if (running) return refused("transition-busy");
      const serial = ++epoch;
      reviewed = null;
      const previous = ports.current();
      if (
        request.expectedGeneration !== previous.generation ||
        request.expectedSources !== previous.sources
      )
        return refused("configuration-changed");
      if (!ports.authorize(request.actor)) return refused("profile-policy-denied");
      const abort = signal ?? new AbortController().signal;
      if (abort.aborted) return refused("cancelled");
      const candidate = await bounded(
        ports.resolve(request.profile, abort),
        AbortSignal.any([abort, AbortSignal.timeout(ports.deadlineMs)]),
      );
      if (candidate === null) return refused("preview-cancelled-or-timed-out");
      if ("kind" in candidate) return candidate;
      if (abort.aborted) return refused("cancelled");
      if (serial !== epoch || JSON.stringify(ports.current()) !== JSON.stringify(previous))
        return refused("configuration-changed");
      if (!ports.authorize(request.actor, candidate)) return refused("profile-policy-denied");
      const preview: ProfileTransitionPreview = {
        kind: "preview",
        ...ports.scope,
        candidateId: ports.newIdentity(),
        profile: request.profile,
        expectedGeneration: previous.generation,
        expectedSources: previous.sources,
        policyRevision: previous.policy,
        changes: candidate.changes,
        inspection: candidate.inspection,
        effectiveInputChanged: candidate.effectiveInputChanged,
        owners: ports.owners.map((owner) => ({ ...owner.describe(candidate), owner: owner.id })),
      };
      reviewed = { preview, candidate, actor: request.actor, epoch: serial };
      return structuredClone(preview);
    },
    async apply(request, signal) {
      if (!inScope(request)) return refused("session-target-mismatch");
      if (running) return refused("transition-busy");
      const selected = reviewed;
      if (selected === null || selected.preview.candidateId !== request.candidateId)
        return refused("candidate-missing");
      const { candidate, preview, actor } = selected;
      if (request.actor !== actor) return refused("profile-policy-denied");
      if (request.expectedGeneration !== preview.expectedGeneration)
        return refused("configuration-changed");
      reviewed = null;
      running = true;
      const stop = new AbortController();
      const abort = AbortSignal.any([stop.signal, ...(signal ? [signal] : [])]);
      const timer = setTimeout(() => stop.abort(), ports.deadlineMs);
      const prepared: { owner: string; value: PreparedProfileOwner }[] = [];
      let published: number | null = null;
      let owners: ProfileOwnerReceipt[] = preview.owners.map((plan) => ({
        owner: plan.owner,
        state: "pending",
        generation: null,
        code: "not-prepared",
      }));
      const receipt = (
        stage: ProfileTransitionReceipt["stage"],
        code: string,
      ): ProfileTransitionReceipt => ({
        ...ports.scope,
        candidateId: preview.candidateId,
        profile: preview.profile,
        previousGeneration: preview.expectedGeneration,
        publishedGeneration: published,
        savedFileRevision: request.savedFileRevision ?? null,
        stage,
        code,
        owners: [...owners],
      });
      const current = () => {
        const now = ports.current();
        return (
          !abort.aborted &&
          selected.epoch === epoch &&
          now.generation === (published ?? preview.expectedGeneration) &&
          (published !== null || now.sources === preview.expectedSources) &&
          now.policy === preview.policyRevision &&
          ports.authorize(actor, candidate)
        );
      };
      const reject = async (code: string) => {
        const fact = receipt("rejected", code);
        await save(fact);
        return { kind: "receipt" as const, receipt: fact };
      };
      try {
        if (abort.aborted) return await reject("cancelled");
        if (!current() || !(await bounded(candidate.validate(abort), abort)))
          return await reject("configuration-changed");
        if (!(await save(receipt("preparing", "preparation-admitted"))))
          return await reject("receipt-store-unavailable");
        for (const [index, owner] of ports.owners.entries()) {
          const plan = preview.owners[index];
          if (plan === undefined) throw new Error("Missing owner plan.");
          if (plan.availability !== "available") {
            owners[index] = {
              owner: owner.id,
              state: plan.availability,
              generation: null,
              code: plan.availability,
            };
            if (plan.required) return await reject("required-owner-unavailable");
            continue;
          }
          if (abort.aborted || !current())
            return await reject(abort.aborted ? "cancelled" : "configuration-changed");
          const identity = `profile:${preview.candidateId}:${owner.id}`;
          const operation = ports.resources
            .execute<PreparedProfileOwner | ProfileTransitionRefusal>({
              operation: identity,
              attempt: identity,
              generation: ports.resources.generation,
              signal: abort,
              inputBytes: 0,
              amounts: {
                operations: 1,
                ...(plan.bufferedBytes ? { bufferedBytes: plan.bufferedBytes } : {}),
                ...(plan.preparation === "connection" ? { requests: 1 } : {}),
              },
              unit: {
                id: workUnitId(identity),
                effect: "mutation",
                priority: "interactive",
                conflictKeys: [conflictKey("profile-transition", ports.scope.sessionId)],
                dependencies: [],
                deadline: deadlineAt(instant(ports.resources.expiresAt)),
                expectedOutputBytes: 4096,
                retry: NO_RETRY,
                scopeId: null,
              },
              checkAdmission: () =>
                current() ? null : ports.resources.refusal("authority-denied"),
              async run(admittedSignal) {
                const value = await owner.prepare(candidate, ports.resources, admittedSignal);
                if (admittedSignal.aborted && !("kind" in value)) {
                  await value.release();
                  return {
                    value: refused("cancelled"),
                    terminated: true,
                    observedEffect: "completed",
                  };
                }
                return {
                  value,
                  terminated: value.terminated ?? true,
                  observedEffect: value.observedEffect ?? "none",
                };
              },
            })
            .then((result) =>
              result.kind === "completed"
                ? result.value
                : refused(`preparation-${result.receipt.state}`),
            );
          const value = await bounded(operation, abort, (late) => {
            if (!("kind" in late)) void late.release().catch(() => {});
          });
          if (value === null) return await reject("preparation-cancelled-or-timed-out");
          if ("kind" in value) {
            owners[index] = {
              owner: owner.id,
              state: plan.required ? "failed" : "unavailable",
              generation: null,
              code: value.code,
            };
            if (plan.required) return await reject("required-preparation-failed");
          } else prepared.push({ owner: owner.id, value });
        }
        if (!(await save(receipt("prepared", "prepared"))))
          return await reject("receipt-store-unavailable");
        if (abort.aborted || !current() || !(await bounded(candidate.validate(abort), abort)))
          return await reject(abort.aborted ? "cancelled" : "configuration-changed");
        for (const entry of prepared) {
          if (entry.value.validate && !(await bounded(entry.value.validate(abort), abort)))
            return await reject("preparation-input-changed");
        }
        if (!current()) return await reject("configuration-changed");
        published = await candidate.publish(abort, current);
        if (published === null) return await reject("publication-refused");
        owners = owners.map((entry) =>
          entry.state === "pending" ? { ...entry, code: "awaiting-acknowledgement" } : entry,
        );
        if (!(await save(receipt("published", "published"))))
          return { kind: "receipt", receipt: receipt("published", "receipt-store-unavailable") };
        for (const entry of prepared) {
          if (abort.aborted || !current()) break;
          const acknowledgement = await bounded(
            entry.value.acknowledge(published, current, abort),
            abort,
          ).catch(() => ({
            state: "failed" as const,
            generation: null,
            code: "acknowledgement-failed",
          }));
          if (acknowledgement !== null && current()) {
            const applied =
              acknowledgement.state !== "applied" || acknowledgement.generation === published;
            owners = owners.map((owner) =>
              owner.owner === entry.owner
                ? {
                    owner: owner.owner,
                    ...(applied
                      ? acknowledgement
                      : {
                          state: "failed" as const,
                          generation: null,
                          code: "acknowledgement-generation-mismatch",
                        }),
                  }
                : owner,
            );
            if (!(await save(receipt("published", "acknowledged")))) break;
          }
        }
        const fact = receipt(
          "settled",
          owners.some((owner) => owner.state !== "applied") ? "partial" : "applied",
        );
        const recorded = await save(fact);
        return {
          kind: "receipt",
          receipt: recorded ? fact : { ...fact, code: "receipt-store-unavailable" },
        };
      } catch {
        const fact = receipt(published === null ? "rejected" : "published", "owner-failed");
        await save(fact).catch(() => false);
        return { kind: "receipt", receipt: fact };
      } finally {
        stop.abort();
        clearTimeout(timer);
        // Published owners retain their resources, including pending reconciliation.
        if (published === null)
          await bounded(
            Promise.allSettled(prepared.map((entry) => entry.value.release())),
            AbortSignal.timeout(ports.deadlineMs),
          );
        running = false;
      }
    },
  };
}

/** Ignore late completion while still releasing resources acquired after cancellation. */
async function bounded<T>(
  work: Promise<T>,
  signal: AbortSignal,
  late?: (value: T) => void,
): Promise<T | null> {
  if (signal.aborted) {
    void work.then(late).catch(() => {});
    return null;
  }
  let expired = false;
  let cancel!: () => void;
  const stopped = new Promise<null>((resolve) => {
    cancel = () => {
      expired = true;
      resolve(null);
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([
      work.then((value) => {
        if (expired) late?.(value);
        return value;
      }),
      stopped,
    ]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
