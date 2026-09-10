/** Preview and commit local choices. No native registry, credentials, process or model port exists here. */
import { z } from "zod";
import {
  bytesDigest,
  canonicalDigest,
  ExtensionInputError,
  freezeMetadata,
  packageRelativePath,
} from "../../domain/extensions/canonical.ts";
import { CATALOG_LIMITS } from "../../domain/extensions/catalog.ts";
import { digestSchema, generationSchema, identityText } from "../../domain/extensions/identity.ts";
import type {
  InstalledVersion,
  PackageBytes,
  PackageLifecycleStore,
} from "../../domain/extensions/lifecycle.ts";
import type { PackageSnapshot } from "../../domain/extensions/package-source.ts";
import {
  type CompactContribution,
  compactContributionSchema,
  type ScopeControl,
  type ScopeControlStore,
  type ScopeReceipt,
  scopeAuthoritySchema,
  scopeControlDigest,
  scopeControlKey,
  scopeControlSchema,
  scopeRequestSchema,
} from "../../domain/extensions/scope-controls.ts";
import type { Result } from "../../domain/foundation/result.ts";
import { type InspectionHost, type PreparedPackage, preparePackage } from "./prepare-package.ts";

export const scopeContextSchema = z.strictObject({
  actor: digestSchema,
  authority: scopeAuthoritySchema,
  scopeBinding: digestSchema,
  configurationGeneration: generationSchema,
  /** Includes current trust and policy inputs. This is not a portable grant. */
  inputs: digestSchema,
  admitted: z.boolean(),
  /** Untrusted package state permits only narrowing an existing exact choice. */
  narrowingOnly: z.boolean(),
});
export type ScopeContext = z.infer<typeof scopeContextSchema>;
export type ScopeChangeResult =
  | { readonly status: "failed"; readonly code: string }
  | {
      readonly status: "preview" | "applied";
      readonly receipt: ScopeReceipt;
      readonly replayed: boolean;
    };

/** Only compact identity and classification fields survive initial descriptor inspection. */
export function compactPackageContributions(
  prepared: PreparedPackage,
): readonly CompactContribution[] {
  return freezeMetadata(
    prepared.contributions.map((entry) => {
      const aliases = z.array(identityText).safeParse(entry.declaration.aliases ?? []);
      if (!aliases.success) throw new ExtensionInputError("invalid-contribution-aliases");
      const compact = compactContributionSchema.safeParse({
        identity: entry.identity,
        aliases: [...new Set([entry.identity.localId, ...aliases.data])],
        family: entry.family,
        effects: entry.authority.effects,
        compatibility: entry.compatibility,
      });
      if (!compact.success) throw new ExtensionInputError("compact-contribution-limit");
      if (new Set(compact.data.aliases).size !== compact.data.aliases.length)
        throw new ExtensionInputError("duplicate-contribution-alias");
      return compact.data;
    }),
  );
}

/** Integrity rechecks hash bytes without decoding instruction or schema bodies. */
export function retainedPackageMatches(
  version: InstalledVersion,
  snapshot: PackageSnapshot,
): boolean {
  if (
    snapshot.sourceId !== version.sourceId ||
    snapshot.files.length !== version.fileCount ||
    snapshot.files.length > 4_096 ||
    snapshot.diagnostics.length > 0 ||
    snapshot.omittedDiagnostics > 0
  )
    return false;
  let total = 0;
  const paths = new Set<string>();
  const inventory = [];
  for (const file of snapshot.files) {
    const path = packageRelativePath(file.path);
    total += file.bytes.length;
    if (
      path === null ||
      path !== file.path ||
      paths.has(path) ||
      file.bytes.length > 16_777_216 ||
      total > 67_108_864
    )
      return false;
    paths.add(path);
    inventory.push({ path, digest: bytesDigest(file.bytes) });
  }
  inventory.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return (
    total === version.byteLength &&
    canonicalDigest(snapshot.ownership ?? { sourceOwner: null, publisher: null }) ===
      canonicalDigest(version.ownership) &&
    canonicalDigest({ version: 1, files: inventory }) === version.identity.packageDigest
  );
}

function requireValue<T>(result: Result<T, { readonly code: string }>): T {
  if (!result.ok) throw new ExtensionInputError(result.error.code);
  return result.value;
}

