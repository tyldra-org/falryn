import { join } from "node:path";
import { createNativeHookOwner } from "../../application/extensions/native-hook-owner.ts";
import {
  createPackageExecutionAdmission,
  PackageAdmissionError,
} from "../../application/extensions/package-execution-admission.ts";
import { HookExecutionError } from "../../application/tools/tool-hook-invocation.ts";
import type { CatalogRepositories } from "../../data/extensions/catalog-repositories.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { catalogEntryKey } from "../../domain/extensions/catalog.ts";
import {
  HOOK_COMMAND_PROTOCOL,
  hookCommandContract,
} from "../../domain/extensions/hook-command-profile.ts";
import {
  type NativeActivationStore,
  nativeActivationKey,
} from "../../domain/extensions/native-activation.ts";
import { createHostHookCommand } from "../../integrations/extensions/host-hook-command.ts";
import type { createNativePackageContext } from "./native-package-context.ts";

type Context = ReturnType<typeof createNativePackageContext>;
export function composeNativeHooks(
  context: Context,
  records: CatalogRepositories,
  activations: NativeActivationStore,
) {
  const host = createHostHookCommand({
    directory: join(context.root, "hook-processes"),
    policy: context.policy,
  });
  const stopped = new AbortController();
  const generations = new Map<
    string,
    {
      controller: AbortController;
      users: number;
      packageId: string;
      scope: string;
      namespace: string;
      localId: string;
    }
  >();
  const running = new Set<Promise<unknown>>();
  return {
    async close() {
      stopped.abort();
      await Promise.allSettled([...running]);
    },
    owner(captured: Awaited<ReturnType<Context["registered"]>>) {
      const activeActivations = new Set(
        captured.catalog.entries
          .filter((entry) => entry.enabled)
          .flatMap((entry) => {
            const activation = captured.activations.get(catalogEntryKey(entry));
            return activation ? [canonicalDigest(activation)] : [];
          }),
      );
      for (const generation of generations.values()) {
        const current = captured.catalog.entries.find(
          (entry) =>
            entry.source.kind === "package" &&
            entry.source.owner.packageId === generation.packageId &&
            entry.source.activation.scopeAuthorityId === generation.scope &&
            entry.contribution.namespace === generation.namespace &&
            entry.contribution.localId === generation.localId,
        );
        const installed = records.packages.current(generation.packageId);
        // Replacement publication alone drains old work. Explicit disable, trust withdrawal,
        // uninstall and stricter host policy revoke the owning execution generation.
        if (
          !host.available() ||
          (current && (!current.enabled || current.trust !== "accepted")) ||
          (installed.ok && !installed.value.current)
        )
          generation.controller.abort();
      }
      return createNativeHookOwner({
        qualified: host.available,
        async execute(input) {
          const key = `${input.activation}:${input.contribution}`;
          let generation = generations.get(key);
          if (!generation) {
            const entry = captured.catalog.entries.find(
              (entry) => canonicalDigest(entry.contribution) === input.contribution,
            );
            if (entry?.source.kind !== "package")
              throw new HookExecutionError("hook-activation-unavailable");
            generation = {
              controller: new AbortController(),
              users: 0,
              packageId: input.packageId,
              scope: entry.source.activation.scopeAuthorityId,
              namespace: entry.contribution.namespace,
              localId: entry.contribution.localId,
            };
            generations.set(key, generation);
          }
          generation.users++;
          const signal = AbortSignal.any([
            input.context.signal,
            stopped.signal,
            generation.controller.signal,
          ]);
          const operation = (async () => {
            const control = captured.controls.get(input.activation);
            const activation = [...captured.activations.values()].find(
              (value) => canonicalDigest(value) === input.activation,
            );
            if (!control || !activation || !activeActivations.has(input.activation))
              throw new HookExecutionError("hook-activation-unavailable");
            const capture = createPackageExecutionAdmission({
              packages: records.packages,
              bytes: context.bytes,
              host: context.host,
              protocol: HOOK_COMMAND_PROTOCOL,
              async authority(installed, contribution, signal) {
                const authority = await context.admission(control, installed, contribution, signal);
                const current = activations.get(nativeActivationKey(activation));
                return {
                  ...authority,
                  enabled:
                    authority.enabled &&
                    current.ok &&
                    current.value !== null &&
                    canonicalDigest(current.value) === input.activation &&
                    !signal.aborted,
                };
              },
            });
            const request = {
              packageId: input.packageId,
              expectedRevision: input.expectedRevision,
              contribution: input.contribution,
              requiredControls: [],
            };
            const admitted = await capture(request, signal);
            const registration = hookCommandContract(admitted.declaration);
            const current = async () => {
              try {
                return (
                  !signal.aborted &&
                  (await capture(request, signal)).generation === admitted.generation
                );
              } catch {
                return false;
              }
            };
            return host.run({
              snapshot: admitted.snapshot,
              registration,
              context: { ...input.context, signal },
              current,
              wire: {
                version: 1,
                invocationId: `${input.envelope.invocationId}:${input.envelope.phase}`,
                contribution: {
                  packageId: input.packageId,
                  contributionId: input.contribution,
                  generation: Number(input.envelope.registrationGeneration),
                },
                envelope: input.envelope.catalog,
              },
            });
          })().catch((error: unknown) => {
            if (error instanceof PackageAdmissionError) throw new HookExecutionError(error.code);
            throw error;
          });
          running.add(operation);
          try {
            return await operation;
          } finally {
            running.delete(operation);
            generation.users--;
            if (!generation.users) generations.delete(key);
          }
        },
      });
    },
  };
}
