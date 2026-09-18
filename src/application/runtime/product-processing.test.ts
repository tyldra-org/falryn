import { expect, test } from "bun:test";
import { turnId } from "../../domain/foundation/index.ts";
import { processingReceiptSchema } from "../../domain/sessions/model-processing.ts";
import { parseWireEvent, toWireEvent } from "../../domain/sessions/wire.ts";
import { processingProduct, reportedProcessing } from "./product-processing.fixture.ts";

test("product entry preserves model, thinking and tools while admitting distinct processing prices", async () => {
  const product = processingProduct();
  const receipts = [];
  for (const mode of ["standard", "fast", "provider-default"] as const) {
    product.state.observations = [reportedProcessing(mode === "standard" ? "standard" : "fast")];
    const result = await product.executor.run({
      prompt: "Reply briefly.",
      turnId: turnId.from(mode),
      processing: { mode },
    });
    expect(result.kind).toBe("completed");
    const replay = await product.runtime.journal.replayTurn(turnId.from(mode));
    if (replay.kind !== "rebuilt") throw new Error(replay.kind);
    const receipt = replay.turns[0]?.attempts[0]?.processing?.[0];
    expect(processingReceiptSchema.safeParse(receipt).success).toBe(true);
    receipts.push(receipt);
  }
  expect(receipts.map((receipt) => receipt?.binding.maximumCostMicros)).toEqual([
    30010, 300100, 300100,
  ]);
  expect(receipts.map((receipt) => receipt?.actualMode)).toEqual(["standard", "fast", "fast"]);
  expect(receipts[2]?.binding.nativeParameters).toBeNull();
  const invariant = (index: number) => {
    const request = product.requests[index];
    return [
      request?.modelId,
      request?.reasoning,
      request?.reasoningControl,
      request?.tools,
      request?.output,
    ];
  };
  expect(invariant(1)).toEqual(invariant(0));
  expect(invariant(2)).toEqual(invariant(0));
  expect(product.requests[0]?.tools.length).toBeGreaterThan(0);
  expect(Object.isFrozen(product.requests[0]?.processing?.price)).toBe(true);
  const count = product.requests.length;
  await product.runtime.journal.replay();
  expect(product.requests.length).toBe(count);
  const replay = await product.runtime.journal.replay();
  if (replay.kind !== "rebuilt") throw new Error(replay.kind);
  for (const event of replay.events.filter((event) => event.kind === "model.processing.recorded")) {
    const encoded = JSON.parse(JSON.stringify(toWireEvent(event)));
    const decoded = parseWireEvent(encoded);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error("Invalid processing event");
    expect(decoded.event).toEqual(event);
  }
});

test.each(["unsupported", "unknown"] as const)(
  "%s processing refuses Fast and keeps ordinary inference usable",
  async (support) => {
    const product = processingProduct();
    product.state.qualification.modes.fast.support = support;
    const fast = await product.executor.run({
      prompt: "Reply.",
      turnId: turnId.from("fast-refused"),
      processing: { mode: "fast", fallback: "allow-standard" },
    });
    expect(fast.kind).not.toBe("completed");
    expect(product.requests).toHaveLength(0);
    const ordinary = await product.executor.run({
      prompt: "Reply.",
      turnId: turnId.from("ordinary"),
    });
    expect(ordinary.kind).toBe("completed");
    expect(product.requests).toHaveLength(1);
    expect(product.requests[0]?.processing?.nativeParameters).toBeNull();
  },
);

test.each(["standard", "missing", "conflicting"] as const)(
  "actual processing %s is durable and does not cause a second request",
  async (observation) => {
    const product = processingProduct();
    product.state.observations =
      observation === "missing"
        ? []
        : observation === "standard"
          ? [reportedProcessing("standard")]
          : [reportedProcessing("fast", "provider-start"), reportedProcessing("standard")];
    const result = await product.executor.run({
      prompt: "Reply.",
      turnId: turnId.from("actual"),
      processing: { mode: "fast" },
    });
    expect(result.kind).toBe("completed");
    expect(product.requests).toHaveLength(1);
    const replay = await product.runtime.journal.replay();
    if (replay.kind !== "rebuilt") throw new Error(replay.kind);
    const receipt = replay.turns[0]?.attempts[0]?.processing?.[0];
    expect(receipt?.actualMode).toBe(observation === "standard" ? "standard" : "unknown");
    expect(receipt?.status).toBe(
      observation === "missing"
        ? "unrecorded"
        : observation === "conflicting"
          ? "conflicting"
          : "reported",
    );
  },
);

test("premium cache maximum rejects a standard-sized hard cap; unknown coverage refuses provider-default", async () => {
  const product = processingProduct();
  Object.assign(product.preferences.roles.default.budgets, { cost: 50000 });
  const standard = await product.executor.run({
    prompt: "Reply.",
    turnId: turnId.from("capped-standard"),
    processing: { mode: "standard" },
  });
  expect(standard.kind).toBe("completed");
  const fast = await product.executor.run({
    prompt: "Reply.",
    turnId: turnId.from("capped-fast"),
    processing: { mode: "fast" },
  });
  expect(fast.kind).not.toBe("completed");
  product.state.qualification.modes["provider-default"].priceTierIds = null;
  const unknown = await product.executor.run({
    prompt: "Reply.",
    turnId: turnId.from("capped-unknown"),
  });
  expect(unknown.kind).not.toBe("completed");
  expect(product.requests).toHaveLength(1);
});

