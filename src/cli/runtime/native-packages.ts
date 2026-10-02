import { join } from "node:path";
import { createNativeActivation } from "../../application/extensions/native-activation.ts";
import { createNativePromptOwner } from "../../application/extensions/native-prompt-owner.ts";
import {
  createNativeRegistrationPublisher,
  type NativePublication,
} from "../../application/extensions/native-registration.ts";
import { createNativeScheduleOwner } from "../../application/extensions/native-schedule-owner.ts";
import { createNativeToolOwner } from "../../application/extensions/native-tool-owner.ts";
import { createPackageExecutionAdmission } from "../../application/extensions/package-execution-admission.ts";
import { createPackageToolExecution } from "../../application/extensions/package-tool-execution.ts";
import { createPackageToolRecovery } from "../../application/extensions/package-tool-recovery.ts";
import type { CatalogRepositories } from "../../data/extensions/catalog-repositories.ts";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import { catalogEntryKey, createExtensionCatalog } from "../../domain/extensions/catalog.ts";
import {
  type HookGrantRequirement,
  hookGrantRequirement,
  hookGrantsProblem,
} from "../../domain/extensions/hook-grants.ts";
import type { PackageRequest } from "../../domain/extensions/lifecycle.ts";
import {
  type NativeActivationStore,
  nativeActivationKey,
} from "../../domain/extensions/native-activation.ts";
import type { PackageHealthStore } from "../../domain/extensions/package-health.ts";
import { scopeControlDigest, scopeControlKey } from "../../domain/extensions/scope-controls.ts";
import type { ConfigurationGeneration } from "../../domain/foundation/index.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/index.ts";
import { createHostHookHttp } from "../../integrations/extensions/host-hook-http.ts";
import { createHostPackageProcess } from "../../integrations/extensions/host-package-health.ts";
import { composeNativeHooks, type NativeHookSession } from "./native-hooks.ts";
import { createNativePackageContext } from "./native-package-context.ts";
import { composeHostProductCredentials } from "./product-credentials.ts";
import type { Services } from "./services.ts";

