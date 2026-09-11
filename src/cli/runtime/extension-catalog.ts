/** Host-issued scope bindings over existing storage, trust, and resource owners. No native loaders. */
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  type CatalogContext,
  type CatalogRehydration,
  type CatalogTrust,
  createExtensionCatalogRehydrator,
} from "../../application/extensions/catalog-rehydration.ts";
import { inspectProvenanceTrust } from "../../application/extensions/package-provenance.ts";
import { TRUST_POLICY_GENERATION } from "../../application/extensions/package-trust.ts";
import {
  createExtensionScopeControls,
  type ScopeChangeResult,
  type ScopeContext,
} from "../../application/extensions/scope-controls.ts";
import { processProductResources } from "../../application/orchestration/product-resources.ts";
import type { CatalogRepositories } from "../../data/extensions/catalog-repositories.ts";
import { rootChild } from "../../data/index.ts";
import { canonicalDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import { CATALOG_LIMITS } from "../../domain/extensions/catalog.ts";
import { catalogWorkspaceBinding } from "../../domain/extensions/catalog-history.ts";
import type { InstalledPackage } from "../../domain/extensions/lifecycle.ts";
import type { ScopeAuthority, ScopeRequest } from "../../domain/extensions/scope-controls.ts";
import { sessionId } from "../../domain/foundation/index.ts";
import { ok } from "../../domain/foundation/result.ts";
import { conflictKey, NO_RETRY, workUnitId } from "../../domain/orchestration/work.ts";
import { trustEvidenceBinding } from "../../domain/security/ecosystem-trust.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { ed25519PackageVerifier } from "../../integrations/extensions/package-signature.ts";
import { FALRYN_VERSION } from "../version.ts";
import type { Services } from "./services.ts";

// A new process never inherits process/development choices from durable history.
const processAdmission = randomUUID();
export function composeExtensionCatalog(options: {
  readonly services: Services;
  readonly records: CatalogRepositories | null;
  readonly session?: string;
}) {
  const { services, records } = options;
  const user = userInfo();
  const actor = canonicalDigest({ kind: "local-user", uid: user.uid, username: user.username });
  const host = {
    falryn: FALRYN_VERSION,
    bun: Bun.version,
    os: process.platform,
    arch: process.arch,
  };
  const state = rootChild(services.localData.layout, "state");
  if (state === null) throw new ExtensionInputError("scope-store-unavailable");
  const bytes = createHostPackageCache(join(state, "packages"));
  const packages = records?.packages ?? null;
  const controls = records?.controls ?? null;
  async function context(signal: AbortSignal): Promise<CatalogContext> {
    const workspace = await services.ensureWorkspaceSet(signal);
    if (!workspace.ok) throw new ExtensionInputError("workspace-unavailable");
    const report = await services.workspaceTrust.resolve(undefined, signal);
    const admitted = report.status === "accepted" || report.status === "empty";
    const roots = catalogWorkspaceBinding(workspace.value.set);
    const authorities: CatalogContext["authorities"] = [
      {
        authority: { scope: "user", id: actor, generation: 1 },
        scopeBinding: canonicalDigest({ actor, home: services.configurationRoot }),
        admitted: true,
      },
      {
        authority: { scope: "workspace", id: roots, generation: 1 },
        scopeBinding: canonicalDigest({ roots, inventory: report.inventory?.generation ?? null }),
        admitted,
      },
    ];
    for (const scope of ["process", "development"] as const)
      authorities.push({
        authority: { scope, id: processAdmission, generation: 1 },
        scopeBinding: canonicalDigest({ processAdmission, scope, roots }),
        admitted,
      });
    let configurationGeneration = 1;
    if (options.session !== undefined) {
      const id = sessionId.parse(options.session);
      if (!id.ok || records === null) throw new ExtensionInputError("session-not-found");
      const session = records.sessions.get(id.value);
      if (!session.ok || session.value === null) throw new ExtensionInputError("session-not-found");
      if (session.value.extensionCatalog?.workspaceBinding !== roots)
        throw new ExtensionInputError("session-workspace-unverified");
      configurationGeneration = Number(session.value.configurationGeneration);
      authorities.push({
        authority: { scope: "session", id: options.session, generation: configurationGeneration },
        scopeBinding: canonicalDigest({
          session: options.session,
          workspace: session.value.workspaceId,
          roots,
        }),
        admitted,
      });
    }
    return {
      actor,
      authorities,
      configurationGeneration,
      inputs: canonicalDigest({
        roots,
        status: report.status,
        inventory: report.inventory?.generation ?? null,
        configuration: report.inventory?.configuration ?? null,
        policy: TRUST_POLICY_GENERATION,
      }),
    };
  }
  async function trustProjection(installed: InstalledPackage) {
    if (records === null || installed.current === null) return null;
    const version = installed.current;
    const result = inspectProvenanceTrust(
      {
        decisions: records.decisions,
        provenance: records.provenance,
        verifier: ed25519PackageVerifier,
      },
      {
        subject: { identity: version.identity, ownership: version.ownership },
        evidence: {
          integrity: "computed",
          signature: "unavailable",
          curation: "unavailable",
          advisory: "unavailable",
          observedAt: Number(services.clock.now()),
          expiresAt: null,
          reference: version.identity.packageDigest,
        },
        policyGeneration: TRUST_POLICY_GENERATION,
        actor,
        scope: { kind: "user", authority: actor },
        now: Number(services.clock.now()),
        compatibility: "compatible",
        health: "unknown",
        availability: "unavailable",
        online: false,
      },
      [],
    );
    if (result.status === "failed") throw new ExtensionInputError(`trust-${result.code}`);
    return result.trust;
  }
  async function trust(installed: InstalledPackage): Promise<CatalogTrust> {
    const projection = await trustProjection(installed);
    if (projection === null) return { trust: "unknown", inputs: canonicalDigest({ installed }) };
    return {
      trust: projection.eligible
        ? "accepted"
        : projection.state === "revoked"
          ? "revoked"
          : projection.decisionStatus === "expired"
            ? "expired"
            : "required",
      inputs: canonicalDigest({
        decision: projection.decision,
        evidence: trustEvidenceBinding(projection.evidence),
        freshness: projection.freshness,
        eligible: projection.eligible,
        policy: projection.policyGeneration,
      }),
    };
  }
  const rehydrator = createExtensionCatalogRehydrator({
    store: controls ?? { list: () => ok([]) },
    packages: packages ?? { current: (packageId) => ok({ packageId, revision: 0, current: null }) },
    bytes,
    host,
    context,
    trust: (_control, installed) => trust(installed),
  });
  async function bounded<T>(
    operation: string,
    mutation: boolean,
    signal: AbortSignal,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T | { status: "failed"; code: string }> {
    const task = processProductResources.openTask("extension-catalog-v1");
    try {
      const result = await task.execute({
        operation,
        attempt: "1",
        generation: task.generation,
        inputBytes: 16_384,
        amounts: { operations: 1, concurrency: 1, memoryBytes: 201_326_592 },
        signal,
        unit: {
          id: workUnitId(operation),
          effect: mutation ? "mutation" : "observation",
          priority: "interactive",
          conflictKeys: [conflictKey("extension-scopes", actor)],
          dependencies: [],
          deadline: null,
          expectedOutputBytes: CATALOG_LIMITS.metadataBytes,
          retry: NO_RETRY,
          scopeId: null,
        },
        async run(admittedSignal) {
          return { value: await run(admittedSignal), terminated: true };
        },
      });
      return result.kind === "completed"
        ? result.value
        : { status: "failed", code: result.receipt.state };
    } catch (error) {
      return {
        status: "failed",
        code: error instanceof ExtensionInputError ? error.code : "catalog-host-unavailable",
      };
    } finally {
      task.close();
    }
  }
  return {
    authorityContext: context,
    trustProjection,
    /** Internal composition already owns its outer resource and cancellation boundary. */
    captureMetadata: (signal: AbortSignal) => rehydrator.refresh(signal),
    async healthAuthority(
      installed: InstalledPackage,
      contribution: string | null,
      signal: AbortSignal,
    ) {
      const refreshed = await rehydrator.refresh(signal);
      const trusted = await trust(installed);
      const entries =
        refreshed.status === "rehydrated"
          ? refreshed.catalog.entries.filter(
              (entry) =>
                entry.source.kind === "package" &&
                entry.source.owner.packageId === installed.packageId &&
                (contribution === null || canonicalDigest(entry.contribution) === contribution),
            )
          : [];
      return {
        trusted: trusted.trust === "accepted",
        enabled: entries.some((entry) => entry.enabled),
        catalogGeneration: refreshed.status === "rehydrated" ? refreshed.catalog.generation : 0,
        inputs: canonicalDigest({
          trust: trusted.inputs,
          catalog: refreshed.status === "rehydrated" ? refreshed.catalog.inputs : refreshed.code,
        }),
      };
    },
    current: rehydrator.current,
    refresh(signal: AbortSignal): Promise<CatalogRehydration> {
      return bounded("catalog-rehydrate", false, signal, (admitted) =>
        rehydrator.refresh(admitted),
      );
    },
    change(
      packageId: string,
      scope: ScopeAuthority["scope"],
      request: ScopeRequest,
      signal: AbortSignal,
    ): Promise<ScopeChangeResult> {
      return bounded(
        request.operationId,
        request.confirmation !== undefined,
        signal,
        async (admittedSignal) => {
          if (controls === null || packages === null)
            return { status: "failed", code: "exact-package-unavailable" };
          const owner = createExtensionScopeControls({
            store: controls,
            packages,
            bytes,
            host,
            async context(signal): Promise<ScopeContext> {
              const captured = await context(signal);
              const selected = captured.authorities.find(
                (entry) => entry.authority.scope === scope,
              );
              if (selected === undefined)
                throw new ExtensionInputError("scope-authority-unavailable");
              const installed = packages.current(packageId);
              if (!installed.ok) throw new ExtensionInputError(installed.error.code);
              const trusted = await trust(installed.value);
              return {
                ...selected,
                actor,
                configurationGeneration: captured.configurationGeneration,
                inputs: canonicalDigest({ context: captured.inputs, trust: trusted.inputs }),
                admitted: selected.admitted,
                narrowingOnly: trusted.trust !== "accepted",
              };
            },
          });
          return owner.change(packageId, request, admittedSignal);
        },
      );
    },
  };
}
