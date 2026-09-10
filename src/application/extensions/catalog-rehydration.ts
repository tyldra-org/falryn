/** Rebuild compact inspection facts without preparing contributions or restoring native authority. */
import { z } from "zod";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import {
  CATALOG_LIMITS,
  type CatalogEntry,
  catalogEntrySchema,
  createExtensionCatalog,
  type ExtensionCatalog,
} from "../../domain/extensions/catalog.ts";
import { digestSchema, generationSchema } from "../../domain/extensions/identity.ts";
import type {
  InstalledPackage,
  PackageBytes,
  PackageLifecycleStore,
} from "../../domain/extensions/lifecycle.ts";
import {
  type ScopeControl,
  type ScopeControlStore,
  scopeAuthoritySchema,
  scopeControlDigest,
  scopeControlSchema,
} from "../../domain/extensions/scope-controls.ts";
import type { Result } from "../../domain/foundation/result.ts";
import type { InspectionHost } from "./prepare-package.ts";
import { retainedPackageMatches } from "./scope-controls.ts";

export const catalogContextSchema = z.strictObject({
  actor: digestSchema,
  configurationGeneration: generationSchema,
  inputs: digestSchema,
  authorities: z
    .array(
      z.strictObject({
        authority: scopeAuthoritySchema,
        scopeBinding: digestSchema,
        admitted: z.boolean(),
      }),
    )
    .max(CATALOG_LIMITS.controls),
});
export type CatalogContext = z.infer<typeof catalogContextSchema>;
export const catalogTrustSchema = z.strictObject({
  trust: z.enum(["accepted", "required", "revoked", "expired", "unknown"]),
  inputs: digestSchema,
});
export type CatalogTrust = z.infer<typeof catalogTrustSchema>;
export type CatalogRehydration =
  | { readonly status: "rehydrated"; readonly catalog: ExtensionCatalog }
  | { readonly status: "failed"; readonly code: string };

type Candidate = {
  readonly control: ScopeControl;
  readonly installed: InstalledPackage;
  readonly trust: CatalogTrust;
};

function value<T>(result: Result<T, { readonly code: string }>): T {
  if (!result.ok) throw new ExtensionInputError(result.error.code);
  return result.value;
}

function authorityFor(context: CatalogContext, control: ScopeControl) {
  return context.authorities.find(
    ({ authority }) =>
      authority.scope === control.authority.scope && authority.id === control.authority.id,
  );
}

function packageEntries(
  candidate: Candidate,
  context: CatalogContext,
  generation: number,
  host: string,
  integrity: boolean,
): CatalogEntry[] {
  const { control, installed, trust } = candidate;
  const authority = authorityFor(context, control);
  const scopeCurrent =
    authority?.admitted === true &&
    authority.authority.generation === control.authority.generation &&
    authority.scopeBinding === control.scopeBinding;
  let lifecycle: CatalogEntry["lifecycle"] = "current";
  if (installed.current === null) lifecycle = "missing";
  else if (installed.current.identityDigest !== canonicalDigest(control.package))
    lifecycle = "changed";
  else if (installed.revision !== control.installedRevision) lifecycle = "disabled";
  else if (!integrity) lifecycle = "changed";
  return control.contributions.map((contribution) => {
    const override = control.overrides.find(
      (entry) => entry.contribution === canonicalDigest(contribution.identity),
    );
    const choice = override?.choice ?? control.choice;
    const compatibility =
      control.compatibilityHost === host ? contribution.compatibility : "unknown";
    const enabled =
      control.choice.enabled &&
      choice.enabled &&
      scopeCurrent &&
      lifecycle === "current" &&
      compatibility === "compatible" &&
      trust.trust === "accepted";
    let reason = "native-owner-unavailable";
    if (lifecycle !== "current") reason = `package-${lifecycle}`;
    else if (!scopeCurrent) reason = "scope-authority-stale";
    else if (compatibility !== "compatible") reason = "compatibility-unavailable";
    else if (trust.trust !== "accepted") reason = `trust-${trust.trust}`;
    else if (!enabled) reason = "scope-disabled";
    return {
      source: {
        kind: "package",
        owner: control.package,
        activation: {
          version: 1,
          packageIdentityDigest: canonicalDigest(control.package),
          scope: control.authority.scope,
          scopeAuthorityId: control.authority.id,
          scopeAuthorityGeneration: control.authority.generation,
          configurationGeneration: context.configurationGeneration,
          activationRevision: control.revision,
          catalogGeneration: generation,
        },
      },
      contribution: contribution.identity,
      aliases: contribution.aliases,
      family: contribution.family,
      effects: contribution.effects,
      compatibility,
      lifecycle,
      enabled,
      preferred: choice.preferred,
      explicitOnly: control.choice.explicitOnly || choice.explicitOnly,
      health: lifecycle === "current" ? "unknown" : "degraded",
      trust: trust.trust,
      availability: "unavailable",
      reason,
      binding: null,
    };
  });
}

