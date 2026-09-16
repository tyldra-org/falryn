import type { ConfigurationGenerationRecord } from "../../domain/configuration/index.ts";
import {
  applyEnvironmentEdits,
  type EnvironmentDelta,
  type EnvironmentEdits,
  type EnvironmentMap,
  environmentError,
  forbiddenEnvironmentName,
} from "../../domain/process/environment.ts";
import type { ProfileTransitionOwner } from "./transition-contracts.ts";

export type EnvironmentSource = {
  readonly identity: string;
  current(): Promise<boolean>;
  run(
    base: EnvironmentMap,
    signal: AbortSignal,
  ): Promise<
    | { readonly kind: "prepared"; readonly delta: EnvironmentDelta; readonly effects: "possible" }
    | {
        readonly kind: "failed";
        readonly code: string;
        readonly effects: "none" | "possible";
        readonly terminated?: boolean;
      }
  >;
};
export type EnvironmentStage = {
  readonly preparationNames?: readonly string[];
  readonly scope: "user" | "project" | "profile";
  readonly edits: EnvironmentEdits;
  readonly preparation?: {
    readonly required: boolean;
    readonly source: EnvironmentSource | null;
    readonly code?: string;
  };
};
export type EnvironmentPlan = {
  admit?(): void;
  activate?(): void;
  fresh?(): Promise<boolean>;
  readonly base: EnvironmentMap;
  readonly stages: readonly EnvironmentStage[];
  readonly operationNames: readonly string[];
  readonly separator: ":" | ";";
  /** Includes current policy and project trust; does not execute source. */
  current(signal?: AbortSignal): Promise<boolean>;
};
export type EnvironmentInspection = {
  readonly sources: readonly {
    readonly scope: EnvironmentStage["scope"];
    readonly identity: string | null;
    readonly required: boolean;
    readonly code: string;
  }[];
  readonly outdated: boolean;
  readonly ineligibleMappings: readonly string[];
  readonly state: "unavailable" | "active" | "degraded" | "blocked" | "closed";
  readonly generation: string | null;
  readonly configurationGeneration: number | null;
  readonly prepared: string | null;
  readonly code: string;
  readonly effects: "none" | "possible";
};
export type EnvironmentBinding = {
  readonly generation: string;
  /** Private values cross only the selected process consumer's boundary. */
  child(
    operation?: EnvironmentMap,
    accepts?: (name: string) => boolean,
    signal?: AbortSignal,
  ): Promise<EnvironmentMap | null>;
};

/** Safe extension seam emitted only inside an explicitly admitted preparation. */
export type EnvironmentPreparationEvent = {
  readonly kind: "environment.prepare.before" | "environment.prepare.after";
  readonly candidate: string;
  readonly scope: EnvironmentStage["scope"];
  readonly outcome: "pending" | "prepared" | "failed";
};

