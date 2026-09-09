import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import {
  openProductStoreOrThrow,
  removeTemporaryRoots,
  temporaryRoot,
} from "../../data/fixtures.ts";
import type {
  PackageAction,
  PackageBytes,
  PackageRequest,
} from "../../domain/extensions/lifecycle.ts";
import type { PackageSource } from "../../domain/extensions/package-source.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { inspectionHost, packageSource, pluginManifest } from "./package-fixtures.ts";
import { createPackageLifecycle } from "./package-lifecycle.ts";

afterEach(removeTemporaryRoots);
test("cleanup excludes candidates created after confirmation and equal counts cannot reuse stale consent", async () => {
  const { store, owner, repository, cache } = await setup();
  try {
    await apply(owner, "install", request(), packageSource());
    const current = repository.current("fixture");
    if (!current.ok || current.value.current === null) throw new Error("installed");
    const base = current.value.current;
    const a = { ...base, storageId: randomUUID(), state: "staged" as const };
    const epoch = repository.stage(a);
    if (!epoch.ok) throw new Error("stage");
    const req = request(1);
    const preview = await owner.run("recover", req, signal);
    repository.cleanup("fixture", 64, epoch.value);
    repository.removed(a.storageId);
    expect(repository.stage({ ...a, storageId: randomUUID() }).ok).toBe(true);
    if (preview.confirmation === null) throw new Error("preview");
    expect(
      await owner.run("recover", { ...req, confirmation: preview.confirmation }, signal),
    ).toMatchObject({ code: "stale-package-confirmation" });
    let created = false;
    const interleaved = createPackageLifecycle(
      {
        ...repository,
        cleanup(id, limit, throughEpoch) {
          if (!created) {
            created = true;
            expect(repository.stage({ ...a, storageId: randomUUID() }).ok).toBe(true);
          }
          return repository.cleanup(id, limit, throughEpoch);
        },
      },
      cache,
      inspectionHost,
    );
    expect(
      await apply(interleaved, "uninstall", request(1, { retention: "remove" })),
    ).toMatchObject({ status: "partial", pendingCleanup: 1 });
    expect(await apply(owner, "recover", request(2))).toMatchObject({
      status: "completed",
      pendingCleanup: 0,
    });
  } finally {
    await store.close();
  }
});
for (const phase of ["before-bytes", "after-bytes", "after-commit"]) {
  test(`abrupt process exit ${phase} reconciles one complete installed generation`, async () => {
    const { root, store, owner, cache } = await setup();
    const installed = await apply(owner, "install", request(), packageSource());
    await store.close();
    const child = Bun.spawnSync(
      [
        process.execPath,
        new URL("./package-crash-fixtures.ts", import.meta.url).pathname,
        root,
        phase,
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 30_000 },
    );
    expect(child.exitCode).toBe(phase === "after-commit" ? 78 : 77);
    const recovered = await openProductStoreOrThrow(root);
    try {
      const live = createPackageLifecycle(
        createPackageLifecycleRepository(recovered),
        cache,
        inspectionHost,
      );
      const observed = await live.run("inspect", request(), signal);
      expect(observed.status).toBe("completed");
      if (phase === "after-commit") {
        expect(observed.revision).toBe(2);
        expect(observed.currentDigest).not.toBe(installed.currentDigest);
      } else {
        expect(observed.currentDigest).toBe(installed.currentDigest);
        expect(observed.pendingCleanup).toBe(1);
        expect(await apply(live, "recover", request(1))).toMatchObject({
          status: "completed",
          pendingCleanup: 0,
        });
      }
    } finally {
      await recovered.close();
    }
  });
}
const signal = new AbortController().signal;
function request(revision = 0, extra: Partial<PackageRequest> = {}): PackageRequest {
  return {
    packageId: "fixture",
    operationId: randomUUID(),
    expectedRevision: revision,
    retention: "retain",
    ...extra,
  };
}
async function setup() {
  const root = await temporaryRoot("falryn-package-lifecycle-");
  const store = await openProductStoreOrThrow(root);
  const repository = createPackageLifecycleRepository(store);
  const cache = createHostPackageCache(join(root, "packages"));
  const owner = createPackageLifecycle(repository, cache, inspectionHost);
  return { root, store, repository, cache, owner };
}
async function apply(
  owner: ReturnType<typeof createPackageLifecycle>,
  action: PackageAction,
  req: PackageRequest,
  source?: PackageSource,
) {
  const preview = await owner.run(action, req, signal, source);
  expect(preview.status).toBe("preview");
  if (preview.confirmation === null) throw new Error(JSON.stringify(preview));
  return owner.run(action, { ...req, confirmation: preview.confirmation }, signal, source);
}