/** One host owns publication; failed or overlapping refreshes never replace its last complete snapshot. */
export function createExtensionCatalogRehydrator(options: {
  readonly store: Pick<ScopeControlStore, "list">;
  readonly packages: Pick<PackageLifecycleStore, "current">;
  readonly bytes: Pick<PackageBytes, "read">;
  readonly host: InspectionHost;
  readonly context: (signal: AbortSignal) => Promise<CatalogContext>;
  readonly trust: (
    control: ScopeControl,
    installed: InstalledPackage,
    signal: AbortSignal,
  ) => Promise<CatalogTrust>;
  /** Host-owned builtin/standalone facts only; package records always go through reconciliation. */
  readonly independent?: (signal: AbortSignal) => Promise<readonly CatalogEntry[]>;
}) {
  let current: ExtensionCatalog | null = null;
  let refreshing = false;
  return {
    current: () => current,
    async refresh(signal: AbortSignal): Promise<CatalogRehydration> {
      if (refreshing) return { status: "failed", code: "catalog-refresh-in-progress" };
      refreshing = true;
      const deadline = AbortSignal.timeout(CATALOG_LIMITS.deadlineMs);
      const bounded = AbortSignal.any([signal, deadline]);
      const guard = () => {
        if (signal.aborted) throw new ExtensionInputError("cancelled");
        if (deadline.aborted) throw new ExtensionInputError("catalog-deadline");
      };
      const capture = async () => {
        guard();
        const context = catalogContextSchema.parse(await options.context(bounded));
        const authorityKeys = context.authorities.map(
          ({ authority }) => `${authority.scope}:${authority.id}`,
        );
        if (new Set(authorityKeys).size !== authorityKeys.length)
          throw new ExtensionInputError("duplicate-scope-authority");
        const records = value(
          options.store.list(
            context.actor,
            context.authorities.map(({ authority }) => ({
              scope: authority.scope,
              id: authority.id,
            })),
          ),
        );
        if (records.length > CATALOG_LIMITS.controls)
          throw new ExtensionInputError("scope-control-limit");
        let metadataBytes = 0;
        const controls = records.map((record) => {
          metadataBytes += Buffer.byteLength(JSON.stringify(record));
          if (metadataBytes > CATALOG_LIMITS.metadataBytes)
            throw new ExtensionInputError("scope-metadata-limit");
          const control = scopeControlSchema.parse(record);
          if (control.actor !== context.actor)
            throw new ExtensionInputError("scope-actor-mismatch");
          return control;
        });
        const candidates: Candidate[] = [];
        let descriptors = 0;
        for (const control of controls) {
          guard();
          if (authorityFor(context, control) === undefined) continue;
          descriptors += control.contributions.length;
          if (descriptors > CATALOG_LIMITS.descriptors)
            throw new ExtensionInputError("catalog-descriptor-limit");
          const installed = value(options.packages.current(control.package.packageId));
          const trust = catalogTrustSchema.parse(await options.trust(control, installed, bounded));
          candidates.push({ control, installed, trust });
        }
        const independent = (await options.independent?.(bounded)) ?? [];
        if (independent.length + descriptors > CATALOG_LIMITS.descriptors)
          throw new ExtensionInputError("catalog-descriptor-limit");
        const entries = independent.map((entry) => {
          const parsed = catalogEntrySchema.parse(entry);
          if (parsed.source.kind === "package")
            throw new ExtensionInputError("unreconciled-package-entry");
          return parsed;
        });
        guard();
        const identity = canonicalDigest({
          context: {
            ...context,
            // An unrelated process nonce must not invalidate durable-only CLI pagination.
            authorities: context.authorities.filter(
              (entry) =>
                !["process", "development"].includes(entry.authority.scope) ||
                candidates.some(({ control }) => authorityFor(context, control) === entry),
            ),
          },
          host: options.host,
          controls: controls.map(scopeControlDigest).sort(),
          candidates: candidates
            .map(({ control, installed, trust }) =>
              canonicalDigest({
                control: scopeControlDigest(control),
                installed,
                trust,
              }),
            )
            .sort(),
          independent: entries.map((entry) => canonicalDigest(entry)).sort(),
        });
        return { context, candidates, entries, identity };
      };
      const integrity = async (candidate: Candidate): Promise<boolean> => {
        guard();
        const version = candidate.installed.current;
        if (
          version === null ||
          version.identityDigest !== canonicalDigest(candidate.control.package) ||
          candidate.installed.revision !== candidate.control.installedRevision
        )
          return false;
        try {
          return retainedPackageMatches(version, await options.bytes.read(version, bounded));
        } catch {
          guard();
          return false;
        }
      };
      try {
        const before = await capture();
        const verified: boolean[] = [];
        for (const candidate of before.candidates) verified.push(await integrity(candidate));
        // Recheck bytes before authority capture so a revoked decision observed during I/O wins.
        for (const [index, candidate] of before.candidates.entries()) {
          if ((await integrity(candidate)) !== verified[index])
            throw new ExtensionInputError("stale-catalog-inputs");
        }
        const after = await capture();
        if (before.identity !== after.identity)
          throw new ExtensionInputError("stale-catalog-inputs");
        guard();
        const generation = (current?.generation ?? 0) + 1;
        const entries = [...before.entries];
        for (const [index, candidate] of before.candidates.entries()) {
          entries.push(
            ...packageEntries(
              candidate,
              before.context,
              generation,
              canonicalDigest(options.host),
              verified[index] === true,
            ),
          );
        }
        const inputs = canonicalDigest({ captured: before.identity, integrity: verified });
        // An unchanged refresh keeps all existing handles valid.
        if (current?.inputs === inputs) return { status: "rehydrated", catalog: current };
        const candidate = createExtensionCatalog({ generation, inputs, entries, signal: bounded });
        guard();
        current = candidate;
        return { status: "rehydrated", catalog: candidate };
      } catch (error) {
        return {
          status: "failed",
          code: signal.aborted
            ? "cancelled"
            : deadline.aborted
              ? "catalog-deadline"
              : error instanceof ExtensionInputError
                ? error.code
                : "catalog-input-unavailable",
        };
      } finally {
        refreshing = false;
      }
    },
  };
}
