/** Child ownership joins the existing scope tree, ledger and scheduler; it is not a runner. */
import { z } from "zod";
import type { ChildWorkTarget } from "../../domain/orchestration/child-admission.ts";
import {
  type ChildAuthority,
  childAuthoritySchema,
  narrowChildAuthority,
  sameChildProvider,
} from "../../domain/orchestration/child-admission.ts";
import type { EffectCertainty } from "../../domain/orchestration/outcome.ts";
import {
  type ResourceAmounts,
  resourceAmountsSchema,
} from "../../domain/orchestration/resource-admission.ts";
import type { EffectClass } from "../../domain/orchestration/work.ts";
import type { ProductTaskResources } from "./product-resources.ts";
import type { ScopeHandle, ScopeTree } from "./scope-tree.ts";

const requestSchema = z
  .object({
    id: z.string().min(1).max(256),
    /** Host digest of objective + input/evidence generation, never a display name. */
    workDigest: z.string().regex(/^[a-f0-9]{64}$/),
    authority: childAuthoritySchema,
    limits: resourceAmountsSchema,
  })
  .strict();
export type ChildAdmissionRequest = z.infer<typeof requestSchema>;
export type ChildAdmissionResult =
  | { readonly kind: "admitted"; readonly child: AdmittedChild }
  | {
      readonly kind: "refused";
      readonly reason:
        | "invalid-request"
        | "stale-parent"
        | "duplicate-child"
        | "no-progress"
        | "authority-denied"
        | "resource-limit"
        | "scope-limit";
    };
export type AdmittedChild = {
  readonly id: string;
  readonly scope: ScopeHandle;
  readonly resources: ProductTaskResources;
  readonly authority: ChildAuthority;
  /** Logical admission is not a claim of OS confinement. */
  readonly isolation: "logical-only";
  admit(request: unknown): ChildAdmissionResult;
  cancellationBoundary(enabled: boolean): boolean;
  close(): void;
};
const admittedHandles = new WeakSet<object>();
const accountingResources = new WeakMap<ProductTaskResources, ProductTaskResources>();
/** Serialized handles are evidence only; another process must reconcile before re-admission. */
export function isAdmittedChild(value: unknown): value is AdmittedChild {
  return value !== null && typeof value === "object" && admittedHandles.has(value);
}

