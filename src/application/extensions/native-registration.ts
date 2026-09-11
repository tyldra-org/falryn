import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import {
  CATALOG_LIMITS,
  type CatalogEntry,
  catalogEntryKey,
  createExtensionCatalog,
  type ExtensionCatalog,
} from "../../domain/extensions/catalog.ts";
import type {
  CapabilityBindingV1,
  ContributionIdentityV1,
} from "../../domain/extensions/identity.ts";
import type { NativeActivation } from "../../domain/extensions/native-activation.ts";
import type { ConfigurationGeneration } from "../../domain/foundation/index.ts";
import { createToolRegistry, type ToolRegistryEntry } from "../../domain/tools/index.ts";
import type { ToolRunnerPort } from "../runtime/tool-call-loop.ts";
import type { ProductToolSourceBundle } from "../tools/product-tools-merge.ts";
import type { CapabilityTrustPort } from "./capability-trust.ts";
import type { PreparedContribution, PreparedPackage } from "./prepare-package.ts";

export type NativeRegistrationContext = {
  entry: CatalogEntry;
  contribution: PreparedContribution;
  activation: NativeActivation;
  generation: ConfigurationGeneration;
};
export type NativeRegistration =
  | { status: "unavailable"; reason: string }
  | {
      status: "registered";
      binding: CapabilityBindingV1;
      tool?: { entry: ToolRegistryEntry; runner: ToolRunnerPort };
    };
/** Native owners validate their own codec and runner. Registration must start no package code. */
export interface NativeRegistrationOwner {
  id: string;
  kind: ContributionIdentityV1["nativeKind"];
  register(input: NativeRegistrationContext): NativeRegistration;
}
export type NativePublication = { catalog: ExtensionCatalog; tools: ProductToolSourceBundle };

