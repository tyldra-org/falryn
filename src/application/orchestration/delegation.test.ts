import { afterEach, expect, test } from "bun:test";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { capabilityInvocationStarted } from "../../domain/fixtures.ts";
import { invocationId } from "../../domain/foundation/index.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/index.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  roleRouteBaseSchema,
} from "../../providers/configuration/policy-schema.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import { createAgentRegistry, starterAgentRegistrations } from "./agent-registry.ts";
import {
  type AgentExecution,
  type AgentRun,
  createDelegation,
  type DelegationOptions,
} from "./delegation.ts";
import { type AgentLaunch, sealedAgentResultSchema } from "./delegation-contract.ts";
import { createProcessTaskFixture, taskValue } from "./process-task.fixtures.ts";
import { createProcessTaskSupervisor } from "./process-task-supervisor.ts";
import { createProductResources } from "./product-resources.ts";

afterEach(removeTemporaryRoots);
const launch: AgentLaunch = {
  operation: "launch",
  definitionId: "builtin/falryn/agents:explorer",
  inputJson: '{"objective":"Inspect source"}',
  context: [],
  capabilities: [],
  effects: ["observation"],
  limits: {},
  execution: {
    version: 1,
    attachment: "foreground",
    foregroundWaitMs: 30000,
    onSettle: "notify",
    shutdown: "drain",
  },
};
const facts: AgentExecution = {
  response: '{"locations":[],"flow":[],"findings":[],"unknowns":[]}',
  outcome: "completed",
  effect: "none",
  reason: "completed",
  observationRefs: ["observed-native-event"],
  providerRequests: 1,
  usage: null,
};
function output(value: ToolInvocationOutcome) {
  if (value.status !== "completed") throw new Error(JSON.stringify(value));
  return value.output;
}
async function fixture(
  execute: (run: AgentRun) => Promise<AgentExecution> = async () => facts,
  capability: DelegationOptions["capability"] = () => ({
    ready: false,
    reason: "missing-native-host",
  }),
) {
  const f = await createProcessTaskFixture(false);
  const resources = createProductResources(f.clock);
  const parent = resources.openTask("0");
  const registry = createAgentRegistry(starterAgentRegistrations());
  const notices: unknown[] = [];
  const tasks = createProcessTaskSupervisor({
    store: f.tasks,
    artifacts: f.artifacts,
    clock: f.clock,
    runId: "run-agent-test",
    process: f.snapshot.supervisor.process,
    async notify(notice) {
      notices.push(notice);
      return true;
    },
  });
  const route = roleRouteBaseSchema.parse({
    providerId: "test",
    providerProfileId: "test",
    modelId: "test",
  });
  const binding = {
    providerId: "test",
    providerProfileId: "test",
    providerDestinationId: "test",
    modelId: "test",
    reasoning: "provider-default" as const,
    reasoningControl: null,
  };
  let generation = 0;
  const service = createDelegation({
    registry,
    clock: f.clock,
    tasks,
    preferences: () => EMPTY_MODEL_PREFERENCES,
    configurationGeneration: () => generation,
    capability,
    bindModel: () => binding,
    execute,
  });
  let sequence = 2;
  async function request(): Promise<ToolRunnerRequest> {
    const event = {
      ...capabilityInvocationStarted(++sequence),
      invocationId: invocationId.from(`invocation-${sequence}`),
      payload: { capabilityVersion: 1, inputDigest: "a".repeat(64) },
    };
    taskValue(await f.events.append(event));
    return {
      invocationId: event.invocationId,
      toolCallId: String(event.invocationId),
      toolName: "delegate",
      capabilityId: event.capabilityId,
      version: 1,
      effect: "observation",
      input: {},
      signal: new AbortController().signal,
      taskResources: parent,
      processTask: {
        owner: {
          ...f.snapshot.owner,
          invocationId: String(event.invocationId),
          resourceTaskId: parent.id,
        },
        publishReceipt: () => true,
      },
      delegation: { route, binding, effects: ["observation"], capabilities: [] },
    };
  }
  return {
    ...f,
    store: f.tasks,
    service,
    registry,
    parent,
    tasks,
    notices,
    request,
    stale() {
      generation++;
    },
    async close() {
      tasks.interrupt();
      await tasks.drain();
      service.close();
      parent.close();
      await f.close();
    },
  };
}