/** Compose the native owner with the same stores used by CLI lifecycle and metadata inspection. */
export function composeNativePackages(options: {
  services: Services;
  schedules?: Parameters<typeof createNativeScheduleOwner>[0];
  records: CatalogRepositories;
  activations: NativeActivationStore;
  processes: PackageHealthStore;
  session?: string;
}) {
  const context = createNativePackageContext(options);
  const hookOwner = composeNativeHooks(
    context,
    options.records,
    options.activations,
    createHostHookHttp({
      credentials: composeHostProductCredentials({
        clock: options.services.clock,
        environment: options.services.environment,
      }).resolver,
      ...(options.services.egress === undefined ? {} : { egress: options.services.egress }),
    }),
  );
  const stopped = new AbortController();
  const active = new Set<Promise<ToolInvocationOutcome>>();
  const track = async (run: () => Promise<ToolInvocationOutcome>) => {
    const pending = run();
    active.add(pending);
    try {
      return await pending;
    } finally {
      active.delete(pending);
    }
  };
  const execution = createHostPackageProcess({
    directory: join(context.root, "package-health"),
    policy: context.policy,
  });
  const activate = createNativeActivation({
    store: options.activations,
    async capture(request: PackageRequest, signal) {
      const intent = request.nativeActivation;
      if (!intent) throw new ExtensionInputError("native-activation-required");
      if (
        intent.scope === "session" ||
        intent.scope === "process" ||
        intent.scope === "development"
      )
        throw new ExtensionInputError("scope-requires-live-host");
      const captured = await context.capture(signal);
      const control = captured.controls.find(
        (value) =>
          value.package.packageId === request.packageId && value.authority.scope === intent.scope,
      );
      if (!control) throw new ExtensionInputError("native-scope-preference-required");
      const installed = options.records.packages.current(request.packageId);
      if (!installed.ok) throw new ExtensionInputError(installed.error.code);
      if (
        !installed.value.current ||
        installed.value.revision !== request.expectedRevision ||
        canonicalDigest(control.package) !== installed.value.current.identityDigest
      )
        throw new ExtensionInputError("stale-native-package");
      const proofs: string[] = [];
      const requirements: HookGrantRequirement[] = [];
      for (const contribution of intent.contributions) {
        const admitted = await context.validate(control, installed.value, contribution, signal);
        proofs.push(admitted.generation);
        const requirement = hookGrantRequirement(contribution, admitted.declaration);
        if (requirement !== null) requirements.push(requirement);
      }
      // Every HTTP or evaluator hook needs exactly one matching grant; nothing else may.
      const grants = [...(intent.grants ?? [])].sort((a, b) =>
        a.contribution < b.contribution ? -1 : 1,
      );
      const grantProblem = hookGrantsProblem(requirements, grants);
      return {
        record: {
          version: 1,
          actor: captured.authority.actor,
          scopeKey: scopeControlKey(control),
          scopeBinding: control.scopeBinding,
          authority: control.authority,
          package: installed.value.current.identityDigest,
          installedRevision: installed.value.revision,
          configuration: context.configuration(installed.value),
          contributions: [...intent.contributions].sort(),
          ...(grants.length > 0 ? { grants } : {}),
        },
        inputs: canonicalDigest({
          proofs,
          catalog: captured.catalog.identity,
          control: scopeControlDigest(control),
        }),
        scopeRevision: control.revision,
        requirements,
        grantProblem,
      };
    },
  });
  let current: NativePublication | null = null;
  return {
    current: () => current,
    async scheduleCurrent(
      source: { contribution: string; digest: string; scope: string },
      signal: AbortSignal,
    ) {
      const prior = current?.catalog.entries.find(
        (entry) => entry.binding?.actionId === source.contribution,
      );
      if (
        !prior ||
        prior.contribution.owner.digest !== source.digest ||
        prior.availability !== "available"
      )
        return false;
      const fresh = await context.registered(signal);
      const priorSource = prior.source;
      const entry = fresh.catalog.entries.find(
        (entry) =>
          canonicalDigest(entry.contribution) === canonicalDigest(prior.contribution) &&
          entry.source.kind === "package" &&
          priorSource.kind === "package" &&
          entry.source.activation.scope === priorSource.activation.scope &&
          entry.source.activation.scopeAuthorityId === priorSource.activation.scopeAuthorityId &&
          entry.source.activation.scopeAuthorityGeneration ===
            priorSource.activation.scopeAuthorityGeneration,
      );
      const activation = entry && fresh.activations.get(catalogEntryKey(entry));
      if (
        !entry?.enabled ||
        entry.lifecycle !== "current" ||
        entry.trust !== "accepted" ||
        !activation ||
        !activation.contributions.includes(canonicalDigest(entry.contribution)) ||
        canonicalDigest(activation.scopeKey) !== source.scope
      )
        return false;
      const control = fresh.controls.get(canonicalDigest(activation));
      if (!control) return false;
      const installed = options.records.packages.current(control.package.packageId);
      if (!installed.ok) return false;
      try {
        await context.validate(
          control,
          installed.value,
          canonicalDigest(entry.contribution),
          signal,
        );
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      stopped.abort();
      await hookOwner.close();
      await Promise.allSettled([...active]);
    },
    activate,
    recover: createPackageToolRecovery(options.processes, execution),
    /** Publish the current catalog; remote hooks bind to the session's runtimes, if any. */
    async publish(
      generation: ConfigurationGeneration,
      signal: AbortSignal,
      hooks?: NativeHookSession,
    ) {
      if (stopped.signal.aborted) throw new ExtensionInputError("native-host-closed");
      const captured = await context.registered(signal);
      /**
       * Why a changed catalog refuses this activation. When its own package lost trust, the call
       * states that shared reason, as discovery and standing do; any other change stays stale.
       */
      function changedCatalogReason(
        fresh: Awaited<ReturnType<typeof context.capture>>,
        activationDigest: string,
      ): string {
        const expected = [...captured.activations.values()].find(
          (activation) => canonicalDigest(activation) === activationDigest,
        );
        const lost =
          expected === undefined
            ? undefined
            : fresh.catalog.entries.find(
                (entry) =>
                  entry.source.kind === "package" &&
                  canonicalDigest(entry.source.owner) === expected.package &&
                  entry.trust !== "accepted",
              );
        return lost !== undefined &&
          (lost.reason.startsWith("ecosystem-") || lost.reason === "dependency-not-eligible")
          ? lost.reason
          : "stale-native-catalog";
      }
      /** Recheck the catalog and exact stored activation before any package bytes are used. */
      async function admittedActivation(activationDigest: string, signal: AbortSignal) {
        if (current !== publication) throw new ExtensionInputError("stale-native-catalog");
        const fresh = await context.capture(signal);
        if (fresh.catalog.identity !== captured.catalog.identity)
          throw new ExtensionInputError(changedCatalogReason(fresh, activationDigest));
        const control = captured.controls.get(activationDigest);
        const expected = [...captured.activations.values()].find(
          (activation) => canonicalDigest(activation) === activationDigest,
        );
        if (!control || !expected) throw new ExtensionInputError("native-activation-unavailable");
        return {
          async authority(
            installed: Parameters<typeof context.admission>[1],
            packageId: string,
            contribution: string | null,
            signal: AbortSignal,
          ) {
            const authority = await context.admission(control, installed, contribution, signal);
            const storedActivation = options.activations.get(nativeActivationKey(expected));
            const same =
              storedActivation.ok &&
              storedActivation.value !== null &&
              canonicalDigest(storedActivation.value) === activationDigest;
            return {
              ...authority,
              enabled:
                authority.enabled &&
                current === publication &&
                same &&
                (installed.packageId !== packageId ||
                  contribution === null ||
                  expected.contributions.includes(contribution)),
              inputs: canonicalDigest({
                authority: authority.inputs,
                activation: storedActivation.ok ? storedActivation.value : null,
              }),
            };
          },
        };
      }
      const owner = createNativeToolOwner({
        qualified: context.qualified,
        async execute(input) {
          if (stopped.signal.aborted)
            return { status: "unavailable", reason: "native-host-closed", effect: "none" };
          input = {
            ...input,
            request: {
              ...input.request,
              signal: AbortSignal.any([input.request.signal, stopped.signal]),
            },
          };
          return track(async () => {
            let admitted: Awaited<ReturnType<typeof admittedActivation>>;
            try {
              admitted = await admittedActivation(input.activation, input.request.signal);
            } catch (error) {
              if (!(error instanceof ExtensionInputError)) throw error;
              return { status: "unavailable", reason: error.code, effect: "none" };
            }
            const run = createPackageToolExecution({
              packages: options.records.packages,
              bytes: context.bytes,
              host: context.host,
              store: options.processes,
              execution,
              authority: (installed, contribution, signal) =>
                admitted.authority(installed, input.packageId, contribution, signal),
            });
            return run(input);
          });
        },
      });
      const prompts = createNativePromptOwner({
        async read(request, signal) {
          if (stopped.signal.aborted) throw new ExtensionInputError("native-host-closed");
          const readSignal = AbortSignal.any([signal, stopped.signal]);
          const admitted = await admittedActivation(request.activation, readSignal);
          const source = await createPackageExecutionAdmission({
            packages: options.records.packages,
            bytes: context.bytes,
            host: context.host,
            declarationKind: "prompt",
            authority: (installed, contribution, signal) =>
              admitted.authority(installed, request.packageId, contribution, signal),
          })(
            {
              packageId: request.packageId,
              expectedRevision: request.expectedRevision,
              contribution: request.contribution,
              requiredControls: [],
            },
            readSignal,
          );
          const file = source.snapshot.files.find((entry) => entry.path === request.path);
          if (!file) throw new ExtensionInputError("prompt-source-missing");
          if (current !== publication) throw new ExtensionInputError("stale-native-catalog");
          return file.bytes;
        },
      });
      const trustById = new Map<string, NonNullable<ReturnType<typeof captured.trust.get>>>();
      const publication = createNativeRegistrationPublisher([
        owner,
        hookOwner.owner(captured, hooks),
        createNativeScheduleOwner(options.schedules),
        prompts,
      ]).publish({
        catalog: createExtensionCatalog({
          generation: Math.max(captured.catalog.generation, (current?.catalog.generation ?? 0) + 1),
          inputs: captured.catalog.inputs,
          entries: captured.catalog.entries,
          signal,
        }),
        generation,
        packages: captured.packages,
        activations: captured.activations,
        signal,
        trust: { inspect: (id) => trustById.get(id) ?? null },
      });
      for (const entry of publication.catalog.entries) {
        const trust = captured.trust.get(entry.contribution.owner.digest);
        if (trust && entry.binding) trustById.set(entry.binding.actionId, trust);
      }
      current = publication;
      return publication;
    },
  };
}