/** The trusted host supplies its verified authority, never a package's self-declaration. */
export function createChildAdmission(options: {
  readonly resources: ProductTaskResources;
  readonly tree: ScopeTree;
  readonly scope: ScopeHandle;
  readonly authority: ChildAuthority;
}) {
  const { resources: rootResources, tree } = options;
  const rootScope = Object.freeze({ ...options.scope });
  const parsed = childAuthoritySchema.parse(options.authority);
  if (parsed.configurationGeneration !== rootResources.generation)
    throw new Error("child admission generation mismatch");
  const authority = freezeAuthority(parsed);

  function admit(
    parentResources: ProductTaskResources,
    parentScope: ScopeHandle,
    parentAuthority: ChildAuthority,
    raw: unknown,
  ): ChildAdmissionResult {
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return { kind: "refused", reason: "invalid-request" };
    const request = parsed.data;
    if (
      parentScope.signal.aborted ||
      parentResources.remaining("wallTimeMs") === 0 ||
      tree.report(parentScope.scopeId)?.state.status !== "active"
    )
      return { kind: "refused", reason: "stale-parent" };
    const identity = parentResources.childIdentity(request.id, request.workDigest);
    if (identity !== "available") return { kind: "refused", reason: identity };
    const narrowed = narrowChildAuthority(parentAuthority, request.authority);
    if (!narrowed) return { kind: "refused", reason: "stale-parent" };
    // A required route cannot be silently replaced or dropped by intersection.
    if (narrowed.providers.length !== request.authority.providers.length)
      return { kind: "refused", reason: "authority-denied" };
    const derived = tree.derive(parentScope.scopeId, { kind: "child" });
    if (!derived.ok) return { kind: "refused", reason: "scope-limit" };
    const allocation = (accountingResources.get(parentResources) ?? parentResources).subdivide(
      request.limits,
      {
        id: request.id,
        workDigest: request.workDigest,
      },
    );
    if (!allocation) {
      tree.fail(derived.value.scopeId);
      return { kind: "refused", reason: "resource-limit" };
    }
    const boundary = freezeAuthority(narrowed);
    const scope = Object.freeze(derived.value);
    let running = 0;
    let terminationUnknown = false;
    const acknowledge = () => {
      if (
        running === 0 &&
        !terminationUnknown &&
        tree.state(scope.scopeId)?.status === "cancelling"
      )
        tree.acknowledge(scope.scopeId);
    };
    const resources = guardResources(allocation, boundary, scope.signal, {
      started() {
        running++;
      },
      settled(effect, terminated) {
        running--;
        terminationUnknown ||= !terminated;
        tree.recordLateEffect(scope.scopeId, effect);
        acknowledge();
      },
    });
    accountingResources.set(resources, allocation);
    let closed = false;
    const onAbort = () => {
      resources.close();
      acknowledge();
    };
    scope.signal.addEventListener("abort", onAbort, { once: true });
    const child: AdmittedChild = {
      id: request.id,
      scope,
      resources: Object.freeze(resources),
      authority: boundary,
      isolation: "logical-only",
      admit: (value) => admit(resources, scope, boundary, value),
      cancellationBoundary: (enabled) => tree.cancellationBoundary(scope.scopeId, enabled),
      close() {
        if (closed) return;
        closed = true;
        scope.signal.removeEventListener("abort", onAbort);
        resources.close();
        // Closing an admission is not success evidence for the child's objective.
        tree.cancel(scope.scopeId, { kind: "requested" });
        acknowledge();
      },
    };
    admittedHandles.add(child);
    return { kind: "admitted", child: Object.freeze(child) };
  }
  return {
    admit: (request: unknown) => admit(rootResources, rootScope, authority, request),
  };
}

function freezeAuthority(value: ChildAuthority): ChildAuthority {
  const copy = structuredClone(value);
  for (const provider of copy.providers) Object.freeze(provider);
  Object.freeze(copy.providers);
  Object.freeze(copy.capabilities);
  Object.freeze(copy.effects);
  return Object.freeze(copy);
}

function guardResources(
  task: ProductTaskResources,
  authority: ChildAuthority,
  signal: AbortSignal,
  observe: { started(): void; settled(effect: EffectCertainty, terminated: boolean): void },
): ProductTaskResources {
  const allowed = (target: ChildWorkTarget | undefined, effect: EffectClass) => {
    if (signal.aborted) return task.refusal("stale-generation");
    if (!target || target.workspaceId !== authority.workspaceId)
      return task.refusal("authority-denied");
    const permitted =
      target.kind === "provider"
        ? authority.providers.some((binding) => sameChildProvider(binding, target.binding))
        : target.capabilityGeneration === authority.capabilityGeneration &&
          authority.capabilities.includes(target.capabilityId) &&
          authority.effects.includes(effect);
    return permitted ? task.checkAuthority(target, effect) : task.refusal("authority-denied");
  };
  return {
    ...task,
    checkAuthority: allowed,
    execute(work) {
      return task.execute({
        ...work,
        signal: AbortSignal.any([signal, work.signal]),
        checkAdmission: () =>
          allowed(work.target, work.unit.effect) ?? work.checkAdmission?.() ?? null,
        async run(signal, publish) {
          observe.started();
          let terminated = false;
          let effect: EffectCertainty = work.unit.effect === "observation" ? "none" : "uncertain";
          try {
            const result = await work.run(signal, publish);
            terminated = result.terminated;
            if (result.observedEffect !== undefined) effect = result.observedEffect;
            else if (terminated && work.target?.kind === "provider") effect = "completed";
            return result;
          } finally {
            observe.settled(effect, terminated);
          }
        },
      });
    },
    // Resource-only subdivision also preserves every ancestor ceiling.
    subdivide(limits: ResourceAmounts, identity) {
      const child = task.subdivide(limits, identity);
      return child ? guardResources(child, authority, signal, observe) : null;
    },
  };
}
