import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createPackageHealthRepository } from "../../data/extensions/package-health-repository.ts";
import { createPackageLifecycleRepository } from "../../data/extensions/package-lifecycle-repository.ts";
import {
  openProductStoreOrThrow,
  removeTemporaryRoots,
  temporaryRoot,
} from "../../data/fixtures.ts";
import { bytesDigest, canonicalDigest } from "../../domain/extensions/canonical.ts";
import { packageRequestSchema } from "../../domain/extensions/lifecycle.ts";
import {
  PACKAGE_HEALTH_PROTOCOL,
  type PackageHealthRecord,
} from "../../domain/extensions/package-health.ts";
import { createSystemClock } from "../../domain/foundation/index.ts";
import { ok } from "../../domain/foundation/result.ts";
import type { ResourceAmounts } from "../../domain/orchestration/resource-admission.ts";
import { createHostPackageCache } from "../../integrations/extensions/host-package-cache.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import {
  declaredAuthority,
  executionResources,
  inspectionHost,
  packageSource,
  pluginManifest,
} from "./package-fixtures.ts";
import { createPackageHealth, type PackageHealthAuthority } from "./package-health.ts";
import { createPackageLifecycle } from "./package-lifecycle.ts";
import { preparePackage } from "./prepare-package.ts";

afterEach(removeTemporaryRoots);
async function setup(
  input: {
    limits?: ResourceAmounts;
    failed?: boolean;
    uncertain?: boolean;
    mode?: string;
    dependencies?: unknown[];
    graph?: boolean;
    diamond?: boolean;
  } = {},
) {
  const root = await temporaryRoot("falryn-health-admission-");
  const store = await openProductStoreOrThrow(root);
  const packages = createPackageLifecycleRepository(store);
  const bytes = createHostPackageCache(join(root, "packages"));
  const declaration = {
    kind: "tool",
    namespace: "fixture",
    id: "health",
    description: "health",
    family: "read",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    authority: { ...declaredAuthority, effects: ["observation"] },
    execution: {
      mode: input.mode ?? "governed",
      executable: "peer",
      loader: "native",
      protocolVersion: PACKAGE_HEALTH_PROTOCOL,
      compatibility: { os: ["darwin"], arch: ["arm64"] },
      resources: executionResources,
    },
  };
  const source = packageSource(
    pluginManifest({
      version: 1,
      dependencies: input.graph
        ? [
            { id: "dependency", range: "^1.0.0" },
            ...(input.diamond ? [{ id: "other", range: "^1.0.0" }] : []),
          ]
        : (input.dependencies ?? []),
      contributions: [declaration],
      files: [{ path: "peer", digest: bytesDigest("fixture") }],
    }),
    { peer: "fixture" },
  );
  const lifecycle = createPackageLifecycle(packages, bytes, inspectionHost);
  const install = packageRequestSchema.parse({
    packageId: "fixture",
    operationId: randomUUID(),
    expectedRevision: 0,
  });
  const signal = new AbortController().signal;
  if (input.graph) {
    for (const name of ["leaf", "dependency", ...(input.diamond ? ["other"] : [])]) {
      const dependencySource = packageSource(
        pluginManifest(
          {
            version: 1,
            dependencies: name !== "leaf" ? [{ id: "leaf", range: "^1.0.0" }] : [],
          },
          { name },
        ),
      );
      const dependencyRequest = { ...install, packageId: name, operationId: randomUUID() };
      const preview = await lifecycle.run("install", dependencyRequest, signal, dependencySource);
      expect(preview.status).toBe("preview");
      expect(
        (
          await lifecycle.run(
            "install",
            { ...dependencyRequest, confirmation: preview.confirmation ?? "" },
            signal,
            dependencySource,
          )
        ).status,
      ).toBe("completed");
    }
  }
  const preview = await lifecycle.run("install", install, signal, source);
  expect(preview.status).toBe("preview");
  expect(
    (
      await lifecycle.run(
        "install",
        { ...install, confirmation: preview.confirmation ?? "" },
        signal,
        source,
      )
    ).status,
  ).toBe("completed");
  const prepared = await preparePackage(source, inspectionHost);
  if (!prepared.ok) throw new Error(prepared.code);
  const contribution = prepared.package.contributions[0]?.identityDigest;
  const request = packageRequestSchema.parse({
    packageId: "fixture",
    operationId: randomUUID(),
    expectedRevision: 1,
    health: { contribution },
  });
  const resources = createProductResources(createSystemClock());
  const task = resources.openTask("health-test", input.limits);
  let authority: PackageHealthAuthority = {
    trusted: true,
    enabled: true,
    strict: true,
    catalogGeneration: 1,
    inputs: canonicalDigest("authority"),
  };
  const absent = new Set<string>();
  const authorities = new Map<string, Partial<PackageHealthAuthority>>();
  let calls = 0;
  const healthStore = createPackageHealthRepository(store);
  const host = { ...inspectionHost };
  const owner = createPackageHealth({
    packages: {
      current(id) {
        return absent.has(id)
          ? ok({ packageId: id, current: null, revision: 0 })
          : packages.current(id);
      },
    },
    bytes,
    store: healthStore,
    host,
    resources: task,
    authority: async (installed) => ({ ...authority, ...authorities.get(installed.packageId) }),
    execution: {
      async run({ record, save }) {
        calls++;
        const completed: PackageHealthRecord = {
          ...record,
          revision: record.revision + 1,
          result: {
            ...record.result,
            state: input.uncertain ? "uncertain" : input.failed ? "failed" : "healthy",
            code: input.failed ? "fixture-failed" : "health-completed",
            terminated: !input.uncertain,
            cleanup: "removed",
            requests: 4,
          },
        };
        save(completed);
        return completed;
      },
      async recover(record) {
        return {
          ...record,
          revision: record.revision + 1,
          result: {
            ...record.result,
            terminated: true,
            state: "recovered",
            code: "health-recovered",
            cleanup: "removed",
          },
        };
      },
    },
  });
  return {
    owner,
    host,
    request,
    signal,
    healthStore,
    packages,
    lifecycle,
    bytes,
    task,
    simulateMissing(id: string) {
      absent.add(id);
    },
    setPackageAuthority(id: string, value: Partial<PackageHealthAuthority>) {
      authorities.set(id, value);
    },
    calls: () => calls,
    setAuthority(value: Partial<PackageHealthAuthority>) {
      authority = { ...authority, ...value };
    },
    async close() {
      task.close();
      resources.shutdown();
      await store.close();
    },
  };
}

