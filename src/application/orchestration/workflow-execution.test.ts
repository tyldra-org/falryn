import { afterEach, expect, test } from "bun:test";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { ok } from "../../domain/foundation/result.ts";
import { simpleWorkflow } from "../../domain/orchestration/workflow.fixtures.ts";
import { taskValue } from "./process-task.fixtures.ts";
import { workflowFixture } from "./workflow-execution.fixtures.ts";

afterEach(removeTemporaryRoots);
const handle = { id: "workflow-1", generation: "one" };
const signal = () => new AbortController().signal;
test("admission is inert; execution seals exact artifacts and cannot be duplicated", async () => {
  const f = await workflowFixture();
  try {
    const admitted = taskValue(
      await f.execution.admit(
        { handle, definition: simpleWorkflow(), arguments: {} },
        f.host,
        signal(),
      ),
    );
    expect(admitted.state).toBe("admitted");
    expect(f.calls).toEqual([]);
    const result = taskValue(await f.execution.drive(handle, f.host, signal()));
    expect(result.state).toBe("completed");
    expect(result.executor).toBeNull();
    expect(f.calls).toEqual(["read"]);
    expect(taskValue(f.store.get(handle))).toEqual(result);
    expect(await f.execution.drive(handle, f.host, signal())).toEqual({ ok: true, value: result });
    expect(f.calls).toHaveLength(1);
    if (!result.output) throw new Error("missing output");
    expect(await f.artifacts.read(result.output, signal())).toEqual({ result: {} });
  } finally {
    await f.close();
  }
});
test("invalid dependencies, denied scopes and failed exact result schemas cause no dependent effect", async () => {
  const f = await workflowFixture(async () => ({
    state: "completed",
    effect: "none",
    value: { unexpected: true },
  }));
  try {
    expect(
      await f.execution.admit(
        { handle, definition: { ...simpleWorkflow(), nodes: [] }, arguments: {} },
        f.host,
        signal(),
      ),
    ).toMatchObject({ ok: false });
    taskValue(
      await f.execution.admit(
        { handle, definition: simpleWorkflow(), arguments: {} },
        f.host,
        signal(),
      ),
    );
    expect(f.execution.inspect(handle, { ...f.host, authority: "foreign" })).toMatchObject({
      ok: false,
    });
    const result = await f.execution.drive(handle, f.host, signal());
    expect(result.ok ? result.value.state : result.error.code).not.toBe("completed");
    expect(taskValue(f.store.get(handle)).nodes[0]).toMatchObject({
      state: "failed",
      reason: "workflow-result-schema",
    });
  } finally {
    await f.close();
  }
});
test("mapped pipelines advance each sealed item without waiting for the slow sibling", async () => {
  const slow = Promise.withResolvers<void>();
  const fastNext = Promise.withResolvers<void>();
  const f = await workflowFixture(async (node, input) => {
    if (node.key === "source")
      return { state: "completed", effect: "none", value: [{ id: "slow" }, { id: "fast" }] };
    if (node.key === "first" && input.id === "slow") await slow.promise;
    if (node.key === "second" && input.id === "fast") fastNext.resolve();
    return { state: "completed", effect: "none", value: String(input.id) };
  });
  try {
    const source = {
      key: "source",
      kind: "action",
      capability: "builtin:test/read@1",
      effect: "observation",
      resultSchema: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      },
    };
    const mapped = {
      kind: "action",
      capability: "builtin:test/read@1",
      effect: "observation",
      resultSchema: { type: "string" },
      input: { id: { from: "item", path: ["id"] } },
      forEach: { source: { from: "node", node: "source" }, key: ["id"], maxItems: 3 },
    };
    const definition = {
      ...simpleWorkflow(),
      nodes: [
        source,
        { ...mapped, key: "first", dependencies: ["source"] },
        { ...mapped, key: "second", dependencies: ["source", "first"] },
      ],
      outputs: { result: { from: "node", node: "second" } },
    };
    taskValue(await f.execution.admit({ handle, definition, arguments: {} }, f.host, signal()));
    const drive = f.execution.drive(handle, f.host, signal());
    const winner = await Promise.race([
      fastNext.promise.then(() => "advanced"),
      Bun.sleep(1000).then(() => "timeout"),
    ]);
    slow.resolve();
    expect(winner).toBe("advanced");
    const result = taskValue(await drive);
    expect(result.state).toBe("completed");
    expect(result.nodes).toHaveLength(5);
    expect(f.calls).toHaveLength(5);
  } finally {
    slow.resolve();
    await f.close();
  }
});
test("explicit new generation reuses only matching verified node evidence", async () => {
  const f = await workflowFixture();
  try {
    taskValue(
      await f.execution.admit(
        { handle, definition: simpleWorkflow(), arguments: {} },
        f.host,
        signal(),
      ),
    );
    taskValue(await f.execution.drive(handle, f.host, signal()));
    const next = { ...handle, generation: "two" };
    taskValue(
      await f.execution.admit(
        { handle: next, definition: simpleWorkflow(), arguments: {}, reuse: handle },
        f.host,
        signal(),
      ),
    );
    const reused = taskValue(await f.execution.drive(next, f.host, signal()));
    expect(reused.nodes[0]?.reason).toBe("workflow-result-reused");
    expect(f.calls).toHaveLength(1);
    const changed = { ...handle, generation: "three" };
    taskValue(
      await f.execution.admit(
        { handle: changed, definition: simpleWorkflow(), arguments: {}, reuse: next },
        { ...f.host, sourceGeneration: "source-2" },
        signal(),
      ),
    );
    taskValue(await f.execution.drive(changed, f.host, signal()));
    expect(f.calls).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test("different maps with overlapping item keys consume the complete declared prerequisite", async () => {
  const inputs: unknown[] = [];
  const f = await workflowFixture(async (node, input) => {
    if (node.key === "consume") inputs.push(input.values);
    return { state: "completed", effect: "none", value: String(input.id) };
  });
  try {
    const mapped = {
      kind: "action",
      capability: "builtin:test/read@1",
      effect: "observation",
      input: { id: { from: "item", path: ["id"] } },
      resultSchema: { type: "string" },
    };
    const definition = {
      ...simpleWorkflow(),
      nodes: [
        {
          ...mapped,
          key: "produce",
          forEach: {
            source: { from: "literal", value: [{ id: "same" }, { id: "other" }] },
            key: ["id"],
            maxItems: 2,
          },
        },
        {
          ...mapped,
          key: "consume",
          dependencies: ["produce"],
          input: { ...mapped.input, values: { from: "node", node: "produce" } },
          forEach: {
            source: { from: "literal", value: [{ id: "same" }] },
            key: ["id"],
            maxItems: 1,
          },
        },
      ],
      outputs: {},
    };
    taskValue(await f.execution.admit({ handle, definition, arguments: {} }, f.host, signal()));
    expect(taskValue(await f.execution.drive(handle, f.host, signal())).state).toBe("completed");
    expect(inputs).toEqual([["same", "other"]]);
  } finally {
    await f.close();
  }
});

test("reuse keeps observed effects across generations and definition reordering preserves independent evidence", async () => {
  const f = await workflowFixture(async () => ({
    state: "completed",
    effect: "completed",
    value: {},
  }));
  try {
    const base = simpleWorkflow();
    const definition = { ...base, nodes: [{ ...base.nodes[0], effect: "mutation" }] };
    taskValue(await f.execution.admit({ handle, definition, arguments: {} }, f.host, signal()));
    taskValue(await f.execution.drive(handle, f.host, signal()));
    const next = { ...handle, generation: "two" };
    const edited = {
      ...definition,
      nodes: [{ ...base.nodes[0], key: "inserted" }, ...definition.nodes],
    };
    taskValue(
      await f.execution.admit(
        { handle: next, definition: edited, arguments: {}, reuse: handle },
        f.host,
        signal(),
      ),
    );
    const reused = taskValue(await f.execution.drive(next, f.host, signal()));
    expect(reused.nodes.find((node) => node.key === "read")).toMatchObject({
      reason: "workflow-result-reused",
      effect: "completed",
      attempts: 0,
    });
    expect(f.calls).toEqual(["read", "inserted"]);
    const changed = { ...handle, generation: "three" };
    const altered = {
      ...edited,
      nodes: edited.nodes
        .toReversed()
        .map((node) =>
          node.key === "read"
            ? { ...node, input: { changed: { from: "literal", value: true } } }
            : node,
        ),
    };
    taskValue(
      await f.execution.admit(
        { handle: changed, definition: altered, arguments: {}, reuse: next },
        f.host,
        signal(),
      ),
    );
    const refused = taskValue(await f.execution.drive(changed, f.host, signal()));
    expect(refused.state).toBe("failed");
    expect(refused.nodes.find((node) => node.key === "read")?.reason).toBe(
      "workflow-effect-requires-new-admission",
    );
    expect(f.calls).toEqual(["read", "inserted"]);
  } finally {
    await f.close();
  }
});

test("required failures stop later admissions; explicit continuation preserves independent results", async () => {
  for (const onFailure of ["stop", "continue"] as const) {
    const f = await workflowFixture(async (node) =>
      node.key === "read"
        ? { state: "failed", effect: "none", reason: "read-failed" }
        : { state: "completed", effect: "none", value: {} },
    );
    try {
      const base = simpleWorkflow();
      const definition = {
        ...base,
        concurrency: 1,
        nodes: [
          { ...base.nodes[0], onFailure },
          { ...base.nodes[0], key: "independent" },
          { ...base.nodes[0], key: "dependent", dependencies: ["read"] },
        ],
      };
      taskValue(await f.execution.admit({ handle, definition, arguments: {} }, f.host, signal()));
      const result = taskValue(await f.execution.drive(handle, f.host, signal()));
      expect(result.state).toBe("failed");
      expect(f.calls).toEqual(onFailure === "stop" ? ["read"] : ["read", "independent"]);
      expect(result.nodes.find((node) => node.key === "dependent")?.state).toBe("skipped");
    } finally {
      await f.close();
    }
  }
});

test("pause lets an observed effect settle and resumes only untouched nodes", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const f = await workflowFixture(async (node) => {
    if (node.key === "read") {
      entered.resolve();
      await release.promise;
    }
    return { state: "completed", effect: "none", value: {} };
  });
  try {
    const base = simpleWorkflow();
    taskValue(
      await f.execution.admit(
        {
          handle,
          arguments: {},
          definition: {
            ...base,
            nodes: [...base.nodes, { ...base.nodes[0], key: "next", dependencies: ["read"] }],
          },
        },
        f.host,
        signal(),
      ),
    );
    const run = f.execution.drive(handle, f.host, signal());
    await entered.promise;
    const current = taskValue(f.store.get(handle));
    taskValue(f.execution.control(handle, current.revision, "pause", f.host));
    release.resolve();
    const paused = taskValue(await run);
    expect(paused.state).toBe("paused");
    expect(paused.nodes[0]?.state).toBe("completed");
    expect(f.calls).toEqual(["read"]);
    expect(taskValue(await f.execution.drive(handle, f.host, signal())).state).toBe("completed");
    expect(f.calls).toEqual(["read", "next"]);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("recovery requires a fenced owner and never repeats an interrupted invocation", async () => {
  const f = await workflowFixture(async () => {
    const running = taskValue(f.store.get(handle));
    taskValue(
      f.store.change(handle, running.revision, (record) =>
        ok({ ...record, revision: record.revision + 1, executor: "lost-host" }),
      ),
    );
    return { state: "completed", effect: "none", value: {} };
  });
  try {
    taskValue(
      await f.execution.admit(
        { handle, definition: simpleWorkflow(), arguments: {} },
        f.host,
        signal(),
      ),
    );
    expect(await f.execution.drive(handle, f.host, signal())).toMatchObject({ ok: false });
    expect(
      await f.execution.drive(handle, { ...f.host, fenced: async () => false }, signal()),
    ).toMatchObject({ ok: false, error: { code: "workflow-owner-unsettled" } });
    const recovered = taskValue(await f.execution.drive(handle, f.host, signal()));
    expect(recovered.state).toBe("uncertain");
    expect(recovered.nodes[0]?.effect).toBe("uncertain");
    expect(f.calls).toEqual(["read"]);
    expect(
      f.store.change(handle, recovered.revision, (record) =>
        ok({ ...record, state: "running", revision: record.revision + 1 }),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid-transition" } });
  } finally {
    await f.close();
  }
});

test("safe retries stay inside the original ceiling and malformed results preserve observed mutations", async () => {
  const f = await workflowFixture(async () => ({
    state: "failed",
    effect: "none",
    reason: "temporary",
  }));
  try {
    const base = simpleWorkflow();
    taskValue(
      await f.execution.admit(
        {
          handle,
          definition: {
            ...base,
            limits: { operations: 10 },
            nodes: [{ ...base.nodes[0], retries: 2 }],
          },
          arguments: {},
        },
        f.host,
        signal(),
      ),
    );
    const result = taskValue(await f.execution.drive(handle, f.host, signal()));
    expect(result.nodes[0]?.attempts).toBe(3);
    expect(result.state).toBe("failed");
    expect(f.calls).toHaveLength(3);
    expect(result.spent.operations).toBe(4);
  } finally {
    await f.close();
  }
  const effect = await workflowFixture(async () => ({
    state: "completed",
    effect: "completed",
    value: {},
  }));
  try {
    const base = simpleWorkflow();
    taskValue(
      await effect.execution.admit(
        {
          handle,
          definition: {
            ...base,
            nodes: [{ ...base.nodes[0], effect: "mutation", resultPath: ["missing"] }],
          },
          arguments: {},
        },
        effect.host,
        signal(),
      ),
    );
    const result = taskValue(await effect.execution.drive(handle, effect.host, signal()));
    expect(result.nodes[0]).toMatchObject({
      state: "failed",
      effect: "completed",
      attempts: 1,
      reason: "workflow-result-schema",
    });
    const next = { ...handle, generation: "two" };
    taskValue(
      await effect.execution.admit(
        { handle: next, definition: base, arguments: {}, reuse: handle },
        effect.host,
        signal(),
      ),
    );
    expect(taskValue(await effect.execution.drive(next, effect.host, signal())).state).toBe(
      "failed",
    );
    expect(effect.calls).toHaveLength(1);
  } finally {
    await effect.close();
  }
});

test("missing retained bytes never repeat a completed effect when a new generation requests reuse", async () => {
  const f = await workflowFixture(async () => ({
    state: "completed",
    effect: "completed",
    value: {},
  }));
  try {
    taskValue(
      await f.execution.admit(
        { handle, definition: simpleWorkflow(), arguments: {} },
        f.host,
        signal(),
      ),
    );
    const first = taskValue(await f.execution.drive(handle, f.host, signal()));
    const result = first.nodes[0]?.result;
    if (!result) throw new Error("missing result");
    const { contentDigest } = await import("../../domain/artifacts/index.ts");
    taskValue(
      await f.blobs.remove({ scope: "content", digest: contentDigest.from(result.digest) }),
    );
    const next = { ...handle, generation: "two" };
    taskValue(
      await f.execution.admit(
        { handle: next, definition: simpleWorkflow(), arguments: {}, reuse: handle },
        f.host,
        signal(),
      ),
    );
    expect(taskValue(await f.execution.drive(next, f.host, signal())).state).toBe("failed");
    expect(f.calls).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("empty maps complete without effects; duplicate item identities fail before mapped admission", async () => {
  for (const items of [[], [{ id: "same" }, { id: "same" }]]) {
    const f = await workflowFixture(async () => ({
      state: "completed",
      effect: "none",
      value: items,
    }));
    try {
      const source = {
        ...simpleWorkflow().nodes[0],
        resultSchema: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
      };
      const definition = {
        ...simpleWorkflow(),
        nodes: [
          source,
          {
            ...simpleWorkflow().nodes[0],
            key: "mapped",
            dependencies: ["read"],
            forEach: { source: { from: "node", node: "read" }, key: ["id"], maxItems: 2 },
          },
        ],
        outputs: { result: { from: "node", node: "mapped" } },
      };
      taskValue(await f.execution.admit({ handle, definition, arguments: {} }, f.host, signal()));
      const result = await f.execution.drive(handle, f.host, signal());
      if (items.length === 0) expect(taskValue(result).state).toBe("completed");
      else expect(result).toMatchObject({ ok: false, error: { code: "workflow-map-identity" } });
      expect(f.calls).toEqual(["read"]);
    } finally {
      await f.close();
    }
  }
});

test("a settled join can publish declared output after a conditional branch is skipped", async () => {
  const f = await workflowFixture();
  try {
    const base = simpleWorkflow();
    const definition = {
      ...base,
      nodes: [
        { ...base.nodes[0], when: { value: { from: "literal", value: false }, equals: true } },
        {
          key: "join",
          kind: "join",
          policy: "settled",
          dependencies: ["read"],
          resultPath: ["nodes", 0, "state"],
          resultSchema: { type: "string", enum: ["skipped"] },
        },
      ],
      outputs: { branch: { from: "node", node: "join" } },
    };
    taskValue(await f.execution.admit({ handle, definition, arguments: {} }, f.host, signal()));
    const result = taskValue(await f.execution.drive(handle, f.host, signal()));
    expect(result.state).toBe("completed");
    expect(f.calls).toEqual([]);
    if (!result.output) throw new Error("Missing declared join output");
    expect(await f.artifacts.read(result.output, signal())).toEqual({ branch: "skipped" });
  } finally {
    await f.close();
  }
});
