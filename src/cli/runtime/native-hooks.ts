import { join } from "node:path";
import type { HookHttpPort } from "../../application/extensions/hook-http-port.ts";
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
import { httpHookContract } from "../../domain/extensions/hook-http.ts";
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
  http: HookHttpPort,
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
      handler: "external-command-v1" | "http-v1";
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
        // uninstall and stricter host policy revoke the owning execution generation. Losing
        // the command host revokes only command handlers.
        if (
          (generation.handler === "external-command-v1" && !host.available()) ||
          (current && (!current.enabled || current.trust !== "accepted")) ||
          (installed.ok && !installed.value.current)
        )
          generation.controller.abort();
      }
      return createNativeHookOwner({
        qualified: (handler) => handler === "http-v1" || host.available(),
        health: records.hookHealth,
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
              handler: input.handler,
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
              ...(input.handler === "http-v1"
                ? { declarationKind: "http-hook" as const }
                : { protocol: HOOK_COMMAND_PROTOCOL }),
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
            const wire = {
              version: 1 as const,
              invocationId: `${input.envelope.invocationId}:${input.envelope.phase}`,
              contribution: {
                packageId: input.packageId,
                contributionId: input.contribution,
                generation: Number(input.envelope.registrationGeneration),
              },
              envelope: input.envelope.catalog,
            };
            if (input.handler === "http-v1") {
              // Only the user's grant on this exact activation approves the endpoint.
              const grant = activation.grants?.find(
                (value) => value.contribution === input.contribution,
              );
              if (!grant) throw new HookExecutionError("hook-destination-unapproved");
              return http.run({
                registration: httpHookContract(admitted.declaration),
                grant,
                wire,
                context: { ...input.context, signal },
                current,
              });
            }
            return host.run({
              snapshot: admitted.snapshot,
              registration: hookCommandContract(admitted.declaration),
              context: { ...input.context, signal },
              current,
              wire,
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