test("seals real terminal facts durably without an invented child process", async () => {
  const f = await fixture();
  try {
    const result = sealedAgentResultSchema.parse(
      output(await f.service.execute(launch, await f.request())),
    );
    expect(result).toMatchObject({
      outcome: "completed",
      effect: "none",
      parentVerification: "not-asserted",
      observationRefs: ["observed-native-event"],
    });
    if (!result.handle.task) throw new Error("missing durable handle");
    expect(taskValue(f.store.get(result.handle.task))).toMatchObject({
      executionKind: "agent",
      process: null,
      state: "terminal",
      terminal: { outcome: "completed", reason: "agent-completed" },
    });
    expect(f.notices).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("native non-tool preparation contributes selected instructions and unavailable hosts stay unstarted", async () => {
  const instruction = {
    id: "fixture-skill",
    source: "native-fixture",
    generation: "1",
    text: "Inspect only the supplied source.",
    digest: bytesDigest("Inspect only the supplied source."),
  };
  const runs: AgentRun[] = [];
  const f = await fixture(
    async (run) => {
      runs.push(run);
      return facts;
    },
    (id) =>
      id === "fixture:skill"
        ? { ready: true, reason: "", instruction }
        : { ready: false, reason: "missing-native-host" },
  );
  try {
    const request = await f.request();
    if (!request.delegation) throw new Error("missing delegation frame");
    const preparedRequest = {
      ...request,
      delegation: {
        ...request.delegation,
        capabilities: ["fixture:skill", "fixture:browser", "fixture:mcp"],
      },
    };
    const result = sealedAgentResultSchema.parse(
      output(
        await f.service.execute({ ...launch, capabilities: ["fixture:skill"] }, preparedRequest),
      ),
    );
    expect(result.outcome).toBe("completed");
    expect(runs[0]?.prepared.context).toEqual([instruction]);
    for (const id of ["fixture:browser", "fixture:mcp"]) {
      expect(
        await f.service.execute({ ...launch, capabilities: [id] }, preparedRequest),
      ).toMatchObject({ status: "unavailable", reason: "missing-native-host", effect: "none" });
    }
    expect(runs).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test.each(["failed", "cancelled", "timed-out", "uncertain"] as const)(
  "preserves child %s despite successful result delivery",
  async (outcome) => {
    const f = await fixture(async () => ({
      ...facts,
      outcome,
      effect: outcome === "uncertain" ? "uncertain" : "partial",
    }));
    try {
      const result = sealedAgentResultSchema.parse(
        output(await f.service.execute(launch, await f.request())),
      );
      expect(result.outcome).toBe(outcome);
      if (!result.handle.task) throw new Error("missing durable handle");
      expect(taskValue(f.store.get(result.handle.task)).terminal?.outcome).toBe(outcome);
    } finally {
      await f.close();
    }
  },
);

test("rejects unknown definitions, altered evidence, bad input, and missing native capabilities before execution", async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return facts;
  });
  try {
    for (const command of [
      { ...launch, definitionId: "Explorer" },
      { ...launch, inputJson: '{"unexpected":true}' },
      {
        ...launch,
        context: [
          {
            id: "a",
            source: "user",
            generation: "1",
            text: "changed",
            digest: bytesDigest("original"),
          },
        ],
      },
      { ...launch, capabilities: ["unshipped:browser@1"] },
    ])
      expect((await f.service.execute(command, await f.request())).status).toBe("unavailable");
    expect(calls).toBe(0);
  } finally {
    await f.close();
  }
});

test("invalid structured output seals failure instead of accepting completion prose", async () => {
  const f = await fixture(async () => ({ ...facts, response: "Everything is verified!" }));
  try {
    const result = output(await f.service.execute(launch, await f.request()));
    expect(result).toMatchObject({
      outcome: "failed",
      claims: null,
      reason: "agent-result-schema-invalid",
    });
  } finally {
    await f.close();
  }
});

test("continuations keep prior results immutable, reject stale controls, and share the original allowance", async () => {
  const runs: AgentRun[] = [];
  const f = await fixture(async (run) => {
    runs.push(run);
    return facts;
  });
  try {
    const first = sealedAgentResultSchema.parse(
      output(await f.service.execute(launch, await f.request())),
    );
    const second = sealedAgentResultSchema.parse(
      output(
        await f.service.execute(
          {
            operation: "continue",
            handle: first.handle,
            inputJson: '{"objective":"Inspect a second source"}',
            context: [],
          },
          await f.request(),
        ),
      ),
    );
    expect(second.handle.generation).toBe(2);
    expect(second.previousResultDigest).toBe(first.resultDigest);
    expect(runs[0]?.admission).toBe(runs[1]?.admission);
    expect(
      output(
        await f.service.execute({ operation: "result", handle: first.handle }, await f.request()),
      ),
    ).toEqual(first);
    expect(
      await f.service.execute(
        { operation: "steer", handle: first.handle, text: "stale" },
        await f.request(),
      ),
    ).toMatchObject({ status: "unavailable", reason: "agent-stale-generation" });
    expect(
      await f.service.execute(
        { operation: "continue", handle: second.handle, inputJson: launch.inputJson, context: [] },
        await f.request(),
      ),
    ).toMatchObject({ status: "unavailable", reason: "agent-no-progress" });
    f.stale();
    expect(
      await f.service.execute(
        {
          operation: "continue",
          handle: second.handle,
          inputJson: '{"objective":"new work"}',
          context: [],
        },
        await f.request(),
      ),
    ).toMatchObject({ status: "unavailable", reason: "agent-stale-definition-or-configuration" });
  } finally {
    await f.close();
  }
});

test("background children survive parent response, serialize continuation, and admit bounded steering at a safe boundary", async () => {
  const started = Promise.withResolvers<AgentRun>();
  const release = Promise.withResolvers<void>();
  const f = await fixture(async (run) => {
    started.resolve(run);
    await release.promise;
    return facts;
  });
  try {
    const receipt = output(
      await f.service.execute(
        { ...launch, execution: { ...launch.execution, attachment: "background" } },
        await f.request(),
      ),
    );
    const run = await started.promise;
    f.parent.close();
    expect(run.signal.aborted).toBe(false);
    const handle = receipt.handle;
    expect(
      await f.service.execute(
        { operation: "continue", handle, inputJson: launch.inputJson, context: [] },
        await f.request(),
      ),
    ).toMatchObject({ reason: "agent-generation-running" });
    expect(
      output(
        await f.service.execute(
          { operation: "steer", handle, text: "Inspect the tests too" },
          await f.request(),
        ),
      ),
    ).toMatchObject({ state: "queued" });
    expect(run.takeSteering()).toHaveLength(1);
    expect(run.takeSteering()).toHaveLength(0);
    expect(
      (
        await f.service.execute(
          { operation: "steer", handle, text: "x".repeat(8192) },
          await f.request(),
        )
      ).status,
    ).toBe("unavailable");
    release.resolve();
    await f.tasks.drain();
    expect(
      output(await f.service.execute({ operation: "result", handle }, await f.request())),
    ).toMatchObject({ steering: [{ state: "admitted" }] });
  } finally {
    release.resolve();
    await f.close();
  }
});

test("foreground parent cancellation reaches the child and seals cancellation", async () => {
  const f = await fixture(async (run) => {
    await new Promise<void>((resolve) =>
      run.signal.aborted
        ? resolve()
        : run.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    return { ...facts, outcome: "cancelled", effect: "none" };
  });
  try {
    const receipt = output(
      await f.service.execute(
        { ...launch, execution: { ...launch.execution, foregroundWaitMs: 1 } },
        await f.request(),
      ),
    );
    f.parent.close();
    await f.tasks.drain();
    expect(
      output(
        await f.service.execute({ operation: "result", handle: receipt.handle }, await f.request()),
      ),
    ).toMatchObject({ outcome: "cancelled" });
  } finally {
    await f.close();
  }
});

test("concurrent continuation has one winner and a name never resolves an ambiguous child", async () => {
  const f = await fixture();
  try {
    const first = sealedAgentResultSchema.parse(
      output(await f.service.execute({ ...launch, name: "worker" }, await f.request())),
    );
    const command = {
      operation: "continue",
      handle: first.handle,
      inputJson: '{"objective":"another source"}',
      context: [],
    };
    const a = await f.request();
    const b = await f.request();
    const outcomes = await Promise.all([
      f.service.execute(command, a),
      f.service.execute(command, b),
    ]);
    expect(outcomes.filter((value) => value.status === "completed")).toHaveLength(1);
    expect(outcomes.filter((value) => value.status === "unavailable")).toHaveLength(1);
    await f.service.execute(
      { ...launch, name: "worker", inputJson: '{"objective":"distinct second child"}' },
      await f.request(),
    );
    expect(
      await f.service.execute({ operation: "resolve", name: "worker" }, await f.request()),
    ).toMatchObject({ reason: "agent-name-ambiguous" });
    expect(
      await f.service.execute({ operation: "resolve", name: "absent" }, await f.request()),
    ).toMatchObject({ reason: "agent-name-not-found" });
  } finally {
    await f.close();
  }
});

test("oversized child output preserves observed partial effects as a bounded failure", async () => {
  const f = await fixture(async () => ({
    ...facts,
    response: "x".repeat(100000),
    effect: "partial",
  }));
  try {
    expect(output(await f.service.execute(launch, await f.request()))).toMatchObject({
      outcome: "failed",
      effect: "partial",
      reason: "agent-result-limit",
      claims: null,
    });
  } finally {
    await f.close();
  }
});

test("serialized handles recover durable evidence but cannot reconstruct live continuation authority", async () => {
  const f = await fixture();
  try {
    const result = sealedAgentResultSchema.parse(
      output(await f.service.execute(launch, await f.request())),
    );
    f.service.close();
    const request = await f.request();
    expect(
      output(
        await f.service.execute(
          { operation: "inspect", handle: JSON.parse(JSON.stringify(result.handle)) },
          request,
        ),
      ),
    ).toMatchObject({ state: "terminal", executionKind: "agent" });
    expect(
      await f.service.execute(
        { operation: "continue", handle: result.handle, inputJson: launch.inputJson, context: [] },
        request,
      ),
    ).toMatchObject({ reason: "agent-retained-context-unavailable" });
  } finally {
    await f.close();
  }
});
