import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { inspectionHost, packageSource } from "../../application/extensions/package-fixtures.ts";
import { createPackageLifecycle } from "../../application/extensions/package-lifecycle.ts";
import { bytesDigest, canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  type ScopeControl,
  type ScopeReceipt,
  scopeControlDigest,
  scopeControlKey,
} from "../../domain/extensions/scope-controls.ts";
import type { SqliteStorePort } from "../../domain/storage/index.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
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
  const request = {
    operationId: randomUUID(),
    packageId: "fixture",
    expectedRevision: 0,
    retention: "retain" as const,
  };
  const preview = await lifecycle.run("install", request, signal, packageSource());
  if (preview.confirmation === null) throw new Error("install-preview");
  const applied = await lifecycle.run(
    "install",
    { ...request, confirmation: preview.confirmation },
    signal,
    packageSource(),
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
    contributions: [],
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

test("scope choices and exactly one operation receipt survive a real store reopen", async () => {
  const { root, store, control, repository } = await setup();
  const committed = receipt(control);
  try {
    expect(repository.get(committed.key)).toEqual({ ok: true, value: null });
    expect(repository.replace(control, committed, signal)).toEqual({ ok: true, value: committed });
    expect(repository.replace(control, committed, signal)).toEqual({ ok: true, value: committed });
    expect(repository.list(control.actor)).toEqual({ ok: true, value: [control] });
  } finally {
    await store.close();
  }
  const reopened = await openProductStoreOrThrow(root);
  try {
    const records = createScopeControlRepository(reopened);
    expect(records.get(committed.key)).toEqual({ ok: true, value: control });
    expect(records.operation(committed.operationId)).toEqual({ ok: true, value: committed });
    expect(records.list(bytesDigest("another-actor"))).toEqual({ ok: true, value: [] });
  } finally {
    await reopened.close();
  }
});

test("two store connections serialize stale revisions and conflicting operation reuse", async () => {
  const { root, store, control, repository } = await setup();
  const second = await openProductStoreOrThrow(root);
  try {
    const peer = createScopeControlRepository(second);
    const first = receipt(control);
    expect(repository.replace(control, first, signal).ok).toBe(true);
    expect(peer.replace(control, receipt(control), signal)).toEqual({
      ok: false,
      error: { code: "stale-scope-revision" },
    });
    const replacement = { ...control, revision: 2, choice: { ...control.choice, enabled: false } };
    expect(peer.replace(replacement, receipt(replacement, first.operationId), signal)).toEqual({
      ok: false,
      error: { code: "scope-operation-conflict" },
    });
    expect(peer.replace(replacement, receipt(replacement), signal).ok).toBe(true);
    expect(repository.get(first.key)).toEqual({ ok: true, value: replacement });
  } finally {
    await second.close();
    await store.close();
  }
});

test("lifecycle disable invalidates a pending enable even when retained package identity is unchanged", async () => {
  const { store, control, repository, lifecycle } = await setup();
  try {
    const input = {
      operationId: randomUUID(),
      packageId: "fixture",
      expectedRevision: 1,
      retention: "retain" as const,
    };
    const preview = await lifecycle.run("disable", input, signal);
    if (preview.confirmation === null) throw new Error("disable-preview");
    const disabled = await lifecycle.run(
      "disable",
      { ...input, confirmation: preview.confirmation },
      signal,
    );
    expect(disabled.status).toBe("completed");
    const candidate = receipt(control);
    expect(repository.replace(control, candidate, signal)).toEqual({
      ok: false,
      error: { code: "stale-package-revision" },
    });
    expect(repository.operation(candidate.operationId)).toEqual({ ok: true, value: null });
  } finally {
    await store.close();
  }
});

test("malformed rows and forged identity digests fail closed without overwriting committed metadata", async () => {
  const { store, control, repository } = await setup();
  try {
    const original = receipt(control);
    expect(repository.replace(control, original, signal).ok).toBe(true);
    const corrupted = store.write((sql) =>
      sql.run("UPDATE extension_scope_controls SET metadata='{invalid' WHERE control_key=$key", {
        key: original.key,
      }),
    );
    expect(corrupted.ok).toBe(true);
    expect(repository.get(original.key)).toEqual({
      ok: false,
      error: { code: "corrupt-scope-store" },
    });
    expect(repository.list(control.actor)).toEqual({
      ok: false,
      error: { code: "corrupt-scope-store" },
    });
    const next = { ...control, revision: 2 };
    expect(repository.replace(next, receipt(next), signal)).toEqual({
      ok: false,
      error: { code: "corrupt-scope-store" },
    });
    expect(
      repository.replace(control, { ...original, controlDigest: bytesDigest("forged") }, signal),
    ).toEqual({ ok: false, error: { code: "invalid-scope-publication" } });
  } finally {
    await store.close();
  }
});

test("interrupted receipt insertion rolls back the entire control change", async () => {
  const { store, control, repository } = await setup();
  try {
    expect(
      store.write((sql) =>
        sql.run(
          "CREATE TRIGGER fail_scope_receipt BEFORE INSERT ON extension_scope_operations BEGIN SELECT RAISE(ABORT, 'injected-write-failure'); END",
        ),
      ).ok,
    ).toBe(true);
    const candidate = receipt(control);
    expect(repository.replace(control, candidate, signal)).toEqual({
      ok: false,
      error: { code: "scope-write-failed" },
    });
    expect(repository.get(candidate.key)).toEqual({ ok: true, value: null });
    expect(repository.operation(candidate.operationId)).toEqual({ ok: true, value: null });
  } finally {
    await store.close();
  }
});

test("session scope requires a durable session and cancellation creates no control", async () => {
  const { store, control, repository } = await setup();
  try {
    const session: ScopeControl = {
      ...control,
      authority: { scope: "session", id: "session:missing", generation: 1 },
    };
    expect(repository.replace(session, receipt(session), signal)).toEqual({
      ok: false,
      error: { code: "session-not-found" },
    });
    expect(repository.replace(control, receipt(control), AbortSignal.abort()).ok).toBe(false);
    expect(repository.list(control.actor)).toEqual({ ok: true, value: [] });
  } finally {
    await store.close();
  }
});

test("uncertain commits stay distinct from clean write failures", async () => {
  const { store, control } = await setup();
  try {
    const uncertain: SqliteStorePort = {
      ...store,
      write: () => ({
        ok: false,
        error: {
          kind: "sqlite-store",
          code: "unavailable",
          effect: "uncertain",
          operation: "transaction",
          cause: {
            kind: "sqlite",
            code: "io-failure",
            operation: "transaction",
            driverCode: null,
            detail: null,
          },
        },
      }),
    };
    expect(
      createScopeControlRepository(uncertain).replace(control, receipt(control), signal),
    ).toEqual({ ok: false, error: { code: "uncertain" } });
  } finally {
    await store.close();
  }
});

test("the reconciliation count bound does not erase history or become a storage quota", async () => {
  const { store, control, repository } = await setup();
  try {
    const seeded = store.write((sql) => {
      for (let index = 0; index < 1_025; index++) {
        const historical: ScopeControl = {
          ...control,
          authority: {
            scope: index % 2 === 0 ? "workspace" : "session",
            id: `foreign-${index}`,
            generation: 1,
          },
        };
        sql.run(
          "INSERT INTO extension_scope_controls(control_key,actor,scope,authority_id,revision,digest,metadata) VALUES($key,$actor,$scope,$authority,$revision,$digest,$metadata)",
          {
            key: scopeControlKey(historical),
            actor: historical.actor,
            scope: historical.authority.scope,
            authority: historical.authority.id,
            revision: 1,
            digest: scopeControlDigest(historical),
            metadata: JSON.stringify(historical),
          },
        );
      }
    });
    expect(seeded.ok).toBe(true);
    expect(repository.list(control.actor, [{ scope: "user", id: control.authority.id }])).toEqual({
      ok: true,
      value: [],
    });
    expect(repository.list(control.actor)).toEqual({
      ok: false,
      error: { code: "scope-control-limit" },
    });
    const committed = receipt(control);
    expect(repository.replace(control, committed, signal).ok).toBe(true);
    expect(repository.list(control.actor)).toEqual({
      ok: false,
      error: { code: "scope-control-limit" },
    });
    expect(repository.get(committed.key)).toEqual({ ok: true, value: control });
    expect(repository.operation(committed.operationId)).toEqual({ ok: true, value: committed });
    const narrowed = { ...control, revision: 2, choice: { ...control.choice, enabled: false } };
    expect(repository.replace(narrowed, receipt(narrowed), signal).ok).toBe(true);
    expect(repository.get(committed.key)).toEqual({ ok: true, value: narrowed });
    expect(repository.list(control.actor, [{ scope: "user", id: control.authority.id }])).toEqual({
      ok: true,
      value: [narrowed],
    });
    expect(repository.list(control.actor, [{ scope: "workspace", id: "foreign-0" }])).toMatchObject(
      { ok: true, value: [{ authority: { scope: "workspace", id: "foreign-0" } }] },
    );
    expect(store.read("SELECT count(*) AS count FROM extension_scope_controls")).toEqual({
      ok: true,
      value: [{ count: 1_026 }],
    });
  } finally {
    await store.close();
  }
});

test("authority selection is bounded, scope-qualified and independent of stored generation", async () => {
  const { store, control, repository } = await setup();
  try {
    const authority = { scope: "workspace" as const, id: "quoted' OR 1=1 --" };
    const selected = { ...control, authority: { ...authority, generation: 9 } };
    expect(repository.replace(selected, receipt(selected), signal).ok).toBe(true);
    expect(repository.replace(control, receipt(control), signal).ok).toBe(true);
    expect(repository.list(control.actor, [authority, authority])).toEqual({
      ok: true,
      value: [selected],
    });
    expect(repository.list(control.actor, [{ ...authority, scope: "session" }])).toEqual({
      ok: true,
      value: [],
    });
    expect(repository.list(bytesDigest("foreign-actor"), [authority])).toEqual({
      ok: true,
      value: [],
    });
    expect(repository.list(control.actor, [])).toEqual({ ok: true, value: [] });
    expect(
      repository.list(
        control.actor,
        Array.from({ length: 1_025 }, () => authority),
      ),
    ).toEqual({ ok: false, error: { code: "invalid-scope-authorities" } });
    expect(repository.list(control.actor, [{ ...authority, id: "" }])).toEqual({
      ok: false,
      error: { code: "invalid-scope-authorities" },
    });
  } finally {
    await store.close();
  }
});

test("authority index columns must agree with decoded control metadata", async () => {
  const { store, control, repository } = await setup();
  try {
    const committed = receipt(control);
    expect(repository.replace(control, committed, signal).ok).toBe(true);
    for (const columns of [
      { scope: "workspace", authority: control.authority.id },
      { scope: control.authority.scope, authority: "wrong-authority" },
    ]) {
      expect(
        store.write((sql) =>
          sql.run(
            "UPDATE extension_scope_controls SET scope=$scope,authority_id=$authority WHERE control_key=$key",
            { ...columns, key: committed.key },
          ),
        ).ok,
      ).toBe(true);
      expect(repository.get(committed.key)).toEqual({
        ok: false,
        error: { code: "corrupt-scope-store" },
      });
      expect(repository.list(control.actor)).toEqual({
        ok: false,
        error: { code: "corrupt-scope-store" },
      });
      const next = { ...control, revision: 2 };
      expect(repository.replace(next, receipt(next), signal)).toEqual({
        ok: false,
        error: { code: "corrupt-scope-store" },
      });
    }
  } finally {
    await store.close();
  }
});

test("foreign oversized metadata is not read or charged to selected authorities", async () => {
  const { store, control, repository } = await setup();
  try {
    expect(repository.replace(control, receipt(control), signal).ok).toBe(true);
    const foreign = {
      ...control,
      authority: { scope: "workspace" as const, id: "foreign", generation: 1 },
    };
    expect(repository.replace(foreign, receipt(foreign), signal).ok).toBe(true);
    expect(
      store.write((sql) =>
        sql.run(
          "UPDATE extension_scope_controls SET metadata=CAST(zeroblob(16777217) AS TEXT) WHERE control_key=$key",
          { key: scopeControlKey(foreign) },
        ),
      ).ok,
    ).toBe(true);
    expect(repository.list(control.actor, [{ scope: "user", id: control.authority.id }])).toEqual({
      ok: true,
      value: [control],
    });
    expect(repository.list(control.actor)).toEqual({
      ok: false,
      error: { code: "scope-metadata-limit" },
    });
    expect(repository.list(control.actor, [{ scope: "workspace", id: "foreign" }])).toEqual({
      ok: false,
      error: { code: "scope-metadata-limit" },
    });
  } finally {
    await store.close();
  }
});