test("health confirmation binds authority and installed generation, and durable replay starts nothing", async () => {
  const f = await setup();
  try {
    const preview = await f.owner.run(f.request, f.signal);
    expect(preview.status).toBe("preview");
    expect(f.calls()).toBe(0);
    f.setAuthority({ inputs: canonicalDigest("changed") });
    expect(
      (await f.owner.run({ ...f.request, confirmation: preview.confirmation ?? "" }, f.signal))
        .code,
    ).toBe("stale-health-confirmation");
    const fresh = await f.owner.run(f.request, f.signal);
    const confirmed = { ...f.request, confirmation: fresh.confirmation ?? "" };
    expect((await f.owner.run(confirmed, f.signal)).status).toBe("completed");
    expect((await f.owner.run(confirmed, f.signal)).status).toBe("completed");
    expect(f.calls()).toBe(1);
    expect((await f.owner.run({ ...confirmed, expectedRevision: 2 }, f.signal)).code).toBe(
      "operation-id-reused",
    );
  } finally {
    await f.close();
  }
});

test("unknown native memory usage cannot bypass an inherited memory ceiling", async () => {
  const f = await setup({ limits: { memoryBytes: 1_000_000 } });
  try {
    const preview = await f.owner.run(f.request, f.signal);
    expect(
      (await f.owner.run({ ...f.request, confirmation: preview.confirmation ?? "" }, f.signal))
        .code,
    ).toBe("quota-unknown");
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});
for (const [change, code] of [
  [{ trusted: false }, "package-trust-required"],
  [{ enabled: false }, "dependency-disabled"],
  [{ strict: false }, "strict-sandbox-policy-required"],
] as const)
  test(`health refuses ${code} before launch`, async () => {
    const f = await setup();
    try {
      f.setAuthority(change);
      expect((await f.owner.run(f.request, f.signal)).code).toBe(code);
      expect(f.calls()).toBe(0);
    } finally {
      await f.close();
    }
  });
test("full-user metadata cannot select the governed health runner", async () => {
  const f = await setup({ mode: "full-user" });
  try {
    expect((await f.owner.run(f.request, f.signal)).code).toBe("governed-execution-required");
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});
test("three observed failures quarantine only the exact contribution generation", async () => {
  const f = await setup({ failed: true });
  try {
    for (let i = 0; i < 3; i++) {
      const request = { ...f.request, operationId: randomUUID() };
      const preview = await f.owner.run(request, f.signal);
      expect(
        (await f.owner.run({ ...request, confirmation: preview.confirmation ?? "" }, f.signal))
          .code,
      ).toBe("fixture-failed");
    }
    expect((await f.owner.run({ ...f.request, operationId: randomUUID() }, f.signal)).code).toBe(
      "health-quarantined",
    );
    expect(f.calls()).toBe(3);
  } finally {
    await f.close();
  }
});
test("an unresolved stored launch fences replacement, and confirmed recovery never invokes code", async () => {
  const f = await setup({ uncertain: true });
  try {
    const preview = await f.owner.run(f.request, f.signal);
    await f.owner.run({ ...f.request, confirmation: preview.confirmation ?? "" }, f.signal);
    const stored = f.healthStore.get(f.request.operationId);
    if (!stored.ok || !stored.value) throw new Error("missing attempt");
    const prior = stored.value;
    expect((await f.owner.run({ ...f.request, operationId: randomUUID() }, f.signal)).code).toBe(
      "unresolved-health-attempt",
    );
    if (!f.request.health) throw new Error("missing health request");
    const request = { ...f.request, health: { ...f.request.health, recover: true } };
    const recover = await f.owner.run(request, f.signal);
    expect(recover.status).toBe("preview");
    expect(
      (await f.owner.run({ ...request, confirmation: recover.confirmation ?? "" }, f.signal)).code,
    ).toBe("health-recovered");
    expect(f.calls()).toBe(1);
    expect(f.healthStore.save(prior, 0).ok).toBe(false);
  } finally {
    await f.close();
  }
});

test("transitive package trust and enablement gate health, and changed providers invalidate confirmation", async () => {
  const f = await setup({ graph: true });
  try {
    const preview = await f.owner.run(f.request, f.signal);
    expect(preview).toMatchObject({ status: "preview", code: "health-confirmation-required" });
    f.setPackageAuthority("leaf", { enabled: false });
    const denied = await f.owner.run(
      { ...f.request, confirmation: preview.confirmation ?? "" },
      f.signal,
    );
    expect(denied.code).toBe("dependency-disabled");
    expect(denied.data).toMatchObject({ packageId: "leaf" });
    f.setPackageAuthority("leaf", { trusted: false });
    expect((await f.owner.run(f.request, f.signal)).code).toBe("package-trust-required");
    f.setPackageAuthority("leaf", { inputs: canonicalDigest("new-leaf-policy") });
    expect(
      (await f.owner.run({ ...f.request, confirmation: preview.confirmation ?? "" }, f.signal))
        .code,
    ).toBe("stale-health-confirmation");
    f.simulateMissing("leaf");
    const missing = await f.owner.run(f.request, f.signal);
    expect(missing.code).toBe("dependency-unavailable");
    expect(missing.data).toMatchObject({ packageId: "leaf" });
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});

test("an absent unlocked optional package permits the declared degraded closure", async () => {
  const f = await setup({ dependencies: [{ id: "absent", range: "^1.0.0", optional: true }] });
  try {
    expect((await f.owner.run(f.request, f.signal)).status).toBe("preview");
  } finally {
    await f.close();
  }
});

test("terminated attempts cannot reopen occupancy or change their immutable binding", async () => {
  const f = await setup();
  try {
    const preview = await f.owner.run(f.request, f.signal);
    await f.owner.run({ ...f.request, confirmation: preview.confirmation ?? "" }, f.signal);
    const result = f.healthStore.get(f.request.operationId);
    if (!result.ok || !result.value) throw new Error("missing health record");
    const prior = result.value;
    expect(
      f.healthStore.save(
        { ...prior, revision: prior.revision + 1, result: { ...prior.result, terminated: false } },
        prior.revision,
      ).ok,
    ).toBe(false);
    expect(
      f.healthStore.save(
        {
          ...prior,
          revision: prior.revision + 1,
          result: {
            ...prior.result,
            binding: { ...prior.result.binding, generation: canonicalDigest("other") },
          },
        },
        prior.revision,
      ).ok,
    ).toBe(false);
  } finally {
    await f.close();
  }
});

for (const limits of [
  { requests: 3 },
  { cpuMs: 1000 },
  { processes: 0 },
] satisfies ResourceAmounts[])
  test(`health respects parent admission ${JSON.stringify(limits)}`, async () => {
    const f = await setup({ limits });
    try {
      const preview = await f.owner.run(f.request, f.signal);
      const denied = await f.owner.run(
        { ...f.request, confirmation: preview.confirmation ?? "" },
        f.signal,
      );
      expect(denied.status).not.toBe("completed");
      expect(f.calls()).toBe(0);
    } finally {
      await f.close();
    }
  });

test("health admits a locked diamond and refuses a now-incompatible native contribution", async () => {
  const f = await setup({ graph: true, diamond: true });
  try {
    expect((await f.owner.run(f.request, f.signal)).status).toBe("preview");
    f.host.arch = "x64";
    expect((await f.owner.run(f.request, f.signal)).code).toBe("contribution-incompatible");
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});

test("installing a previously absent optional package does not expand the saved health closure", async () => {
  const f = await setup({ dependencies: [{ id: "optional", range: "^1.0.0", optional: true }] });
  try {
    const before = await f.owner.run(f.request, f.signal);
    const source = packageSource(pluginManifest({ version: 1 }, { name: "optional" }));
    const request = packageRequestSchema.parse({
      packageId: "optional",
      operationId: randomUUID(),
      expectedRevision: 0,
    });
    const preview = await f.lifecycle.run("install", request, f.signal, source);
    expect(
      (
        await f.lifecycle.run(
          "install",
          { ...request, confirmation: preview.confirmation ?? "" },
          f.signal,
          source,
        )
      ).status,
    ).toBe("completed");
    expect((await f.owner.run(f.request, f.signal)).confirmation).toBe(before.confirmation);
    expect(f.calls()).toBe(0);
  } finally {
    await f.close();
  }
});

test("confirmed recovery can retry retained files after observed termination", async () => {
  const f = await setup();
  try {
    const preview = await f.owner.run(f.request, f.signal);
    await f.owner.run({ ...f.request, confirmation: preview.confirmation ?? "" }, f.signal);
    const stored = f.healthStore.get(f.request.operationId);
    if (!stored.ok || !stored.value || !f.request.health) throw new Error("missing attempt");
    const prior = stored.value;
    expect(
      f.healthStore.save(
        {
          ...prior,
          revision: prior.revision + 1,
          result: {
            ...prior.result,
            state: "failed",
            cleanup: "retained",
            code: "health-files-retained",
          },
        },
        prior.revision,
      ).ok,
    ).toBe(true);
    const request = { ...f.request, health: { ...f.request.health, recover: true } };
    const recovery = await f.owner.run(request, f.signal);
    expect(recovery.status).toBe("preview");
    expect(
      (await f.owner.run({ ...request, confirmation: recovery.confirmation ?? "" }, f.signal)).code,
    ).toBe("health-recovered");
    expect(f.calls()).toBe(1);
  } finally {
    await f.close();
  }
});
