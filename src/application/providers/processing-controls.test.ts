import { expect, test } from "bun:test";
import { turnId } from "../../domain/foundation/index.ts";
import type { StoredModelPreferences as ModelPreferences } from "../../providers/configuration/policy-schema.ts";
import { createProductLiveTurnExecutor } from "../runtime/product-live-turn.ts";
import { processingProduct, reportedProcessing } from "../runtime/product-processing.fixture.ts";
import { createModelSettingsService, withProcessingSession } from "./model-settings.ts";
import { modelSettingsLines } from "./model-settings-format.ts";
import { inspectProcessingRoute } from "./processing-controls.ts";

test("inspection refuses unknown pricing under a hard cap without probing the provider", () => {
  const product = processingProduct();
  const catalog = {
    generation: 1,
    provenance: "static-config" as const,
    fetchedAt: null,
    expiresAt: null,
    models: (product.adapter.modelCapabilities ?? []).map(
      ({ pricing: _pricing, ...model }) => model,
    ),
  };
  const route = { ...product.preferences.roles.default, processing: { mode: "fast" as const } };
  expect(
    inspectProcessingRoute(product.adapter, catalog, route).modes.find(
      (mode) => mode.preference.mode === "fast",
    )?.eligible,
  ).toBe(true);
  expect(
    inspectProcessingRoute(product.adapter, catalog, {
      ...route,
      budgets: { cost: 1000 },
    }).modes.find((mode) => mode.preference.mode === "fast"),
  ).toMatchObject({
    eligible: false,
    reason: "processing-price-unknown-for-cost-cap",
  });
  expect(product.requests).toHaveLength(0);
});

function controls(product = processingProduct()) {
  const service = createModelSettingsService({
    read: async () => ({
      preferences: product.preferences,
      main: product.preferences.roles.default,
      generation: 5,
      fileRevision: null,
      scope: "user",
      definitions: [],
    }),
    write: async () => {
      throw new Error("Session changes must not write configuration");
    },
    backup: async () => ({ ok: false, code: "not-used" }),
    validateRoute: async () => ({ ok: true }),
  });
  return {
    product,
    standalone: service,
    service: withProcessingSession(service, product.executor.processing),
  };
}

test("shared control pins the active request, displays actual downgrade and changes only next admission", async () => {
  const { service, product, standalone } = controls();
  const scope = { kind: "session" };
  const inspect = await service.execute({ kind: "processing-inspect", scope });
  expect(inspect.kind).toBe("processing-inspection");
  expect(product.requests).toHaveLength(0);
  expect(
    await standalone.execute({ kind: "processing-set", scope, preference: { mode: "fast" } }),
  ).toMatchObject({ kind: "failed", code: "processing-session-host-required" });
  expect(
    await service.execute({
      kind: "processing-set",
      scope: { kind: "session", sessionId: "another" },
      preference: { mode: "fast" },
    }),
  ).toMatchObject({ kind: "failed", code: "processing-session-not-authorized" });
  expect(
    await service.execute({ kind: "processing-set", scope, preference: { mode: "fast" } }),
  ).toMatchObject({ kind: "processing-changed", application: "pending" });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  product.state.beforeResponse = async () => {
    started.resolve();
    await release.promise;
  };
  product.state.observations = [reportedProcessing("standard")];
  const first = product.executor.run({ prompt: "Reply", turnId: turnId.from("control-first") });
  await started.promise;
  const changed = await service.execute({
    kind: "processing-set",
    scope,
    preference: { mode: "standard" },
  });
  expect(changed).toMatchObject({
    kind: "processing-changed",
    inspection: {
      active: { mode: "fast" },
      selection: { preference: { mode: "standard" } },
      lastServed: null,
    },
  });
  expect(product.requests[0]?.processing?.preference.mode).toBe("fast");
  release.resolve();
  expect((await first).kind).toBe("completed");
  const after = await service.execute({ kind: "processing-inspect", scope });
  expect(after).toMatchObject({
    lastServed: { actualMode: "standard", binding: { preference: { mode: "fast" } } },
    active: null,
  });
  expect(modelSettingsLines(after).join("\n")).toContain("Last served: standard");
  product.state.beforeResponse = null;
  expect(
    (await product.executor.run({ prompt: "Reply", turnId: turnId.from("control-second") })).kind,
  ).toBe("completed");
  expect(product.requests[1]?.processing?.preference.mode).toBe("standard");
  expect(product.requests[1]?.modelId).toBe(product.requests[0]?.modelId);
  expect(product.requests[1]?.reasoning).toBe(product.requests[0]?.reasoning);
  expect((await service.execute({ kind: "processing-reset", scope })).kind).toBe(
    "processing-changed",
  );
  expect(product.executor.processing.inspect().selection?.preference.mode).toBe("provider-default");
  expect(controls().product.executor.processing.inspect().override).toBeNull();
  expect(product.requests).toHaveLength(2);
});

