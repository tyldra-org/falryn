import { join } from "node:path";
import { createNativeActivation } from "../../application/extensions/native-activation.ts";
import {
  createNativeRegistrationPublisher,
  type NativePublication,
} from "../../application/extensions/native-registration.ts";
import { createNativeToolOwner } from "../../application/extensions/native-tool-owner.ts";
import { createPackageToolExecution } from "../../application/extensions/package-tool-execution.ts";
import { createPackageToolRecovery } from "../../application/extensions/package-tool-recovery.ts";
import type { CatalogRepositories } from "../../data/extensions/catalog-repositories.ts";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import { createExtensionCatalog } from "../../domain/extensions/catalog.ts";
import type { PackageRequest } from "../../domain/extensions/lifecycle.ts";
import {
  type NativeActivationStore,
  nativeActivationKey,
} from "../../domain/extensions/native-activation.ts";
import type { PackageHealthStore } from "../../domain/extensions/package-health.ts";
import { scopeControlDigest, scopeControlKey } from "../../domain/extensions/scope-controls.ts";
import type { ConfigurationGeneration } from "../../domain/foundation/index.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/index.ts";
import { createHostPackageProcess } from "../../integrations/extensions/host-package-health.ts";
import { createNativePackageContext } from "./native-package-context.ts";
import type { Services } from "./services.ts";

/** Compose the native owner with the same stores used by CLI lifecycle and metadata inspection. */
export function composeNativePackages(options: {
  services: Services;
  records: CatalogRepositories;
  activations: NativeActivationStore;
  processes: PackageHealthStore;
  session?: string;
}) {
  const context = createNativePackageContext(options);
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
      for (const contribution of intent.contributions)
        proofs.push(
          (await context.validate(control, installed.value, contribution, signal)).generation,
        );
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
        },
        inputs: canonicalDigest({
          proofs,
          catalog: captured.catalog.identity,
          control: scopeControlDigest(control),
        }),
        scopeRevision: control.revision,
      };
    },
  });
  let current: NativePublication | null = null;
  return {
    current: () => current,
    async close() {
      stopped.abort();
      await Promise.allSettled([...active]);
    },
    activate,
    recover: createPackageToolRecovery(options.processes, execution),
    async publish(generation: ConfigurationGeneration, signal: AbortSignal) {
      if (stopped.signal.aborted) throw new ExtensionInputError("native-host-closed");
      const captured = await context.registered(signal);
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
            if (current !== publication)
              return { status: "unavailable", reason: "stale-native-catalog", effect: "none" };
            const fresh = await context.capture(input.request.signal);
            if (fresh.catalog.identity !== captured.catalog.identity)
              return { status: "unavailable", reason: "stale-native-catalog", effect: "none" };
            const control = captured.controls.get(input.activation);
            const expected = [...captured.activations.values()].find(
              (activation) => canonicalDigest(activation) === input.activation,
            );
            if (!control || !expected)
              return {
                status: "unavailable",
                reason: "native-activation-unavailable",
                effect: "none",
              };
            const run = createPackageToolExecution({
              packages: options.records.packages,
              bytes: context.bytes,
              host: context.host,
              store: options.processes,
              execution,
              async authority(installed, contribution, signal) {
                const authority = await context.admission(control, installed, contribution, signal);
                const storedActivation = options.activations.get(nativeActivationKey(expected));
                const same =
                  storedActivation.ok &&
                  storedActivation.value !== null &&
                  canonicalDigest(storedActivation.value) === input.activation;
                return {
                  ...authority,
                  enabled:
                    authority.enabled &&
                    current === publication &&
                    same &&
                    (installed.packageId !== input.packageId ||
                      contribution === null ||
                      expected.contributions.includes(contribution)),
                  inputs: canonicalDigest({
                    authority: authority.inputs,
                    activation: storedActivation.ok ? storedActivation.value : null,
                  }),
                };
              },
            });
            return run(input);
          });
        },
      });
      const trustById = new Map<string, NonNullable<ReturnType<typeof captured.trust.get>>>();
      const publication = createNativeRegistrationPublisher([owner]).publish({
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
