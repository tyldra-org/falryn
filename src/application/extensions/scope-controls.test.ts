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
import type { PackageBytes } from "../../domain/extensions/lifecycle.ts";
import type { ScopeRequest } from "../../domain/extensions/scope-controls.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { inspectionHost, packageSource, pluginManifest } from "./package-fixtures.ts";
import { createPackageLifecycle } from "./package-lifecycle.ts";
import { createExtensionScopeControls, type ScopeContext } from "./scope-controls.ts";

afterEach(removeTemporaryRoots);
const signal = new AbortController().signal;
async function setup() {
  const root = await temporaryRoot("falryn-scope-action-");
  const store = await openProductStoreOrThrow(root);
  const records = createScopeControlRepository(store);
  const packages = createPackageLifecycleRepository(store);
  const bytes = createHostPackageCache(join(root, "packages"));
  const lifecycle = createPackageLifecycle(packages, bytes, inspectionHost);
  const source = packageSource(pluginManifest({ version: 1, scopes: ["user", "session"] }), {
    "skills/good/SKILL.md": "---\nname: good\ndescription: Good\n---\nPRIVATE-INSTRUCTION",
    "scripts/unused.ts": 'throw new Error("MUST NOT EXECUTE");',
  });
  const install = {
    packageId: "fixture",
    expectedRevision: 0,
    operationId: randomUUID(),
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
  if (installed.status !== "completed" || installed.currentDigest === null)
    throw new Error("install");
  let context: ScopeContext = {
    actor: bytesDigest("actor"),
    authority: { scope: "user", id: bytesDigest("actor"), generation: 1 },
    scopeBinding: bytesDigest("user-binding"),
    configurationGeneration: 1,
    inputs: bytesDigest("current-trust-policy"),
    admitted: true,
    narrowingOnly: false,
  };
  const options = {
    store: records,
    packages,
    bytes,
    host: inspectionHost,
    context: async () => context,
  };
  const owner = createExtensionScopeControls(options);
  const request = (changes: Partial<ScopeRequest> = {}): ScopeRequest => ({
    operationId: randomUUID(),
    expectedRevision: 0,
    packageIdentity: installed.currentDigest ?? "",
    choice: { enabled: true, preferred: false, explicitOnly: false },
    ...changes,
  });
  return {
    store,
    records,
    packages,
    bytes,
    lifecycle,
    owner,
    options,
    request,
    getContext: () => context,
    setContext: (next: ScopeContext) => {
      context = next;
    },
  };
}

test("a confirmed exact package choice persists only compact metadata and replays its operation", async () => {
  const fixture = await setup();
  try {
    const request = fixture.request();
    const preview = await fixture.owner.change("fixture", request, signal);
    expect(preview.status).toBe("preview");
    if (preview.status !== "preview") throw new Error("scope-preview");
    expect(fixture.records.get(preview.receipt.key)).toEqual({ ok: true, value: null });
    const confirmed = { ...request, confirmation: preview.receipt.confirmation };
    const result = await fixture.owner.change("fixture", confirmed, signal);
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("scope-commit");
    const record = fixture.records.get(preview.receipt.key);
    expect(record.ok && record.value?.choice.enabled).toBe(true);
    if (!record.ok || record.value === null) throw new Error("scope-record");
    expect(record.value.contributions.map((entry) => entry.identity.nativeKind)).toEqual(["skill"]);
    expect(JSON.stringify(record.value)).not.toContain("PRIVATE-INSTRUCTION");
    expect(JSON.stringify(record.value)).not.toContain("MUST NOT EXECUTE");
    expect(await fixture.owner.change("fixture", confirmed, signal)).toEqual({
      ...result,
      replayed: true,
    });
    expect(
      await fixture.owner.change(
        "fixture",
        { ...confirmed, choice: { ...request.choice, enabled: false } },
        signal,
      ),
    ).toEqual({ status: "failed", code: "scope-operation-conflict" });
  } finally {
    await fixture.store.close();
  }
});

test("exact identity, scope declarations and revision checks reject broader or stale requests", async () => {
  const fixture = await setup();
  try {
    expect(
      await fixture.owner.change(
        "fixture",
        fixture.request({ packageIdentity: bytesDigest("replacement") }),
        signal,
      ),
    ).toEqual({ status: "failed", code: "exact-package-unavailable" });
    expect(
      await fixture.owner.change(
        "fixture",
        fixture.request({ contribution: bytesDigest("missing") }),
        signal,
      ),
    ).toEqual({ status: "failed", code: "exact-contribution-unavailable" });
    expect(
      await fixture.owner.change("fixture", fixture.request({ expectedRevision: 1 }), signal),
    ).toEqual({ status: "failed", code: "stale-scope-revision" });
    fixture.setContext({
      ...fixture.getContext(),
      authority: { scope: "workspace", id: bytesDigest("workspace"), generation: 1 },
    });
    expect(await fixture.owner.change("fixture", fixture.request(), signal)).toEqual({
      status: "failed",
      code: "scope-not-declared",
    });
    fixture.setContext({ ...fixture.getContext(), admitted: false });
    expect(await fixture.owner.change("fixture", fixture.request(), signal)).toEqual({
      status: "failed",
      code: "scope-authority-unavailable",
    });
  } finally {
    await fixture.store.close();
  }
});

test("changed trust/policy inputs invalidate prior confirmation without committing a choice", async () => {
  const fixture = await setup();
  try {
    const request = fixture.request();
    const preview = await fixture.owner.change("fixture", request, signal);
    if (preview.status !== "preview") throw new Error("scope-preview");
    fixture.setContext({ ...fixture.getContext(), inputs: bytesDigest("revoked-trust") });
    expect(
      await fixture.owner.change(
        "fixture",
        { ...request, confirmation: preview.receipt.confirmation },
        signal,
      ),
    ).toEqual({ status: "failed", code: "stale-scope-confirmation" });
    expect(fixture.records.operation(request.operationId)).toEqual({ ok: true, value: null });
  } finally {
    await fixture.store.close();
  }
});

test("a changed host authority at publication preserves prior durable state", async () => {
  const fixture = await setup();
  try {
    const request = fixture.request();
    const preview = await fixture.owner.change("fixture", request, signal);
    if (preview.status !== "preview") throw new Error("scope-preview");
    let reads = 0;
    const owner = createExtensionScopeControls({
      ...fixture.options,
      context: async () => {
        reads++;
        return reads === 1
          ? fixture.getContext()
          : { ...fixture.getContext(), scopeBinding: bytesDigest("changed-roots") };
      },
    });
    expect(
      await owner.change(
        "fixture",
        { ...request, confirmation: preview.receipt.confirmation },
        signal,
      ),
    ).toEqual({ status: "failed", code: "stale-scope-authority" });
    expect(fixture.records.get(preview.receipt.key)).toEqual({ ok: true, value: null });
  } finally {
    await fixture.store.close();
  }
});

test("changed retained bytes after confirmation fail before the scope transaction", async () => {
  const fixture = await setup();
  try {
    const request = fixture.request();
    const preview = await fixture.owner.change("fixture", request, signal);
    if (preview.status !== "preview") throw new Error("scope-preview");
    let reads = 0;
    const bytes: PackageBytes = {
      ...fixture.bytes,
      async read(version, signal) {
        const snapshot = await fixture.bytes.read(version, signal);
        if (++reads === 1) return snapshot;
        return {
          ...snapshot,
          files: snapshot.files.map((file) => ({
            ...file,
            bytes: new TextEncoder().encode("changed"),
          })),
        };
      },
    };
    const owner = createExtensionScopeControls({ ...fixture.options, bytes });
    expect(
      await owner.change(
        "fixture",
        { ...request, confirmation: preview.receipt.confirmation },
        signal,
      ),
    ).toEqual({ status: "failed", code: "package-bytes-changed" });
    expect(fixture.records.operation(request.operationId)).toEqual({ ok: true, value: null });
  } finally {
    await fixture.store.close();
  }
});

test("contribution choices remain exact and cannot implicitly enable the package", async () => {
  const fixture = await setup();
  try {
    const initial = fixture.request({
      choice: { enabled: false, preferred: false, explicitOnly: false },
    });
    const preview = await fixture.owner.change("fixture", initial, signal);
    if (preview.status !== "preview") throw new Error("scope-preview");
    expect(
      (
        await fixture.owner.change(
          "fixture",
          { ...initial, confirmation: preview.receipt.confirmation },
          signal,
        )
      ).status,
    ).toBe("applied");
    const record = fixture.records.get(preview.receipt.key);
    if (!record.ok || record.value?.contributions[0] === undefined) throw new Error("scope-record");
    const contribution = canonicalDigest(record.value.contributions[0].identity);
    const request = fixture.request({
      expectedRevision: 1,
      contribution,
      choice: { enabled: true, preferred: true, explicitOnly: true },
    });
    const update = await fixture.owner.change("fixture", request, signal);
    if (update.status !== "preview") throw new Error("update-preview");
    expect(
      (
        await fixture.owner.change(
          "fixture",
          { ...request, confirmation: update.receipt.confirmation },
          signal,
        )
      ).status,
    ).toBe("applied");
    const changed = fixture.records.get(preview.receipt.key);
    expect(changed.ok && changed.value?.choice.enabled).toBe(false);
    expect(changed.ok && changed.value?.overrides[0]?.contribution).toBe(contribution);
    // A historical operation reports its receipt, never restores revision 1 over revision 2.
    expect(
      await fixture.owner.change(
        "fixture",
        { ...initial, confirmation: preview.receipt.confirmation },
        signal,
      ),
    ).toMatchObject({ status: "applied", replayed: true });
    expect(fixture.records.get(preview.receipt.key)).toEqual(changed);
  } finally {
    await fixture.store.close();
  }
});

test("cancellation cannot disguise an uncertain scope write", async () => {
  const fixture = await setup();
  try {
    const request = fixture.request();
    const preview = await fixture.owner.change("fixture", request, signal);
    if (preview.status !== "preview") throw new Error("scope-preview");
    const cancellation = new AbortController();
    const owner = createExtensionScopeControls({
      ...fixture.options,
      store: {
        ...fixture.records,
        replace() {
          cancellation.abort();
          return { ok: false, error: { code: "uncertain" } };
        },
      },
    });
    expect(
      await owner.change(
        "fixture",
        { ...request, confirmation: preview.receipt.confirmation },
        cancellation.signal,
      ),
    ).toEqual({ status: "failed", code: "uncertain" });
  } finally {
    await fixture.store.close();
  }
});
