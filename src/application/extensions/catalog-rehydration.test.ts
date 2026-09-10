import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import { createScopeControlRepository } from "../../data/extensions/scope-control-repository.ts";
import {
  openProductStoreOrThrow,
  removeTemporaryRoots,
  temporaryRoot,
} from "../../data/fixtures.ts";
import { bytesDigest, canonicalDigest } from "../../domain/extensions/canonical.ts";
import { queryExtensionCatalog } from "../../domain/extensions/catalog.ts";
import { catalogFixture } from "../../domain/extensions/catalog-fixtures.ts";
import {
  type ScopeAuthority,
  type ScopeControl,
  scopeControlDigest,
  scopeControlKey,
} from "../../domain/extensions/scope-controls.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import {
  type CatalogContext,
  type CatalogTrust,
  createExtensionCatalogRehydrator,
} from "./catalog-rehydration.ts";
import { inspectionHost, packageSource } from "./package-fixtures.ts";
import { createPackageLifecycle } from "./package-lifecycle.ts";
import { createExtensionScopeControls } from "./scope-controls.ts";

afterEach(removeTemporaryRoots);
const signal = new AbortController().signal;
async function setup(scope: ScopeAuthority["scope"] = "user") {
  const root = await temporaryRoot("falryn-catalog-rehydration-");
  let store = await openProductStoreOrThrow(root);
  const bytes = createHostPackageCache(join(root, "packages"));
  const lifecycle = createPackageLifecycle(
    createPackageLifecycleRepository(store),
    bytes,
    inspectionHost,
  );
  const source = packageSource(undefined, {
    "skills/good/SKILL.md": "---\nname: good\ndescription: Good\n---\nSECRET-INSTRUCTIONS",
    "scripts/unused.ts": 'throw new Error("MUST NOT EXECUTE");',
  });
  const install = {
    packageId: "fixture",
    operationId: randomUUID(),
    expectedRevision: 0,
    retention: "retain" as const,
  };
  const preview = await lifecycle.run("install", install, signal, source);
  if (preview.confirmation === null) throw new Error("install-preview");
  const installed = await lifecycle.run(
    "install",
    { ...install, confirmation: preview.confirmation },
    signal,
    source,
  );
  if (installed.currentDigest === null) throw new Error("install");
  const actor = bytesDigest("actor");
  const authority = { scope, id: actor, generation: 1 };
  const scopeBinding = bytesDigest("host-scope-binding");
  let context: CatalogContext = {
    actor,
    configurationGeneration: 1,
    inputs: bytesDigest("host-inputs"),
    authorities: [{ authority, scopeBinding, admitted: true }],
  };
  let trust: CatalogTrust = { trust: "accepted", inputs: bytesDigest("trust-revision-1") };
  const controls = createExtensionScopeControls({
    store: createScopeControlRepository(store),
    packages: createPackageLifecycleRepository(store),
    bytes,
    host: inspectionHost,
    context: async () => ({
      actor,
      authority,
      scopeBinding,
      configurationGeneration: 1,
      inputs: context.inputs,
      admitted: true,
      narrowingOnly: false,
    }),
  });
  const request = {
    operationId: randomUUID(),
    expectedRevision: 0,
    packageIdentity: installed.currentDigest,
    choice: { enabled: true, preferred: false, explicitOnly: false },
  };
  const proposed = await controls.change("fixture", request, signal);
  if (proposed.status !== "preview") throw new Error(proposed.status);
  const enabled = await controls.change(
    "fixture",
    { ...request, confirmation: proposed.receipt.confirmation },
    signal,
  );
  if (enabled.status !== "applied") throw new Error(JSON.stringify(enabled));
  const options = () => ({
    store: createScopeControlRepository(store),
    packages: createPackageLifecycleRepository(store),
    bytes,
    host: inspectionHost,
    context: async () => context,
    trust: async () => trust,
  });
  return {
    options,
    database: () => store,
    lifecycle,
    source,
    close: () => store.close(),
    reopen: async () => {
      await store.close();
      store = await openProductStoreOrThrow(root);
    },
    context: () => context,
    setContext: (next: CatalogContext) => {
      context = next;
    },
    setTrust: (next: CatalogTrust) => {
      trust = next;
    },
  };
}

