import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import {
  openProductStoreOrThrow,
  removeTemporaryRoots,
  temporaryRoot,
} from "../../data/fixtures.ts";
import { createPackageProvenanceRepository } from "../../data/security/provenance-repository.ts";
import { createTrustDecisionRepository } from "../../data/security/trust-repository.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import type {
  InstalledVersion,
  PackageAction,
  PackageRequest,
} from "../../domain/extensions/lifecycle.ts";
import type { PackageSource } from "../../domain/extensions/package-source.ts";
import { err } from "../../domain/foundation/result.ts";
import { RUNNING_WORK_POLICY } from "../../domain/security/package-standing.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { ed25519PackageVerifier } from "../../integrations/extensions/package-signature.ts";
import { inspectionHost, packageSource, pluginManifest } from "./package-fixtures.ts";
import { createPackageLifecycle } from "./package-lifecycle.ts";
import { inspectProvenanceTrust } from "./package-provenance.ts";
import {
  createPackageStanding,
  installedTrustObservation,
  projectInstalledTrust,
} from "./package-standing.ts";

afterEach(removeTemporaryRoots);
const signal = new AbortController().signal;
const actor = canonicalDigest("standing-actor");
const NOW = 1_000_000;

async function setup() {
  const root = await temporaryRoot("falryn-package-standing-");
  const store = await openProductStoreOrThrow(root);
  const packages = createPackageLifecycleRepository(store);
  const owners = {
    packages,
    decisions: createTrustDecisionRepository(store),
    provenance: createPackageProvenanceRepository(store),
    verifier: ed25519PackageVerifier,
  };
  let clock = NOW;
  const standing = createPackageStanding({ owners, actor, now: () => clock });
  const lifecycle = createPackageLifecycle(
    packages,
    createHostPackageCache(join(root, "packages")),
    inspectionHost,
    undefined,
    (version) => standing.summarize(version),
  );
  return {
    store,
    owners,
    packages,
    standing,
    lifecycle,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
type Context = Awaited<ReturnType<typeof setup>>;

function request(packageId: string, revision: number, extra: Partial<PackageRequest> = {}) {
  return {
    packageId,
    operationId: randomUUID(),
    expectedRevision: revision,
    retention: "retain",
    ...extra,
  } satisfies PackageRequest;
}
async function lifecycleApply(
  context: Context,
  action: PackageAction,
  req: PackageRequest,
  source?: PackageSource,
) {
  const preview = await context.lifecycle.run(action, req, signal, source);
  if (preview.status !== "preview" || preview.confirmation === null)
    throw new Error(JSON.stringify(preview));
  return context.lifecycle.run(
    action,
    { ...req, confirmation: preview.confirmation },
    signal,
    source,
  );
}
function version(context: Context, packageId: string, digest?: string): InstalledVersion {
  const installed = context.packages.current(packageId);
  if (!installed.ok) throw new Error(installed.error.code);
  if (digest !== undefined) {
    const found = context.packages.version(packageId, digest);
    if (!found.ok || found.value === null) throw new Error("version");
    return found.value;
  }
  if (installed.value.current === null) throw new Error("not-installed");
  return installed.value.current;
}
function approve(context: Context, target: InstalledVersion, expiresAt = NOW + 3_600_000) {
  const observation = installedTrustObservation(target, actor, NOW);
  const request = { action: "approve" as const, expiresAt };
  const preview = inspectProvenanceTrust(context.owners, observation, [], request);
  if (preview.status !== "preview" || preview.confirmation === null)
    throw new Error(JSON.stringify(preview));
  const applied = inspectProvenanceTrust(context.owners, observation, [], {
    ...request,
    confirmation: preview.confirmation,
  });
  if (applied.status !== "applied") throw new Error(JSON.stringify(applied));
}
async function hold(
  context: Context,
  action: "quarantine" | "release" | "revoke",
  packageId: string,
  extra: { reason?: "policy" } = {},
) {
  const installed = context.packages.current(packageId);
  if (!installed.ok) throw new Error(installed.error.code);
  const base = { action, packageId, expectedRevision: installed.value.revision, ...extra };
  const preview = await context.standing.enforce(base, signal);
  if (preview.status !== "preview" || preview.confirmation === null)
    throw new Error(JSON.stringify(preview));
  return context.standing.enforce({ ...base, confirmation: preview.confirmation }, signal);
}
const dependentSource = () =>
  packageSource(
    pluginManifest(
      { version: 1, dependencies: [{ id: "fixture", range: "^1.0.0" }] },
      { name: "dependent" },
    ),
  );
const baseV2 = () => packageSource(pluginManifest({ version: 1 }, { version: "1.1.0" }));

test("an installed package's standing is derived from its trust, versions and dependency closure", async () => {
  const context = await setup();
  try {
    expect(context.standing.standing("fixture")).toMatchObject({
      ok: true,
      value: { state: "not-installed", recovery: [{ choice: "inspect" }] },
    });
    await lifecycleApply(context, "install", request("fixture", 0), packageSource());
    expect(context.standing.standing("fixture")).toMatchObject({
      ok: true,
      value: { state: "unapproved", reason: "ecosystem-trust-required", lastKnownGood: null },
    });
    approve(context, version(context, "fixture"));
    await lifecycleApply(context, "install", request("dependent", 0), dependentSource());
    approve(context, version(context, "dependent"));
    expect(context.standing.standing("dependent")).toMatchObject({
      ok: true,
      value: { state: "eligible", dependencies: [{ id: "fixture", eligible: true }] },
    });
    // The dependency loses its approval; the dependent is blocked without storing anything about it.
    const held = await hold(context, "revoke", "fixture");
    expect(held).toMatchObject({
      status: "applied",
      before: "eligible",
      standing: { state: "revoked", reason: "ecosystem-trust-revoked" },
      runningWork: RUNNING_WORK_POLICY,
    });
    expect(context.standing.standing("dependent")).toMatchObject({
      ok: true,
      value: {
        state: "dependency-blocked",
        reason: "dependency-not-eligible",
        dependencies: [{ id: "fixture", state: "revoked", eligible: false }],
      },
    });
  } finally {
    await context.store.close();
  }
});

test("quarantine, release and reapproval move one package through the shared trust record", async () => {
  const context = await setup();
  try {
    await lifecycleApply(context, "install", request("fixture", 0), packageSource());
    approve(context, version(context, "fixture"));
    expect(await hold(context, "quarantine", "fixture", { reason: "policy" })).toMatchObject({
      status: "applied",
      standing: {
        state: "quarantined",
        recovery: [{ choice: "inspect" }, { choice: "release" }, { choice: "uninstall" }],
      },
    });
    // The catalog and gateway read the same evaluator; the hold is visible through it at once.
    const trust = projectInstalledTrust(context.owners, version(context, "fixture"), actor, NOW);
    expect(trust).toMatchObject({ state: "quarantined", eligible: false });
    expect(await hold(context, "release", "fixture")).toMatchObject({
      status: "applied",
      standing: { state: "unapproved" },
    });
    approve(context, version(context, "fixture"));
    expect(context.standing.standing("fixture")).toMatchObject({
      ok: true,
      value: { state: "eligible" },
    });
  } finally {
    await context.store.close();
  }
});

test("a hold is refused for a package that is not installed or changed since it was previewed", async () => {
  const context = await setup();
  try {
    const missing = await context.standing.enforce(
      { action: "quarantine", packageId: "fixture", expectedRevision: 0 },
      signal,
    );
    expect(missing).toMatchObject({ status: "failed", code: "not-installed" });
    await lifecycleApply(context, "install", request("fixture", 0), packageSource());
    expect(
      await context.standing.enforce(
        { action: "quarantine", packageId: "fixture", expectedRevision: 0 },
        signal,
      ),
    ).toMatchObject({ status: "failed", code: "stale-package-revision" });
    expect(
      await context.standing.enforce(
        { action: "release", packageId: "fixture", expectedRevision: 1, reason: "policy" },
        signal,
      ),
    ).toMatchObject({ status: "failed", code: "unexpected-hold-reason" });
    expect(
      await context.standing.enforce(
        { action: "release", packageId: "fixture", expectedRevision: 1 },
        signal,
      ),
    ).toMatchObject({ status: "failed", code: "not-quarantined" });
  } finally {
    await context.store.close();
  }
});

test("a revoked last version offers recovery choices and never substitutes another version", async () => {
  const context = await setup();
  try {
    await lifecycleApply(context, "install", request("fixture", 0), packageSource());
    const first = version(context, "fixture");
    approve(context, first);
    await lifecycleApply(context, "update", request("fixture", 1), baseV2());
    const second = version(context, "fixture");
    approve(context, second);
    await hold(context, "revoke", "fixture");
    const standing = context.standing.standing("fixture");
    if (!standing.ok) throw new Error(standing.error.code);
    expect(standing.value).toMatchObject({
      state: "revoked",
      packageVersion: "1.1.0",
      lastKnownGood: first.identityDigest,
    });
    expect(standing.value.recovery).toEqual([
      { choice: "inspect" },
      { choice: "approve" },
      { choice: "update" },
      { choice: "rollback", versionDigest: first.identityDigest },
      { choice: "uninstall" },
    ]);
    // Nothing moved on its own: the installed version is still the revoked one.
    expect(version(context, "fixture").identityDigest).toBe(second.identityDigest);
  } finally {
    await context.store.close();
  }
});

test("rollback previews its target's standing, restores bytes only and leaves a revoked target revoked", async () => {
  const context = await setup();
  try {
    await lifecycleApply(context, "install", request("fixture", 0), packageSource());
    const first = version(context, "fixture");
    approve(context, first);
    await hold(context, "revoke", "fixture");
    await lifecycleApply(context, "update", request("fixture", 1), baseV2());
    const rollback = request("fixture", 2, { versionDigest: first.identityDigest });
    const preview = await context.lifecycle.run("rollback", rollback, signal);
    expect(preview).toMatchObject({
      status: "preview",
      data: {
        rollback: { restoresApproval: false, target: { state: "revoked", eligible: false } },
      },
    });
    const done = await lifecycleApply(context, "rollback", rollback);
    expect(done).toMatchObject({ status: "completed", activation: "unavailable" });
    // The prior revocation still holds for the restored bytes; rollback is not a way around it.
    expect(context.standing.standing("fixture")).toMatchObject({
      ok: true,
      value: { state: "revoked", identityDigest: first.identityDigest },
    });
  } finally {
    await context.store.close();
  }
});

test("a failed rollback changes nothing and names why", async () => {
  const context = await setup();
  try {
    await lifecycleApply(context, "install", request("fixture", 0), packageSource());
    await lifecycleApply(context, "update", request("fixture", 1), baseV2());
    const before = context.packages.current("fixture");
    const missing = await context.lifecycle.run(
      "rollback",
      request("fixture", 2, { versionDigest: canonicalDigest("never-installed") }),
      signal,
    );
    expect(missing).toMatchObject({ status: "failed", code: "rollback-version-unavailable" });
    expect(context.packages.current("fixture")).toEqual(before);
  } finally {
    await context.store.close();
  }
});

test("quarantined bytes survive removal until an explicit purge that previews files and bytes", async () => {
  const context = await setup();
  try {
    await lifecycleApply(context, "install", request("fixture", 0), packageSource());
    approve(context, version(context, "fixture"));
    await hold(context, "quarantine", "fixture", { reason: "policy" });
    const removal = request("fixture", 1, { retention: "remove" });
    const refused = await context.lifecycle.run("uninstall", removal, signal);
    expect(refused).toMatchObject({
      status: "failed",
      code: "quarantined-evidence-retained",
      data: { quarantinedEvidence: { versions: 1 } },
    });
    const evidence = (refused.data as { quarantinedEvidence: { files: number; bytes: number } })
      .quarantinedEvidence;
    expect(evidence.files).toBeGreaterThan(0);
    expect(evidence.bytes).toBeGreaterThan(0);
    // Retained, not removed: the versions and the bytes are still there.
    expect(version(context, "fixture").identityDigest).toBeTruthy();
    expect(
      await context.lifecycle.run("uninstall", { ...removal, purgeQuarantined: true }, signal),
    ).toMatchObject({ status: "preview", data: { quarantinedEvidence: { versions: 1 } } });
    expect(
      await context.lifecycle.run(
        "uninstall",
        request("fixture", 1, { purgeQuarantined: true }),
        signal,
      ),
    ).toMatchObject({ status: "failed", code: "unexpected-purge-choice" });
    const purged = await lifecycleApply(context, "uninstall", {
      ...removal,
      purgeQuarantined: true,
    });
    expect(purged).toMatchObject({ status: "completed", code: "uninstalled" });
    // Retaining on uninstall never needed a purge, and the decision record outlives the bytes.
    expect(context.standing.standing("fixture")).toMatchObject({
      ok: true,
      value: { state: "not-installed" },
    });
  } finally {
    await context.store.close();
  }
});

test("an expired approval stays expired after a rollback and offline", async () => {
  const context = await setup();
  try {
    await lifecycleApply(context, "install", request("fixture", 0), packageSource());
    const first = version(context, "fixture");
    approve(context, first, NOW + 1_000);
    await lifecycleApply(context, "update", request("fixture", 1), baseV2());
    context.advance(10_000);
    await lifecycleApply(
      context,
      "rollback",
      request("fixture", 2, { versionDigest: first.identityDigest }),
    );
    expect(context.standing.standing("fixture")).toMatchObject({
      ok: true,
      value: { state: "expired", reason: "ecosystem-trust-expired" },
    });
  } finally {
    await context.store.close();
  }
});

test("a cancelled hold and an uncertain write change nothing the caller can mistake for success", async () => {
  const context = await setup();
  try {
    await lifecycleApply(context, "install", request("fixture", 0), packageSource());
    approve(context, version(context, "fixture"));
    const base = { action: "quarantine" as const, packageId: "fixture", expectedRevision: 1 };
    const preview = await context.standing.enforce(base, signal);
    if (preview.status !== "preview" || preview.confirmation === null) throw new Error("preview");
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await context.standing.enforce(
        { ...base, confirmation: preview.confirmation },
        aborted.signal,
      ),
    ).toMatchObject({ status: "failed", code: "cancelled" });
    expect(context.standing.standing("fixture")).toMatchObject({
      ok: true,
      value: { state: "eligible" },
    });
    // A store that cannot say whether the write landed reports uncertainty and applies nothing here.
    const uncertain = createPackageStanding({
      owners: {
        ...context.owners,
        decisions: {
          get: context.owners.decisions.get,
          replace: () => err({ code: "uncertain" }),
        },
      },
      actor,
      now: () => NOW,
    });
    expect(
      await uncertain.enforce({ ...base, confirmation: preview.confirmation }, signal),
    ).toMatchObject({ status: "failed", code: "uncertain" });
  } finally {
    await context.store.close();
  }
});