test("real cache and SQLite install, update, restart, offline rollback and uninstall retain exact identities", async () => {
  const { root, store, owner } = await setup();
  const first = await apply(owner, "install", request(), packageSource());
  expect(first).toMatchObject({
    status: "completed",
    revision: 1,
    activation: "unavailable",
    pendingCleanup: 0,
  });
  const updated = await apply(
    owner,
    "update",
    request(1),
    packageSource(pluginManifest(undefined, { version: "2.0.0" })),
  );
  expect(updated).toMatchObject({ status: "completed", revision: 2, retainedVersions: 2 });
  expect(updated.currentDigest).not.toBe(first.currentDigest);
  await store.close();
  const reopened = await openProductStoreOrThrow(root);
  try {
    const owner = createPackageLifecycle(
      createPackageLifecycleRepository(reopened),
      createHostPackageCache(join(root, "packages")),
      inspectionHost,
    );
    const rolled = await apply(
      owner,
      "rollback",
      request(2, { versionDigest: first.currentDigest ?? undefined }),
    );
    expect(rolled).toMatchObject({
      status: "completed",
      revision: 3,
      currentDigest: first.currentDigest,
    });
    expect(await owner.run("enable", request(3), signal)).toMatchObject({
      status: "failed",
      code: "activation-owner-unavailable",
    });
    expect(await apply(owner, "disable", request(3))).toMatchObject({
      status: "completed",
      revision: 4,
    });
    expect(await apply(owner, "uninstall", request(4, { retention: "remove" }))).toMatchObject({
      status: "completed",
      revision: 5,
      currentDigest: null,
      pendingCleanup: 0,
      retainedVersions: 0,
    });
    expect(await readdir(join(root, "packages"))).toEqual([]);
  } finally {
    await reopened.close();
  }
});

test("confirmation binds exact source bytes and revision; operation replay has no duplicate writes", async () => {
  const { store, owner, root } = await setup();
  try {
    const req = request();
    const preview = await owner.run("install", req, signal, packageSource());
    if (preview.confirmation === null) throw new Error("preview");
    const confirmed = { ...req, confirmation: preview.confirmation };
    expect(
      await owner.run(
        "install",
        confirmed,
        signal,
        packageSource(pluginManifest(undefined, { version: "2.0.0" })),
      ),
    ).toMatchObject({ status: "failed", code: "stale-package-confirmation" });
    const result = await owner.run("install", confirmed, signal, packageSource());
    expect(result.status).toBe("completed");
    expect(await owner.run("install", confirmed, signal, packageSource())).toEqual(result);
    expect(await readdir(join(root, "packages"))).toHaveLength(1);
    expect(await owner.run("disable", { ...confirmed }, signal)).toMatchObject({
      code: "operation-id-reused",
    });
    expect(await owner.run("disable", request(0), signal)).toMatchObject({
      code: "stale-package-revision",
    });
  } finally {
    await store.close();
  }
});

test("interruption after bytes publish preserves old generation and recover removes only the uncommitted candidate", async () => {
  const { store, root, owner, repository, cache } = await setup();
  const first = await apply(owner, "install", request(), packageSource());
  const interrupted: PackageBytes = {
    ...cache,
    stage(id, snapshot, signal) {
      cache.stage(id, snapshot, signal);
      throw new Error("simulated-stop-before-SQL-publication");
    },
  };
  const faulty = createPackageLifecycle(repository, interrupted, inspectionHost);
  expect(
    await apply(
      faulty,
      "update",
      request(1),
      packageSource(pluginManifest(undefined, { version: "2.0.0" })),
    ),
  ).toMatchObject({ status: "uncertain", revision: 1, pendingCleanup: 1 });
  await store.close();
  const reopened = await openProductStoreOrThrow(root);
  try {
    const live = createPackageLifecycle(
      createPackageLifecycleRepository(reopened),
      cache,
      inspectionHost,
    );
    expect(await live.run("inspect", request(1), signal)).toMatchObject({
      currentDigest: first.currentDigest,
      pendingCleanup: 1,
    });
    expect(await apply(live, "recover", request(1))).toMatchObject({
      status: "completed",
      currentDigest: first.currentDigest,
      pendingCleanup: 0,
    });
    expect(await readdir(join(root, "packages"))).toHaveLength(1);
  } finally {
    await reopened.close();
  }
});