test("a real store reopen rehydrates a user skill in another session without descriptor preparation", async () => {
  const fixture = await setup();
  try {
    await fixture.reopen();
    const options = fixture.options();
    let reads = 0;
    const owner = createExtensionCatalogRehydrator({
      ...options,
      bytes: {
        async read(version, signal) {
          reads++;
          const snapshot = await options.bytes.read(version, signal);
          // Rehydration hashes bytes; decoding them as instructions would hit this trap.
          for (const file of snapshot.files)
            if (file.path.endsWith("SKILL.md"))
              file.bytes.toString = () => {
                throw new Error("instruction-body-decoded");
              };
          return snapshot;
        },
      },
    });
    const result = await owner.refresh(signal);
    expect(result.status).toBe("rehydrated");
    if (result.status !== "rehydrated") throw new Error(result.code);
    expect(result.catalog.entries).toHaveLength(1);
    expect(result.catalog.entries[0]).toMatchObject({
      enabled: true,
      availability: "unavailable",
      binding: null,
      reason: "native-owner-unavailable",
      contribution: { nativeKind: "skill" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET-INSTRUCTIONS");
    expect(JSON.stringify(result)).not.toContain("MUST NOT EXECUTE");
    expect(reads).toBe(2);
    expect(await owner.refresh(signal)).toEqual(result);
    expect(owner.current()).toBe(result.catalog);
  } finally {
    await fixture.close();
  }
});

test.each(["workspace", "process", "development"] as const)(
  "%s bindings require the same admitted host generation",
  async (scope) => {
    const fixture = await setup(scope);
    try {
      const owner = createExtensionCatalogRehydrator(fixture.options());
      const first = await owner.refresh(signal);
      if (first.status !== "rehydrated") throw new Error(first.code);
      expect(first.catalog.entries[0]?.enabled).toBe(true);
      const context = fixture.context();
      fixture.setContext({
        ...context,
        authorities: context.authorities.map((entry) => ({
          ...entry,
          scopeBinding: bytesDigest("replacement-admission"),
        })),
      });
      const changed = await owner.refresh(signal);
      if (changed.status !== "rehydrated") throw new Error(changed.code);
      expect(changed.catalog.entries[0]).toMatchObject({
        enabled: false,
        reason: "scope-authority-stale",
      });
      expect(first.catalog.entries[0]?.enabled).toBe(true);
      expect(() =>
        queryExtensionCatalog(changed.catalog, { catalog: first.catalog.identity }),
      ).toThrow("stale-catalog-handle");
      fixture.setContext({ ...context, authorities: [] });
      const restarted = await owner.refresh(signal);
      expect(restarted.status === "rehydrated" && restarted.catalog.entries).toEqual([]);
    } finally {
      await fixture.close();
    }
  },
);

test.each(["required", "revoked", "expired", "unknown"] as const)(
  "current %s trust never restores a previous enabled projection",
  async (trust) => {
    const fixture = await setup();
    try {
      const owner = createExtensionCatalogRehydrator(fixture.options());
      expect((await owner.refresh(signal)).status).toBe("rehydrated");
      fixture.setTrust({ trust, inputs: bytesDigest(trust) });
      const result = await owner.refresh(signal);
      expect(result.status === "rehydrated" && result.catalog.entries[0]).toMatchObject({
        enabled: false,
        trust,
        reason: `trust-${trust}`,
      });
    } finally {
      await fixture.close();
    }
  },
);

test.each(["disable", "uninstall", "update"] as const)(
  "lifecycle %s invalidates the exact saved choice without losing diagnostic identity",
  async (action) => {
    const fixture = await setup();
    try {
      const owner = createExtensionCatalogRehydrator(fixture.options());
      const before = await owner.refresh(signal);
      if (before.status !== "rehydrated") throw new Error(before.code);
      const request = {
        operationId: randomUUID(),
        packageId: "fixture",
        expectedRevision: 1,
        retention: "retain" as const,
      };
      const source =
        action === "update"
          ? packageSource(undefined, {
              "skills/new/SKILL.md": "---\nname: new\ndescription: New\n---\nNEW",
            })
          : undefined;
      const preview = await fixture.lifecycle.run(action, request, signal, source);
      if (preview.confirmation === null) throw new Error(preview.code);
      const applied = await fixture.lifecycle.run(
        action,
        { ...request, confirmation: preview.confirmation },
        signal,
        source,
      );
      expect(applied.status).toBe("completed");
      const result = await owner.refresh(signal);
      if (result.status !== "rehydrated") throw new Error(result.code);
      expect(result.catalog.entries[0]?.enabled).toBe(false);
      expect(result.catalog.entries[0]?.contribution).toEqual(
        before.catalog.entries[0]?.contribution,
      );
      expect(result.catalog.entries[0]?.lifecycle).toBe(
        action === "uninstall" ? "missing" : action === "update" ? "changed" : "disabled",
      );
    } finally {
      await fixture.close();
    }
  },
);

test("changed compatibility inputs and missing bytes remain inspectable but disabled", async () => {
  const fixture = await setup();
  try {
    const options = fixture.options();
    const changed = createExtensionCatalogRehydrator({
      ...options,
      host: { ...inspectionHost, bun: "99.0.0" },
    });
    const result = await changed.refresh(signal);
    expect(result.status === "rehydrated" && result.catalog.entries[0]).toMatchObject({
      compatibility: "unknown",
      enabled: false,
    });
    const missing = createExtensionCatalogRehydrator({
      ...options,
      bytes: {
        read: async () => {
          throw new Error("ENOENT");
        },
      },
    });
    const absent = await missing.refresh(signal);
    expect(absent.status === "rehydrated" && absent.catalog.entries[0]).toMatchObject({
      lifecycle: "changed",
      enabled: false,
    });
  } finally {
    await fixture.close();
  }
});

test("changing authority and bytes during a refresh retain the previous immutable snapshot", async () => {
  const fixture = await setup();
  try {
    const options = fixture.options();
    let change = false;
    const owner = createExtensionCatalogRehydrator({
      ...options,
      bytes: {
        async read(version, signal) {
          const snapshot = await options.bytes.read(version, signal);
          if (change) fixture.setTrust({ trust: "revoked", inputs: bytesDigest("revocation") });
          return snapshot;
        },
      },
    });
    await owner.refresh(signal);
    const prior = owner.current();
    change = true;
    expect(await owner.refresh(signal)).toEqual({ status: "failed", code: "stale-catalog-inputs" });
    expect(owner.current()).toBe(prior);
    const next = await owner.refresh(signal);
    expect(next.status === "rehydrated" && next.catalog.entries[0]?.enabled).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("cancelled, malformed and over-limit captures return failures rather than empty success", async () => {
  const fixture = await setup();
  try {
    const options = fixture.options();
    const owner = createExtensionCatalogRehydrator(options);
    expect(await owner.refresh(AbortSignal.abort())).toEqual({
      status: "failed",
      code: "cancelled",
    });
    const records = options.store.list(fixture.context().actor);
    if (!records.ok || records.value[0] === undefined) throw new Error("controls");
    const record: ScopeControl = records.value[0];
    const excessive = createExtensionCatalogRehydrator({
      ...options,
      store: { list: () => ({ ok: true, value: Array.from({ length: 1_025 }, () => record) }) },
    });
    expect(await excessive.refresh(signal)).toEqual({
      status: "failed",
      code: "scope-control-limit",
    });
    const malformed = createExtensionCatalogRehydrator({
      ...options,
      store: { list: () => ({ ok: true, value: [{ ...record, actor: bytesDigest("foreign") }] }) },
    });
    expect(await malformed.refresh(signal)).toEqual({
      status: "failed",
      code: "scope-actor-mismatch",
    });
  } finally {
    await fixture.close();
  }
});

test("overlapping refresh cannot publish over the first owner and host package injection is rejected", async () => {
  const fixture = await setup();
  try {
    const options = fixture.options();
    const barrier = Promise.withResolvers<void>();
    const owner = createExtensionCatalogRehydrator({
      ...options,
      context: async () => {
        await barrier.promise;
        return fixture.context();
      },
    });
    const first = owner.refresh(signal);
    expect(await owner.refresh(signal)).toEqual({
      status: "failed",
      code: "catalog-refresh-in-progress",
    });
    barrier.resolve();
    expect((await first).status).toBe("rehydrated");
    const injected = createExtensionCatalogRehydrator({
      ...options,
      independent: async () => [catalogFixture()],
    });
    expect(await injected.refresh(signal)).toEqual({
      status: "failed",
      code: "unreconciled-package-entry",
    });
    const builtin = catalogFixture("builtin", "builtin");
    const mixed = createExtensionCatalogRehydrator({
      ...options,
      independent: async () => [builtin],
    });
    const result = await mixed.refresh(signal);
    if (result.status !== "rehydrated") throw new Error(result.code);
    expect(result.catalog.entries).toHaveLength(2);
    expect(
      result.catalog.entries.find(
        (entry) => canonicalDigest(entry.source.owner) === canonicalDigest(builtin.source.owner),
      ),
    ).toEqual(builtin);
  } finally {
    await fixture.close();
  }
});

test("foreign durable history neither blocks reconciliation nor invalidates selected snapshots", async () => {
  const fixture = await setup();
  try {
    const context = fixture.context();
    const options = fixture.options();
    const owner = createExtensionCatalogRehydrator(options);
    const before = await owner.refresh(signal);
    if (before.status !== "rehydrated") throw new Error(before.code);
    const records = options.store.list(context.actor);
    const control = records.ok ? records.value[0] : undefined;
    if (control === undefined) throw new Error("missing-control");
    // Reuse valid bounded metadata, with distinct exact authority identities.
    expect(
      fixture.database().write((sql) => {
        for (let index = 0; index < 1_025; index++) {
          const foreign: ScopeControl = {
            ...control,
            authority: {
              scope: index % 2 === 0 ? "workspace" : "session",
              id: `old-${index}`,
              generation: 1,
            },
          };
          sql.run(
            "INSERT INTO extension_scope_controls(control_key,actor,scope,authority_id,revision,digest,metadata) VALUES($key,$actor,$scope,$authority,$revision,$digest,$metadata)",
            {
              key: scopeControlKey(foreign),
              actor: foreign.actor,
              scope: foreign.authority.scope,
              authority: foreign.authority.id,
              revision: foreign.revision,
              digest: scopeControlDigest(foreign),
              metadata: JSON.stringify(foreign),
            },
          );
        }
      }).ok,
    ).toBe(true);
    expect(await owner.refresh(signal)).toEqual(before);
    expect(owner.current()).toBe(before.catalog);
    expect(options.store.list(context.actor)).toEqual({
      ok: false,
      error: { code: "scope-control-limit" },
    });
    await fixture.reopen();
    expect(await createExtensionCatalogRehydrator(fixture.options()).refresh(signal)).toEqual(
      before,
    );
    fixture.setContext({
      ...context,
      authorities: [
        {
          authority: { scope: "workspace", id: "new-workspace", generation: 1 },
          scopeBinding: bytesDigest("new-binding"),
          admitted: true,
        },
      ],
    });
    const empty = await createExtensionCatalogRehydrator(fixture.options()).refresh(signal);
    expect(empty.status === "rehydrated" && empty.catalog.entries).toEqual([]);
    fixture.setContext({
      ...context,
      authorities: context.authorities.map((entry) => ({
        ...entry,
        authority: { ...entry.authority, generation: 2 },
      })),
    });
    const stale = await createExtensionCatalogRehydrator(fixture.options()).refresh(signal);
    expect(stale.status === "rehydrated" && stale.catalog.entries[0]).toMatchObject({
      enabled: false,
      reason: "scope-authority-stale",
    });
    expect(
      fixture.database().read("SELECT count(*) AS count FROM extension_scope_controls"),
    ).toEqual({ ok: true, value: [{ count: 1_026 }] });
  } finally {
    await fixture.close();
  }
});