export function createExtensionScopeControls(options: {
  readonly store: ScopeControlStore;
  readonly packages: PackageLifecycleStore;
  readonly bytes: PackageBytes;
  readonly host: InspectionHost;
  /** Supplied by the CLI/session host, never by serialized request or package metadata. */
  readonly context: (signal: AbortSignal) => Promise<ScopeContext>;
}) {
  return {
    async change(
      packageId: string,
      input: unknown,
      signal: AbortSignal,
    ): Promise<ScopeChangeResult> {
      const deadline = AbortSignal.timeout(CATALOG_LIMITS.deadlineMs);
      const bounded = AbortSignal.any([signal, deadline]);
      let publicationAttempted = false;
      const guard = () => {
        if (signal.aborted) throw new ExtensionInputError("cancelled");
        if (deadline.aborted) throw new ExtensionInputError("scope-deadline");
      };
      try {
        guard();
        identityText.parse(packageId);
        const request = scopeRequestSchema.parse(input);
        const context = scopeContextSchema.parse(await options.context(bounded));
        const { confirmation: supplied, ...intent } = request;
        const fingerprint = canonicalDigest({
          packageId,
          actor: context.actor,
          scope: context.authority.scope,
          authority: context.authority.id,
          intent,
        });
        const previousOperation = requireValue(options.store.operation(request.operationId));
        if (previousOperation !== null) {
          if (
            previousOperation.fingerprint !== fingerprint ||
            (supplied !== undefined && previousOperation.confirmation !== supplied)
          )
            throw new ExtensionInputError("scope-operation-conflict");
          return { status: "applied", receipt: previousOperation, replayed: true };
        }
        if (!context.admitted) throw new ExtensionInputError("scope-authority-unavailable");
        const installed = requireValue(options.packages.current(packageId));
        const version = installed.current;
        if (version === null || version.identityDigest !== request.packageIdentity)
          throw new ExtensionInputError("exact-package-unavailable");
        const key = scopeControlKey({
          actor: context.actor,
          authority: context.authority,
          package: version.identity,
        });
        const previous = requireValue(options.store.get(key));
        if ((previous?.revision ?? 0) !== request.expectedRevision)
          throw new ExtensionInputError("stale-scope-revision");
        const priorChoice =
          request.contribution === undefined
            ? previous?.choice
            : (previous?.overrides.find((entry) => entry.contribution === request.contribution)
                ?.choice ?? previous?.choice);
        if (
          context.narrowingOnly &&
          (priorChoice === undefined ||
            request.choice.enabled ||
            request.choice.preferred ||
            (priorChoice.explicitOnly && !request.choice.explicitOnly))
        )
          throw new ExtensionInputError("scope-package-admission-required");
        const snapshot = await options.bytes.read(version, bounded);
        if (!retainedPackageMatches(version, snapshot))
          throw new ExtensionInputError("package-bytes-changed");
        const prepared = await preparePackage({ read: async () => snapshot }, options.host, {
          candidates: version.dependencies,
          signal: bounded,
        });
        if (!prepared.ok) throw new ExtensionInputError(prepared.code);
        if (prepared.package.identityDigest !== request.packageIdentity)
          throw new ExtensionInputError("package-identity-changed");
        if (
          prepared.package.falryn.scopes.length > 0 &&
          !prepared.package.falryn.scopes.includes(context.authority.scope)
        )
          throw new ExtensionInputError("scope-not-declared");
        const contributions = compactPackageContributions(prepared.package);
        if (
          request.contribution !== undefined &&
          !contributions.some((entry) => canonicalDigest(entry.identity) === request.contribution)
        )
          throw new ExtensionInputError("exact-contribution-unavailable");
        const choice =
          request.contribution === undefined
            ? request.choice
            : (previous?.choice ?? { enabled: false, preferred: false, explicitOnly: false });
        const overrides =
          previous?.overrides.filter((entry) => entry.contribution !== request.contribution) ?? [];
        if (request.contribution !== undefined)
          overrides.push({ contribution: request.contribution, choice: request.choice });
        const control: ScopeControl = scopeControlSchema.parse({
          version: 1,
          actor: context.actor,
          authority: context.authority,
          scopeBinding: context.scopeBinding,
          package: version.identity,
          compatibilityHost: canonicalDigest(options.host),
          installedRevision: installed.revision,
          revision: request.expectedRevision + 1,
          choice,
          contributions,
          overrides,
        });
        const controlDigest = scopeControlDigest(control);
        const confirmation = canonicalDigest({
          fingerprint,
          controlDigest,
          context,
          previous: previous === null ? null : scopeControlDigest(previous),
        });
        const receipt: ScopeReceipt = freezeMetadata({
          version: 1,
          operationId: request.operationId,
          key,
          fingerprint,
          controlDigest,
          priorRevision: request.expectedRevision,
          revision: control.revision,
          confirmation,
        });
        guard();
        if (supplied === undefined) return { status: "preview", receipt, replayed: false };
        if (supplied !== confirmation) throw new ExtensionInputError("stale-scope-confirmation");
        if (!retainedPackageMatches(version, await options.bytes.read(version, bounded)))
          throw new ExtensionInputError("package-bytes-changed");
        const currentContext = scopeContextSchema.parse(await options.context(bounded));
        if (canonicalDigest(currentContext) !== canonicalDigest(context))
          throw new ExtensionInputError("stale-scope-authority");
        guard();
        publicationAttempted = true;
        const committed = requireValue(options.store.replace(control, receipt, bounded));
        return { status: "applied", receipt: committed, replayed: false };
      } catch (error) {
        if (
          publicationAttempted &&
          (!(error instanceof ExtensionInputError) || error.code === "uncertain")
        )
          return { status: "failed", code: "uncertain" };
        if (signal.aborted) return { status: "failed", code: "cancelled" };
        if (deadline.aborted) return { status: "failed", code: "scope-deadline" };
        return {
          status: "failed",
          code: error instanceof ExtensionInputError ? error.code : "scope-input-unavailable",
        };
      }
    },
  };
}