test("unavailable, cancelled and revoked changes preserve the old active preference", async () => {
  const { product, service } = controls();
  const request = {
    kind: "processing-set",
    scope: { kind: "session" },
    preference: { mode: "fast", fallback: "allow-standard" },
  };
  product.state.qualification.modes.fast.support = "unknown";
  expect((await service.execute(request)).kind).toBe("failed");
  expect(product.executor.processing.inspect().override).toBeNull();
  product.state.qualification.modes.fast.support = "supported";
  expect(await service.execute(request, AbortSignal.abort())).toMatchObject({
    kind: "failed",
    code: "cancelled",
  });
  expect(product.executor.processing.inspect().override).toBeNull();
  expect(product.requests).toHaveLength(0);
  const revoked = withProcessingSession(service, product.executor.processing, () => false);
  expect(await revoked.execute(request)).toMatchObject({
    kind: "failed",
    code: "processing-session-no-longer-active",
  });
  expect(product.executor.processing.inspect().override).toBeNull();
});

test("resumed executor restores actual served receipt without restoring the transient override", async () => {
  const { product, service } = controls();
  await service.execute({
    kind: "processing-set",
    scope: { kind: "session" },
    preference: { mode: "fast" },
  });
  product.state.observations = [reportedProcessing("standard")];
  expect(
    (await product.executor.run({ prompt: "Reply", turnId: turnId.from("before-resume") })).kind,
  ).toBe("completed");
  const resumed = createProductLiveTurnExecutor({
    runtime: product.runtime,
    clock: product.clock,
    modelPreferences: () => product.preferences,
    providerCatalog: {
      generation: 1,
      provenance: "static-config",
      fetchedAt: null,
      expiresAt: null,
      models: product.adapter.modelCapabilities ?? [],
    },
  });
  expect(resumed.processing.inspect()).toMatchObject({
    override: null,
    active: null,
    selection: { preference: { mode: "provider-default" } },
    lastServed: { actualMode: "standard", binding: { preference: { mode: "fast" } } },
  });
  expect(product.requests).toHaveLength(1);
});

test("saved role controls preserve route fields, reject stale and cancelled writes and reset only processing", async () => {
  const product = processingProduct();
  let preferences: ModelPreferences = product.preferences;
  let revision: string | null = null;
  let writes = 0;
  const service = createModelSettingsService({
    read: async () => ({
      preferences,
      main: product.preferences.roles.default,
      generation: 5,
      fileRevision: revision,
      scope: "user",
      definitions: [],
    }),
    inspectProcessing: async (route) =>
      inspectProcessingRoute(
        product.adapter,
        {
          generation: 1,
          provenance: "static-config",
          fetchedAt: null,
          expiresAt: null,
          models: product.adapter.modelCapabilities ?? [],
        },
        route,
      ),
    validateRoute: async () => ({ ok: true }),
    backup: async () => ({ ok: false, code: "not-used" }),
    write: async (next) => {
      preferences = next;
      revision = `revision-${++writes}`;
      return { kind: "written", revision };
    },
  });
  const scope = { kind: "user", target: { kind: "role", role: "default" } };
  const request = {
    kind: "processing-set",
    scope,
    preference: { mode: "fast" },
    expectedRevision: null,
  };
  expect((await service.execute(request)).kind).toBe("written");
  expect(preferences.roles.default).toEqual({
    ...product.preferences.roles.default,
    processing: { mode: "fast" },
  });
  expect(await service.execute(request)).toMatchObject({ kind: "failed", code: "stale-settings" });
  expect(
    await service.execute(
      { kind: "processing-reset", scope, expectedRevision: revision },
      AbortSignal.abort(),
    ),
  ).toMatchObject({ kind: "failed", code: "cancelled" });
  expect(writes).toBe(1);
  expect(
    (await service.execute({ kind: "processing-reset", scope, expectedRevision: revision })).kind,
  ).toBe("written");
  expect(preferences.roles.default).toEqual(product.preferences.roles.default);
  expect(product.requests).toHaveLength(0);
});