/** All owners stage into one candidate. A failed candidate never replaces the prior publication. */
export function createNativeRegistrationPublisher(owners: readonly NativeRegistrationOwner[]) {
  const kinds = new Map(owners.map((owner) => [owner.kind, owner]));
  if (
    kinds.size !== owners.length ||
    new Set(owners.map((owner) => owner.id)).size !== owners.length
  )
    throw new ExtensionInputError("duplicate-native-owner");
  let current: NativePublication | null = null;
  return {
    current: () => current,
    publish(input: {
      catalog: ExtensionCatalog;
      generation: ConfigurationGeneration;
      packages: ReadonlyMap<string, PreparedPackage>;
      activations: ReadonlyMap<string, NativeActivation>;
      trust: CapabilityTrustPort;
      signal: AbortSignal;
    }): NativePublication {
      const started = performance.now();
      const check = () => {
        if (input.signal.aborted) throw new ExtensionInputError("cancelled");
        if (performance.now() - started > CATALOG_LIMITS.deadlineMs)
          throw new ExtensionInputError("native-publication-timeout");
      };
      check();
      const publicationInputs = canonicalDigest({
        metadata: input.catalog.identity,
        activations: [...input.activations.values()].map(canonicalDigest).sort(),
        owners: owners.map(({ id, kind }) => ({ id, kind })),
        generation: input.generation,
      });
      const publicationGeneration = Math.max(
        input.catalog.generation,
        (current?.catalog.generation ?? 0) + 1,
      );
      const registrations = new Map<
        string,
        Extract<NativeRegistration, { status: "registered" }>
      >();
      const entries = input.catalog.entries.map((entry): CatalogEntry => {
        check();
        if (entry.source.kind === "package" && entry.binding !== null)
          throw new ExtensionInputError("native-input-already-bound");
        if (
          entry.source.kind !== "package" ||
          !entry.enabled ||
          entry.lifecycle !== "current" ||
          entry.trust !== "accepted" ||
          entry.compatibility !== "compatible"
        )
          return entry;
        const activation = input.activations.get(catalogEntryKey(entry));
        const contribution = input.packages
          .get(entry.contribution.owner.digest)
          ?.contributions.find(
            (value) => value.identityDigest === canonicalDigest(entry.contribution),
          );
        if (!activation?.contributions.includes(canonicalDigest(entry.contribution)))
          return { ...entry, reason: "native-activation-required" };
        if (
          activation.package !== entry.contribution.owner.digest ||
          activation.authority.scope !== entry.source.activation.scope ||
          activation.authority.id !== entry.source.activation.scopeAuthorityId ||
          activation.authority.generation !== entry.source.activation.scopeAuthorityGeneration
        )
          throw new ExtensionInputError("native-activation-identity-mismatch");
        if (!contribution) throw new ExtensionInputError("native-descriptor-missing");
        const owner = kinds.get(contribution.identity.nativeKind);
        if (!owner) return { ...entry, reason: "native-owner-unavailable" };
        const candidate: CatalogEntry = {
          ...entry,
          source: {
            ...entry.source,
            activation: {
              ...entry.source.activation,
              activationRevision: activation.revision,
              catalogGeneration: publicationGeneration,
              configurationGeneration: Number(input.generation),
            },
          },
        };
        const registered = owner.register({
          entry: candidate,
          contribution,
          activation,
          generation: input.generation,
        });
        if (registered.status === "unavailable") return { ...candidate, reason: registered.reason };
        if (
          registered.binding.nativeRegistryOwner !== owner.id ||
          registered.binding.nativeRegistryGeneration !== Number(input.generation) ||
          (entry.contribution.nativeKind === "tool" && registered.tool === undefined) ||
          (registered.tool !== undefined &&
            registered.tool.runner.hasBinding?.(registered.tool.entry.manifest.capabilityId) !== true) ||
          (registered.tool !== undefined &&
            (entry.contribution.nativeKind !== "tool" ||
              registered.tool.entry.manifest.capabilityId !== registered.binding.actionId))
        )
          throw new ExtensionInputError("native-owner-binding-mismatch");
        registrations.set(catalogEntryKey(candidate), registered);
        return {
          ...candidate,
          availability: "available",
          reason: "native-owner-bound",
          binding: registered.binding,
        };
      });
      // Resolve dependencies within the exact package scope, never another activation.
      const scopeKey = (entry: CatalogEntry) =>
        canonicalDigest({
          package: entry.contribution.owner.digest,
          scope:
            entry.source.kind === "package"
              ? {
                  scope: entry.source.activation.scope,
                  id: entry.source.activation.scopeAuthorityId,
                  generation: entry.source.activation.scopeAuthorityGeneration,
                }
              : entry.source,
        });
      const localKey = (entry: CatalogEntry) =>
        `${entry.contribution.nativeKind}/${entry.contribution.namespace}/${entry.contribution.localId}`;
      const indices = new Map(
        entries.map((entry, i) => [`${scopeKey(entry)}:${localKey(entry)}`, i]),
      );
      const dependents = new Map<number, number[]>();
      const unavailable = entries.flatMap((entry, i) =>
        entry.availability === "available" ? [] : [i],
      );
      const disable = (index: number) => {
        const entry = entries[index];
        if (entry?.availability !== "available") return;
        registrations.delete(catalogEntryKey(entry));
        entries[index] = {
          ...entry,
          availability: "unavailable",
          reason: "native-dependency-unavailable",
          binding: null,
        };
        unavailable.push(index);
      };
      for (const [index, entry] of entries.entries()) {
        check();
        const declaration = input.packages
          .get(entry.contribution.owner.digest)
          ?.falryn.contributions.find(
            (value) => `${value.kind}/${value.namespace}/${value.id}` === localKey(entry),
          );
        for (const id of declaration?.dependencies ?? []) {
          const key =
            id.split("/").length === 3
              ? id
              : `${declaration?.kind}/${id.includes("/") ? id : `${declaration?.namespace}/${id}`}`;
          const dependency = indices.get(`${scopeKey(entry)}:${key}`);
          if (dependency === undefined) disable(index);
          else dependents.set(dependency, [...(dependents.get(dependency) ?? []), index]);
        }
      }
      for (let cursor = 0; cursor < unavailable.length; cursor++) {
        check();
        for (const dependent of dependents.get(unavailable[cursor] ?? -1) ?? []) disable(dependent);
      }
      const catalog = createExtensionCatalog({
        generation: publicationGeneration,
        inputs: publicationInputs,
        entries,
        signal: input.signal,
      });
      const tools = [...registrations.values()].flatMap((value) =>
        value.tool ? [value.tool] : [],
      );
      const registry = createToolRegistry(
        input.generation,
        tools.map((tool) => tool.entry),
      );
      if (!registry.ok) throw new ExtensionInputError(`native-tool-${registry.error.code}`);
      const runners = new Map(tools.map((tool) => [tool.entry.manifest.capabilityId, tool.runner]));
      const families = new Map(
        [...registrations.values()].flatMap((value) =>
          value.tool
            ? [[value.tool.entry.manifest.capabilityId, value.binding.family] as const]
            : [],
        ),
      );
      const candidate: NativePublication = {
        catalog,
        tools: {
          registry: registry.value,
          catalog: registry.value.catalog,
          toolNames: tools.map((tool) => tool.entry.manifest.name),
          families,
          explicitOnly: new Set(
            tools
              .filter((tool) =>
                catalog.entries.some(
                  (entry) =>
                    entry.explicitOnly &&
                    entry.binding?.actionId === tool.entry.manifest.capabilityId,
                ),
              )
              .map((tool) => tool.entry.manifest.capabilityId),
          ),
          trust: input.trust,
          runner: {
            hasBinding: (id) => runners.get(id)?.hasBinding?.(id) === true,
            execute: (request) =>
              runners.get(request.capabilityId)?.execute(request) ??
              Promise.resolve({
                status: "unavailable",
                reason: "native-binding-unavailable",
                effect: "none",
              }),
          },
        },
      };
      if (input.signal.aborted) throw new ExtensionInputError("cancelled");
      current = candidate;
      return candidate;
    },
  };
}