test("a processing selection is captured while active and the next call resolves independently", async () => {
  const product = processingProduct();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  product.state.beforeResponse = async () => {
    started.resolve();
    await release.promise;
  };
  const first = product.executor.run({
    prompt: "Reply.",
    turnId: turnId.from("captured"),
    processing: { mode: "fast" },
  });
  await started.promise;
  product.state.qualification.modes.fast.priceTierIds = null;
  expect(product.requests[0]?.processing?.maximumCostMicros).toBe(300100);
  release.resolve();
  expect((await first).kind).toBe("completed");
  product.state.beforeResponse = null;
  expect(
    (await product.executor.run({ prompt: "Reply.", turnId: turnId.from("next-default") })).kind,
  ).toBe("completed");
  expect(product.requests[1]?.processing?.preference.mode).toBe("provider-default");
});

test.each(["revoked", "replaced", "cancelled", "budget"] as const)(
  "queued processing is rechecked when %s",
  async (change) => {
    const product = processingProduct();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    product.state.beforeResponse = async () => {
      started.resolve();
      await release.promise;
    };
    const first = product.attempt("holds-capacity", "fast");
    await started.promise;
    const task = product.resources.openTask("5");
    const controller = new AbortController();
    const second = product.attempt("queued-processing", "fast", task, controller.signal);
    for (let i = 0; i < 100 && product.resources.report().scheduler.queued === 0; i++)
      await Bun.sleep(1);
    expect(product.resources.report().scheduler.queued).toBeGreaterThan(0);
    if (change === "revoked")
      product.state.authority = { ...product.state.authority, authorized: false };
    if (change === "replaced")
      product.state.authority = { ...product.state.authority, accountGeneration: "account-2" };
    if (change === "cancelled") controller.abort();
    if (change === "budget") task.tighten({ costMicros: 1 });
    release.resolve();
    await first;
    const stopped = await second;
    expect(stopped.fact.kind).not.toBe("completed");
    expect(product.requests).toHaveLength(1);
    task.close();
  },
);

test("downgrade settlement uses captured ordinary rates; uncertain usage retains premium reservation across attempts", async () => {
  const product = processingProduct();
  const task = product.resources.openTask("5", { costMicros: 4000, requests: 3 });
  product.state.observations = [reportedProcessing("standard")];
  const downgraded = await product.attempt("downgraded", "fast", task);
  expect(downgraded.fact.kind).toBe("completed");
  expect(downgraded.output?.processing?.[0]?.usageCostMaximumMicros).toBe(32);
  expect(task.remaining("costMicros")).toBe(3968);
  product.state.reportUsage = false;
  const missing = await product.attempt("missing-usage", "fast", task);
  expect(missing.fact.kind).toBe("completed");
  expect(missing.output?.processing?.[0]?.usageCostMaximumMicros).toBeNull();
  expect(task.remaining("costMicros")).toBe(868);
  const exhausted = await product.attempt("same-budget", "fast", task);
  expect(exhausted.fact.kind).not.toBe("completed");
  expect(product.requests).toHaveLength(2);
  task.close();
});

test("supported provider with no installed mapping stays integration-unavailable", async () => {
  const product = processingProduct();
  const adapter = { ...product.adapter, processingModes: [] };
  const model = adapter.supportedModels[0];
  if (!model) throw new Error("Missing fixture model");
  expect(
    adapter.transportCompatibilityFor(model)?.declaration.processingQualifications?.[0]?.modes.fast
      .support,
  ).toBe("supported");
  // A caller cannot turn catalog support into an adapter implementation.
  Object.defineProperty(product.adapter, "processingModes", { value: [] });
  const result = await product.attempt("missing-mapping", "fast");
  expect(result.fact).toMatchObject({
    kind: "failed",
    message: "processing-integration-unavailable",
  });
  expect(product.requests).toHaveLength(0);
});

test("failed processing settles history inside its sole occupied slot and retains premium accounting", async () => {
  const product = processingProduct();
  const task = product.resources.openTask("5", { costMicros: 4000 });
  product.state.fail = true;
  product.state.observations = [reportedProcessing("standard")];
  const result = await product.attempt("failed-processing", "fast", task);
  expect(result.fact.kind).toBe("failed");
  expect(result.output?.processing?.[0]?.usageCostMaximumMicros).toBeNull();
  expect(task.remaining("costMicros")).toBe(900);
  expect(product.requests).toHaveLength(1);
  const replay = await product.runtime.journal.replay();
  if (replay.kind !== "rebuilt") throw new Error(replay.kind);
  expect(replay.events.some((event) => event.kind === "model.processing.recorded")).toBe(true);
  task.close();
}, 1000);

test("a revoked native parent blocks provider dispatch even without an instruction binding", async () => {
  const product = processingProduct();
  let checks = 0;
  const result = await product.executor.run({
    prompt: "Reply briefly.",
    turnId: turnId.from("parent-authority-revoked"),
    authorityCurrent: async () => {
      checks++;
      return false;
    },
  });
  expect(checks).toBeGreaterThan(0);
  expect(product.requests).toHaveLength(0);
  expect(result.kind).not.toBe("completed");
});
