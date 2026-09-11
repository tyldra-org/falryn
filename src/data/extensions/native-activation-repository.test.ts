import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { inspectionHost, packageSource } from "../../application/extensions/package-fixtures.ts";
import { createPackageLifecycle } from "../../application/extensions/package-lifecycle.ts";
import { preparePackage } from "../../application/extensions/prepare-package.ts";
import { bytesDigest, canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  type NativeActivationReceipt,
  nativeActivationKey,
} from "../../domain/extensions/native-activation.ts";
import {
  type ScopeControl,
  type ScopeReceipt,
  scopeControlDigest,
  scopeControlKey,
} from "../../domain/extensions/scope-controls.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { createNativeActivationRepository } from "./native-activation-repository.ts";
import { createPackageLifecycleRepository } from "./package-lifecycle-repository.ts";
import { createScopeControlRepository } from "./scope-control-repository.ts";

afterEach(removeTemporaryRoots);
const signal = new AbortController().signal;
async function setup() {
  const root = await temporaryRoot("falryn-scopes-");
  const store = await openProductStoreOrThrow(root);
  const packages = createPackageLifecycleRepository(store);
  const lifecycle = createPackageLifecycle(
    packages,
    createHostPackageCache(join(root, "packages")),
    inspectionHost,
  );
  const source = packageSource(undefined, {
    "skills/one/SKILL.md": "---\nname: one\ndescription: Fixture\n---\nfixture",
  });
  const prepared = await preparePackage(source, inspectionHost);
  if (!prepared.ok) throw new Error(prepared.code);
  const request = {
    operationId: randomUUID(),
    packageId: "fixture",
    expectedRevision: 0,
    retention: "retain" as const,
  };
  const preview = await lifecycle.run("install", request, signal, source);
  if (preview.confirmation === null) throw new Error("install-preview");
  const applied = await lifecycle.run(
    "install",
    { ...request, confirmation: preview.confirmation },
    signal,
    source,
  );
  if (applied.status !== "completed") throw new Error(applied.code);
  const installed = packages.current("fixture");
  if (!installed.ok || installed.value.current === null) throw new Error("installed-package");
  const control: ScopeControl = {
    version: 1,
    actor: bytesDigest("actor"),
    authority: { scope: "user", id: bytesDigest("actor"), generation: 1 },
    scopeBinding: bytesDigest("scope-binding"),
    package: installed.value.current.identity,
    compatibilityHost: canonicalDigest(inspectionHost),
    installedRevision: 1,
    revision: 1,
    choice: { enabled: true, preferred: false, explicitOnly: false },
    contributions: prepared.package.contributions.map((entry) => ({
      identity: entry.identity,
      aliases: [],
      family: entry.family ?? null,
      effects: entry.authority.effects,
      compatibility: "compatible",
    })),
    overrides: [],
  };
  return { root, store, lifecycle, control, repository: createScopeControlRepository(store) };
}
function receipt(control: ScopeControl, operationId: string = randomUUID()): ScopeReceipt {
  return {
    version: 1,
    operationId,
    key: scopeControlKey(control),
    fingerprint: canonicalDigest({ operationId, control: scopeControlDigest(control) }),
    controlDigest: scopeControlDigest(control),
    priorRevision: control.revision - 1,
    revision: control.revision,
    confirmation: bytesDigest("confirmed-inputs"),
  };
}

function activation(control: ScopeControl): NativeActivationReceipt {
  const record = {
    version: 1 as const,
    actor: control.actor,
    scopeKey: scopeControlKey(control),
    scopeBinding: control.scopeBinding,
    authority: control.authority,
    package: canonicalDigest(control.package),
    installedRevision: control.installedRevision,
    configuration: bytesDigest("config"),
    contributions: control.contributions.map((entry) => canonicalDigest(entry.identity)),
    revision: 1,
  };
  return {
    operation: randomUUID(),
    fingerprint: bytesDigest("intent"),
    confirmation: bytesDigest("confirm"),
    key: nativeActivationKey(record),
    priorRevision: 0,
    record,
  };
}

test("native activation survives reopen and rejects stale concurrent writes, reused operations and cancellation", async () => {
  const { root, store, control, repository } = await setup();
  const candidate = activation(control);
  try {
    expect(repository.replace(control, receipt(control), signal).ok).toBe(true);
    const activations = createNativeActivationRepository(store);
    expect(activations.save(candidate, 1, AbortSignal.abort())).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(activations.get(candidate.key)).toEqual({ ok: true, value: null });
    expect(activations.save(candidate, 1, signal)).toEqual({ ok: true, value: candidate });
    const second = await openProductStoreOrThrow(root);
    try {
      const peer = createNativeActivationRepository(second);
      expect(peer.save({ ...candidate, operation: randomUUID() }, 1, signal)).toMatchObject({
        ok: false,
        error: { code: "stale-activation-revision" },
      });
      expect(
        peer.save({ ...candidate, fingerprint: bytesDigest("changed") }, 1, signal),
      ).toMatchObject({ ok: false, error: { code: "activation-operation-reused" } });
      expect(peer.save(candidate, 1, signal)).toEqual({ ok: true, value: candidate });
    } finally {
      await second.close();
    }
  } finally {
    await store.close();
  }
  const reopened = await openProductStoreOrThrow(root);
  try {
    const activations = createNativeActivationRepository(reopened);
    expect(activations.get(candidate.key)).toEqual({ ok: true, value: candidate.record });
    expect(activations.operation(candidate.operation)).toEqual({ ok: true, value: candidate });
    expect(
      reopened.write((tx) =>
        tx.run(
          "UPDATE extension_native_activations SET record_json='{invalid' WHERE activation_key=$key",
          { key: candidate.key },
        ),
      ).ok,
    ).toBe(true);
    expect(activations.get(candidate.key)).toMatchObject({
      ok: false,
      error: { code: "activation-record-malformed" },
    });
    expect(
      reopened.write((tx) =>
        tx.run(
          "UPDATE extension_native_operations SET receipt_json='{invalid' WHERE operation_id=$id",
          { id: candidate.operation },
        ),
      ).ok,
    ).toBe(true);
    expect(activations.operation(candidate.operation)).toMatchObject({
      ok: false,
      error: { code: "activation-record-malformed" },
    });
  } finally {
    await reopened.close();
  }
});

test("native activation writer rechecks scope and installation before committing either row", async () => {
  const { store, control, repository, lifecycle } = await setup();
  try {
    expect(repository.replace(control, receipt(control), signal).ok).toBe(true);
    const candidate = activation(control);
    const activations = createNativeActivationRepository(store);
    expect(activations.save(candidate, 2, signal)).toMatchObject({
      ok: false,
      error: { code: "stale-activation-scope" },
    });
    const request = {
      operationId: randomUUID(),
      packageId: "fixture",
      expectedRevision: 1,
      retention: "retain" as const,
    };
    const preview = await lifecycle.run("disable", request, signal);
    expect(
      (
        await lifecycle.run(
          "disable",
          { ...request, confirmation: preview.confirmation ?? "" },
          signal,
        )
      ).status,
    ).toBe("completed");
    expect(activations.save(candidate, 1, signal)).toMatchObject({
      ok: false,
      error: { code: "stale-activation-package" },
    });
    expect(activations.get(candidate.key)).toEqual({ ok: true, value: null });
    expect(activations.operation(candidate.operation)).toEqual({ ok: true, value: null });
  } finally {
    await store.close();
  }
});
