import { createHash, randomUUID } from "node:crypto";
import {
  createProfileTransitions,
  type ProfileTransitionOwner,
  type ProfileTransitionScope,
} from "../../application/configuration/index.ts";
import type { ProductTaskResources } from "../../application/orchestration/product-resources.ts";
import type { TurnEventJournal } from "../../application/runtime/turn-event-journal.ts";
import { inspectGeneration } from "../../config/index.ts";
import type { LoadRequest } from "../../config/resolution/loader.ts";
import type { ConfigurationGenerationRecord } from "../../domain/configuration/index.ts";
import { configurationGeneration } from "../../domain/foundation/index.ts";
import type { SessionCorrelation } from "../../domain/sessions/index.ts";
import type { ProductConfigurationLoadRequest } from "./product-configuration.ts";
import type { Services } from "./services.ts";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Revision token is opaque; callers do not need private source locations to perform CAS. */
export function profileSourceRevision(record: ConfigurationGenerationRecord | null): string {
  return digest(record?.sources ?? []);
}

/** One session's host adapter. The graph must own this session's independent loader. */
export function composeProductProfileTransitions(options: {
  readonly graph: Services;
  readonly scope: ProfileTransitionScope;
  readonly request: ProductConfigurationLoadRequest;
  readonly resources: ProductTaskResources;
  readonly journal: TurnEventJournal;
  readonly correlation: SessionCorrelation;
  readonly owners: readonly ProfileTransitionOwner[];
  readonly preserveSelection?: boolean;
  readonly environment?: Pick<
    ReturnType<typeof import("./scoped-environment.ts").productScopedEnvironment>,
    "plan"
  >;
  readonly policyRevision: () => string;
  readonly authorize: Parameters<typeof createProfileTransitions>[0]["authorize"];
}) {
  const { graph } = options;
  const current = () => ({
    profile: graph.loader.current()?.workingProfile?.id ?? null,
    generation: Number(graph.loader.current()?.generation ?? 0),
    sources: profileSourceRevision(graph.loader.current()),
    policy: options.policyRevision(),
  });
  const transitions = createProfileTransitions({
    scope: options.scope,
    owners: options.owners,
    resources: options.resources,
    deadlineMs: Math.max(
      1,
      Math.floor(Math.min(30_000, options.resources.remaining("wallTimeMs"))),
    ),
    maxOwners: 64,
    current,
    authorize: options.authorize,
    newIdentity: randomUUID,
    async resolve(profile, signal) {
      const project = await graph.workspaceTrust.project(signal);
      const projectRevision = digest(project);
      let loadRequest: LoadRequest = {
        configurationRoot: graph.configurationRoot,
        legacyConfigurationRoot: graph.legacyConfigurationRoot,
        workspaceRoot: graph.workspaceRoot,
        profile: options.preserveSelection ? options.request.profile : profile,
        ...(options.preserveSelection &&
        graph.loader.current()?.workingProfile?.selectedBy === "workspace"
          ? { workspaceProfile: graph.loader.current()?.workingProfile?.id ?? null }
          : {}),
        overrides: options.request.overrides,
        projectText: project.text,
        privateProjectText: project.privateText ?? null,
      };
      const initial = await graph.loader.preview(loadRequest, signal);
      if (initial.kind !== "candidate" && initial.kind !== "unchanged")
        return {
          kind: "refused",
          code: initial.kind === "publish-failed" ? initial.code : `configuration-${initial.kind}`,
        };
      let loaded = initial;
      let environmentPlan:
        | import("../../application/configuration/scoped-environment.ts").EnvironmentPlan
        | undefined;
      try {
        environmentPlan = await options.environment?.plan(initial.record, signal);
      } catch {
        return { kind: "refused", code: "environment-plan-unavailable" };
      }
      const validate = async (abort: AbortSignal) => {
        if (abort.aborted || digest(await graph.workspaceTrust.project(abort)) !== projectRevision)
          return false;
        if (environmentPlan?.fresh && !(await environmentPlan.fresh())) return false;
        // Re-read even an unchanged candidate: selecting the current profile is
        // still a review of exact source, package and environment facts.
        const observed = await graph.loader.preview(loadRequest, abort);
        return (
          (observed.kind === "candidate" || observed.kind === "unchanged") &&
          digest(observed.record) === digest(loaded.record)
        );
      };
      return {
        ...(environmentPlan ? { environmentPlan } : {}),
        get record() {
          return loaded.record;
        },
        get changes() {
          return loaded.kind === "candidate" ? loaded.changes : [];
        },
        get inspection() {
          return loaded.kind === "candidate"
            ? loaded.inspection
            : inspectGeneration(graph.registry, loaded.record);
        },
        async projectEnvironment(delta, abort) {
          const mapped = new Map(
            graph.registry
              .keys()
              .flatMap((key) =>
                key.environmentVariable ? [[key.environmentVariable, key] as const] : [],
              ),
          );
          const declared = [...Object.keys(delta.set), ...delta.unset];
          const eligible = new Set(
            declared.filter((name) => {
              const key = mapped.get(name);
              // These runtime owners can apply imported settings without changing bootstrap authority.
              return (
                key &&
                (String(key.path).startsWith("diagnostics.") ||
                  String(key.path).startsWith("interface."))
              );
            }),
          );
          const ineligibleMappings = declared.filter(
            (name) => mapped.has(name) && !eligible.has(name),
          );
          loadRequest = {
            ...loadRequest,
            preparedEnvironment: {
              get(name) {
                if (!eligible.has(name)) return graph.environment.get(name);
                return delta.unset.includes(name) ? null : delta.set[name] || null;
              },
            },
          };
          const projected = await graph.loader.preview(loadRequest, abort);
          if (projected.kind !== "candidate" && projected.kind !== "unchanged")
            return { accepted: false, ineligibleMappings };
          loaded = projected;
          return { accepted: true, ineligibleMappings };
        },
        sourceRevision: profileSourceRevision(loaded.record),
        effectiveInputChanged:
          loaded.kind === "candidate" &&
          loaded.changes.some(
            (change) =>
              !String(change.path).startsWith("diagnostics.") &&
              !String(change.path).startsWith("interface."),
          ),
        validate,
        async publish(abort, current) {
          if (!(await validate(abort)) || !current()) return null;
          const outcome =
            loaded.kind === "candidate" ? await loaded.publish(abort, current) : loaded;
          return outcome.kind === "published" || outcome.kind === "unchanged"
            ? Number(outcome.record.generation)
            : null;
        },
      };
    },
    async record(receipt) {
      const result = await options.journal.persist([
        {
          kind: "configuration.transition.recorded",
          correlation: {
            ...options.correlation,
            configurationGeneration: configurationGeneration.from(
              receipt.publishedGeneration ?? receipt.previousGeneration,
            ),
          },
          payload: receipt,
        },
      ]);
      return result.kind === "persisted";
    },
    async recover() {
      const replay = await options.journal.replay();
      if (replay.kind === "empty") return null;
      if (replay.kind !== "rebuilt") throw new Error("profile-recovery-unavailable");
      const last = replay.events.findLast(
        (event) => event.kind === "configuration.transition.recorded",
      );
      return last?.kind === "configuration.transition.recorded" ? last.payload : null;
    },
  });
  return { transitions, current };
}