/** One session owns publication. Existing bindings retain their values, but recheck live authority. */
export function createScopedEnvironment(ports: {
  identity(): string;
  observe?(event: EnvironmentPreparationEvent): void;
  plan(record: ConfigurationGenerationRecord, signal: AbortSignal): Promise<EnvironmentPlan>;
}) {
  const sessionStop = new AbortController();
  let closed = false;
  let busy = false;
  let serial = 0;
  let active: EnvironmentBinding | null = null;
  let activePlan: EnvironmentPlan | null = null;
  let fact: EnvironmentInspection = {
    sources: [],
    outdated: false,
    ineligibleMappings: [],
    state: "unavailable",
    generation: null,
    configurationGeneration: null,
    prepared: null,
    code: "environment-not-prepared",
    effects: "none",
  };
  const fail = (code: string, terminated = true) => {
    fact = { ...fact, state: closed ? "closed" : "blocked", prepared: null, code };
    return {
      kind: "refused" as const,
      code,
      terminated,
      observedEffect: fact.effects === "possible" ? ("uncertain" as const) : ("none" as const),
    };
  };
  const owner: ProfileTransitionOwner = {
    id: "scoped-environment",
    describe: () => ({
      owner: "scoped-environment",
      required: true,
      availability: "available",
      applicationClass: "next-operation",
      preparation: "local",
      cost: "none",
      bufferedBytes: 1024 * 1024,
    }),
    async inspect(generation) {
      return {
        state:
          fact.configurationGeneration === generation &&
          (fact.state === "active" || fact.state === "degraded")
            ? "applied"
            : "failed",
        generation: fact.configurationGeneration,
        code: fact.code,
      };
    },
    async prepare(candidate, _resources, callerSignal) {
      const signal = AbortSignal.any([callerSignal, sessionStop.signal]);
      if (closed || busy)
        return { kind: "refused", code: closed ? "environment-closed" : "environment-busy" };
      busy = true;
      const attempt = ++serial;
      const identity = ports.identity();
      let terminated = true;
      fact = { ...fact, prepared: identity, effects: "none" };
      const cancelled = () => {
        if (attempt === serial) fail("environment-cancelled");
      };
      signal.addEventListener("abort", cancelled, { once: true });
      try {
        if (signal.aborted) return fail("environment-cancelled");
        const plan = candidate.environmentPlan ?? (await ports.plan(candidate.record, signal));
        fact = {
          ...fact,
          sources: plan.stages.flatMap((stage) =>
            stage.preparation
              ? [
                  {
                    scope: stage.scope,
                    identity: stage.preparation.source?.identity ?? null,
                    required: stage.preparation.required,
                    code: stage.preparation.code ?? "preparation-pending",
                  },
                ]
              : [],
          ),
        };
        plan.admit?.();
        if (signal.aborted || !(await plan.current(signal)))
          return fail("environment-authority-changed");
        let values = { ...plan.base };
        let degraded = false;
        const sources: EnvironmentSource[] = [];
        let userDelta: EnvironmentDelta | null = null;
        for (const stage of plan.stages) {
          if (signal.aborted || !(await plan.current(signal)))
            return fail("environment-authority-changed");
          if (stage.preparation) {
            ports.observe?.({
              kind: "environment.prepare.before",
              candidate: identity,
              scope: stage.scope,
              outcome: "pending",
            });
            const source = stage.preparation.source;
            // Cancellation may settle before the child returns its receipt.
            if (source) fact = { ...fact, effects: "possible" };
            const result: Awaited<ReturnType<EnvironmentSource["run"]>> = source
              ? await source.run(
                  Object.freeze(
                    Object.fromEntries(
                      Object.entries(values).filter(
                        ([name]) =>
                          !stage.preparationNames || stage.preparationNames.includes(name),
                      ),
                    ),
                  ),
                  signal,
                )
              : {
                  kind: "failed" as const,
                  code: stage.preparation.code ?? "environment-source-unavailable",
                  effects: "none" as const,
                };
            fact = {
              ...fact,
              sources: fact.sources.map((entry) =>
                entry.scope === stage.scope
                  ? { ...entry, code: result.kind === "prepared" ? "prepared" : result.code }
                  : entry,
              ),
            };
            if (result.effects === "possible") fact = { ...fact, effects: "possible" };
            ports.observe?.({
              kind: "environment.prepare.after",
              candidate: identity,
              scope: stage.scope,
              outcome: result.kind,
            });
            if (result.kind === "failed") {
              if (result.terminated === false) terminated = false;
              if (stage.preparation.required || !terminated) return fail(result.code, terminated);
              degraded = true;
            } else {
              if (stage.scope === "user") userDelta = result.delta;
              sources.push(source as EnvironmentSource);
              values = applyEnvironmentEdits(
                values,
                { set: { ...result.delta.set }, unset: [...result.delta.unset] },
                plan.separator,
              );
            }
          }
          values = applyEnvironmentEdits(values, stage.edits, plan.separator);
        }
        for (const key of Object.keys(values))
          if (forbiddenEnvironmentName(key)) delete values[key];
        const invalid = environmentError(values, plan.separator === ";");
        if (invalid) return fail(invalid);
        if (userDelta && candidate.projectEnvironment) {
          const projected = await candidate.projectEnvironment(userDelta, signal);
          fact = { ...fact, ineligibleMappings: projected.ineligibleMappings };
          if (!projected.accepted) return fail("environment-configuration-projection-failed");
        }
        const ready = Object.freeze(values);
        const current = async (abort?: AbortSignal) =>
          !closed && !abort?.aborted && (await plan.current(abort));
        const next: EnvironmentBinding = Object.freeze({
          generation: identity,
          async child(
            operation: EnvironmentMap = {},
            accepts = (_name: string) => true,
            abort?: AbortSignal,
          ) {
            if (!(await current(abort))) return null;
            if (
              Object.keys(operation).some(
                (key) => !plan.operationNames.includes(key) || forbiddenEnvironmentName(key),
              )
            )
              return null;
            const child = Object.fromEntries(
              Object.entries({ ...ready, ...operation }).filter(
                ([key]) => accepts(key) && !forbiddenEnvironmentName(key),
              ),
            );
            return environmentError(child, plan.separator === ";") ? null : Object.freeze(child);
          },
        });
        let released = false;
        return {
          terminated,
          observedEffect: fact.effects === "possible" ? "uncertain" : "none",
          validate: async (abort) => {
            const valid =
              !released &&
              attempt === serial &&
              (await current(abort)) &&
              (!plan.fresh || (await plan.fresh())) &&
              (await Promise.all(sources.map((source) => source.current()))).every(Boolean);
            if (!valid && attempt === serial) fail("environment-preparation-stale");
            return valid;
          },
          async release() {
            released = true;
            if (attempt === serial) {
              fact = { ...fact, prepared: null };
              if (
                plan.stages.some((stage) => stage.preparation?.required) &&
                fact.state !== "blocked"
              )
                fail("environment-candidate-discarded");
            }
          },
          async acknowledge(generation, authority, abort) {
            if (
              released ||
              attempt !== serial ||
              !authority() ||
              !(await current(abort)) ||
              (plan.fresh && !(await plan.fresh())) ||
              !(await Promise.all(sources.map((source) => source.current()))).every(Boolean)
            ) {
              if (attempt === serial) fail("environment-publication-stale");
              return { state: "failed", generation: null, code: "environment-publication-stale" };
            }
            plan.activate?.();
            active = next;
            activePlan = plan;
            fact = {
              sources: fact.sources,
              outdated: false,
              ineligibleMappings: fact.ineligibleMappings,
              state: degraded ? "degraded" : "active",
              generation: identity,
              configurationGeneration: generation,
              prepared: null,
              code: degraded ? "optional-preparation-omitted" : "environment-applied",
              effects: fact.effects,
            };
            return { state: "applied", generation, code: fact.code };
          },
        };
      } catch {
        return fail(signal.aborted ? "environment-cancelled" : "environment-preparation-failed");
      } finally {
        signal.removeEventListener("abort", cancelled);
        busy = false;
      }
    },
  };
  return {
    owner,
    async inspect(): Promise<EnvironmentInspection> {
      const selected = activePlan;
      const authorized = selected ? await selected.current() : true;
      const outdated = selected?.fresh ? !(await selected.fresh()) : false;
      if (selected === activePlan) {
        fact = { ...fact, outdated };
        if (!authorized && !closed) fail("environment-authority-changed");
      }
      return { ...fact };
    },
    capture: () => (closed || fact.state === "blocked" ? null : active),
    close() {
      closed = true;
      sessionStop.abort();
      serial++;
      active = null;
      fact = { ...fact, state: "closed", prepared: null };
    },
  };
}
