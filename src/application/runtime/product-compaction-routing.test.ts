/** An admitted summarization fixture uses the ordinary product attempt path.
 * This does not attach automatic summarization to conversation history. */
import { expect, test } from "bun:test";
import { modelId, turnId } from "../../domain/foundation/index.ts";
import { processingProduct, reportedProcessing } from "./product-processing.fixture.ts";

function productWithDistinctFast() {
  const product = processingProduct();
  Object.assign(product.preferences.roles.default, {
    processing: { mode: "fast" },
    budgets: { attempts: 2, cost: 5000 },
  });
  Object.assign(product.preferences.roles, {
    fast: {
      default: {
        ...product.preferences.roles.default,
        modelId: modelId.from("cheap-helper"),
        processing: { mode: "standard" },
        budgets: {},
      },
      use: { memory: "evaluated" },
    },
  });
  product.state.observations = [reportedProcessing("fast")];
  return product;
}

test.each(["coding", "read", "toolRouting", "edit", "compression"] as const)(
  "admitted %s stays on main with captured processing and visible usage",
  async (intent) => {
    const product = productWithDistinctFast();
    const id = turnId.from(`main-${intent}`);
    const result = await product.executor.run({
      prompt: "Summarize: preserve the original requirement.",
      intent,
      turnId: id,
    });
    expect(result.kind).toBe("completed");
    expect(product.requests).toHaveLength(1);
    expect(product.requests[0]?.modelId).toBe(product.preferences.roles.default.modelId);
    expect(product.requests[0]?.processing?.preference.mode).toBe("fast");
    const replay = await product.runtime.journal.replayTurn(id);
    if (replay.kind !== "rebuilt") throw new Error(replay.kind);
    const attempt = replay.turns[0]?.attempts[0];
    expect(attempt?.binding?.modelId).toBe(product.preferences.roles.default.modelId);
    expect(attempt?.processing?.[0]?.actualMode).toBe("fast");
    expect(attempt?.processing?.[0]?.binding.maximumCostMicros).toBe(3100);
    expect(attempt?.processing?.[0]?.usageCostMaximumMicros).toBe(320);
    await product.runtime.journal.replay();
    expect(product.requests).toHaveLength(1);
  },
);

test("compression keeps live cancellation and cost limits without a helper attempt", async () => {
  const product = productWithDistinctFast();
  Object.assign(product.preferences.roles.default.budgets, { cost: 500 });
  const capped = await product.executor.run({
    prompt: "Summarize.",
    intent: "compression",
    turnId: turnId.from("capped-compression"),
  });
  expect(capped.kind).not.toBe("completed");
  expect(product.requests).toHaveLength(0);
  Object.assign(product.preferences.roles.default.budgets, { cost: 5000 });
  const controller = new AbortController();
  product.state.beforeResponse = async () => controller.abort();
  const cancelled = await product.executor.run({
    prompt: "Summarize.",
    intent: "compression",
    turnId: turnId.from("cancelled-compression"),
    signal: controller.signal,
  });
  expect(cancelled.kind).not.toBe("completed");
  expect(product.requests).toHaveLength(1);
  expect(product.requests[0]?.modelId).toBe(product.preferences.roles.default.modelId);
});

test("an active compression retains its captured route and replay never resubmits", async () => {
  const product = productWithDistinctFast();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  product.state.beforeResponse = async () => {
    started.resolve();
    await release.promise;
  };
  const original = product.preferences.roles.default.modelId;
  const pending = product.executor.run({
    prompt: "Summarize.",
    intent: "compression",
    turnId: turnId.from("captured-compression"),
  });
  await started.promise;
  product.preferences.roles.default.modelId = modelId.from("unavailable-new-main");
  release.resolve();
  expect((await pending).kind).toBe("completed");
  const replay = await product.runtime.journal.replay();
  expect(replay.kind === "rebuilt" && replay.turns[0]?.attempts[0]?.binding?.modelId).toBe(
    original,
  );
  product.state.beforeResponse = null;
  expect(
    (
      await product.executor.run({
        prompt: "Summarize.",
        intent: "compression",
        turnId: turnId.from("new-compression"),
      })
    ).kind,
  ).not.toBe("completed");
  expect(product.requests).toHaveLength(1);
});