test("corrupted retained bytes cannot roll back; unsupported entries, incompatible candidates and cancellation publish nothing", async () => {
  const { store, owner, repository, root } = await setup();
  try {
    const first = await apply(owner, "install", request(), packageSource());
    await apply(
      owner,
      "update",
      request(1),
      packageSource(pluginManifest(undefined, { version: "2.0.0" })),
    );
    const version = repository.version("fixture", first.currentDigest ?? "");
    if (!version.ok || version.value === null) throw new Error("version");
    const path = join(root, "packages", `${version.value.storageId}.package`);
    const bytes = await readFile(path);
    bytes[bytes.length - 1] = 0;
    await writeFile(path, bytes);
    expect(
      await owner.run(
        "rollback",
        request(2, { versionDigest: first.currentDigest ?? undefined }),
        signal,
      ),
    ).toMatchObject({ status: "failed" });
    expect(
      await owner.run(
        "update",
        request(2),
        signal,
        packageSource(pluginManifest({ version: 1, compatibility: { falryn: ">=99.0.0" } })),
      ),
    ).toMatchObject({ code: "package-incompatible" });
    expect(await owner.run("disable", request(2), AbortSignal.abort())).toMatchObject({
      code: "cancelled",
    });
    const source = packageSource();
    const snapshot = await source.read();
    expect(
      await owner.run("update", request(2), signal, {
        read: async () => ({ ...snapshot, diagnostics: [{ code: "unsupported-package-entry" }] }),
      }),
    ).toMatchObject({ code: "incomplete-package-inventory" });
  } finally {
    await store.close();
  }
});

test("uninstall refuses live dependents and candidate validation cannot bypass missing dependencies", async () => {
  const { store, owner } = await setup();
  try {
    const dependent = packageSource(
      pluginManifest(
        { version: 1, dependencies: [{ id: "fixture", range: "^1.0.0" }] },
        { name: "dependent" },
      ),
    );
    expect(
      await owner.run("install", request(0, { packageId: "dependent" }), signal, dependent),
    ).toMatchObject({ code: "dependency-unavailable" });
    await apply(owner, "install", request(), packageSource());
    expect(
      await owner.run(
        "update",
        request(1),
        signal,
        packageSource(
          pluginManifest({ version: 1, dependencies: [{ id: "fixture", range: "*" }] }),
        ),
      ),
    ).toMatchObject({ code: "dependency-cycle" });
    expect(
      await apply(owner, "install", request(0, { packageId: "dependent" }), dependent),
    ).toMatchObject({ status: "completed" });
    expect(await apply(owner, "uninstall", request(1, { retention: "remove" }))).toMatchObject({
      status: "failed",
      code: "package-required",
      revision: 1,
    });
  } finally {
    await store.close();
  }
});

test("partial cleanup is visible and symlink targets are never removed", async () => {
  const { store, owner, cache, repository, root } = await setup();
  try {
    await apply(owner, "install", request(), packageSource());
    const faulty = createPackageLifecycle(
      repository,
      {
        ...cache,
        remove: async () => {
          throw new Error("locked-file");
        },
      },
      inspectionHost,
    );
    expect(await apply(faulty, "uninstall", request(1, { retention: "remove" }))).toMatchObject({
      status: "partial",
      revision: 2,
      pendingCleanup: 1,
      recovery: "recover",
    });
    const outside = join(root, "user.txt");
    await writeFile(outside, "retain this");
    await symlink(outside, join(root, "packages", `${randomUUID()}.package`));
    expect(await apply(owner, "recover", request(2))).toMatchObject({
      status: "completed",
      pendingCleanup: 0,
    });
    expect(await readFile(outside, "utf8")).toBe("retain this");
    expect(await readdir(join(root, "packages"))).toHaveLength(1);
  } finally {
    await store.close();
  }
});
