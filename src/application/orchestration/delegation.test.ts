import { afterEach, expect, test } from "bun:test";
import { createArtifactRepository } from "../../data/artifacts/artifact-repository.ts";
import { createArtifactStore } from "../../data/artifacts/artifact-store.ts";
import { openProductStoreOrThrow, removeTemporaryRoots } from "../../data/fixtures.ts";
import { createAgentJoinStore } from "../../data/orchestration/agent-join-store.ts";
import { createSqliteProcessTaskStore } from "../../data/orchestration/process-task-store.ts";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { capabilityInvocationStarted } from "../../domain/fixtures.ts";
import { invocationId, runId } from "../../domain/foundation/index.ts";
import { joinRecordSchema } from "../../domain/orchestration/agent-join.ts";
import type { EffectClass } from "../../domain/orchestration/work.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/index.ts";
import { createSha256Hasher } from "../../integrations/filesystem/content-digest.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  roleRouteBaseSchema,
} from "../../providers/configuration/policy-schema.ts";
import type { ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import { createAgentJoins } from "./agent-joins.ts";
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
  required: true,
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

test("parent joins validate sealed artifacts, freeze one receipt, and survive adapter restart", async () => {
  const f = await fixture();
  try {
    const child = sealedAgentResultSchema.parse(
      output(await f.service.execute(launch, await f.request())),
    );
    const command = {
      operation: "join",
      join: {
        id: "inspection",
        generation: 1,
        children: [child.handle],
        policy: { mode: "all", quorum: null, partialOnFailure: false, cancelRemaining: false },
      },
    };
    const joined = joinRecordSchema.parse(
      output(await f.service.execute(command, await f.request())),
    );
    expect(joined.state, JSON.stringify(joined.evidence)).toBe("satisfied");
    expect(joined.evidence[0]).toMatchObject({
      state: "completed",
      resultDigest: child.resultDigest,
    });
    expect(joined.continuation).toBeNull();
    const integration = {
      operation: "join-integrate",
      joinId: "inspection",
      joinGeneration: 1,
      integration: "accepted",
    };
    const [first, second] = await Promise.all([
      f.service.execute(integration, await f.request()),
      f.service.execute(integration, await f.request()),
    ]);
    expect(first).toEqual(second);
    const accepted = joinRecordSchema.parse(output(first));
    expect(accepted.continuation).not.toBeNull();
    const restored = createAgentJoinStore(f.database);
    expect(taskValue(restored.get(joined.owner, command.join))).toEqual(accepted);
    const revisions = taskValue(
      f.database.read("SELECT revision FROM agent_join_revisions ORDER BY sequence"),
    );
    expect(revisions.map((row) => row.revision)).toEqual([1, 2, 3]);
    expect(taskValue(restored.finish(joined.owner)).complete).toBe(true);
    expect(taskValue(restored.cleanup(joined.owner, command.join))).toBeNull();
    expect(taskValue(restored.get(joined.owner, command.join)).continuation).toBe(
      accepted.continuation,
    );
  } finally {
    await f.close();
  }
});

test("unjoined mandatory children block parent completion and artifact cleanup", async () => {
  const f = await fixture();
  try {
    const child = sealedAgentResultSchema.parse(
      output(await f.service.execute(launch, await f.request())),
    );
    if (!child.handle.task) throw new Error("missing task");
    const task = taskValue(f.store.get(child.handle.task));
    expect(f.store.cleanup(task.handle, task.revision, Number(f.clock.now()))).toMatchObject({
      ok: false,
      error: { code: "busy" },
    });
    const store = createAgentJoinStore(f.database);
    const link = taskValue(store.link({ ...child.handle, task: child.handle.task }));
    expect(taskValue(store.finish(link.owner)).complete).toBe(false);
    expect(f.store.cleanup(task.handle, task.revision, Number(f.clock.now())).ok).toBe(true);
    expect(
      store.create(link.owner, {
        id: "late",
        generation: 1,
        children: [link.handle],
        policy: { mode: "all", quorum: null, partialOnFailure: false, cancelRemaining: false },
      }),
    ).toMatchObject({ ok: false, error: { code: "closed" } });
  } finally {
    await f.close();
  }
});

test("a stale child generation cannot be accepted after its retry starts", async () => {
  const f = await fixture();
  try {
    const child = sealedAgentResultSchema.parse(
      output(await f.service.execute(launch, await f.request())),
    );
    const joined = joinRecordSchema.parse(
      output(
        await f.service.execute(
          {
            operation: "join",
            join: {
              id: "old",
              generation: 1,
              children: [child.handle],
              policy: {
                mode: "all",
                quorum: null,
                partialOnFailure: false,
                cancelRemaining: false,
              },
            },
          },
          await f.request(),
        ),
      ),
    );
    const next = sealedAgentResultSchema.parse(
      output(
        await f.service.execute(
          {
            operation: "continue",
            handle: child.handle,
            inputJson: '{"objective":"Inspect another source"}',
            context: [],
          },
          await f.request(),
        ),
      ),
    );
    expect(next.handle.generation).toBe(2);
    expect(createAgentJoinStore(f.database).integrate(joined, "accepted")).toMatchObject({
      ok: false,
      error: { code: "stale" },
    });
  } finally {
    await f.close();
  }
});

for (const checkpoint of ["child-sealed", "join-settled"] as const)
  test(`SQLite restart after ${checkpoint} admits one receipt without executing the child again`, async () => {
    let executions = 0;
    const f = await fixture(async () => {
      executions++;
      return facts;
    });
    let closed = false;
    try {
      const child = sealedAgentResultSchema.parse(
        output(await f.service.execute(launch, await f.request())),
      );
      if (!child.handle.task) throw new Error("missing task");
      const store = createAgentJoinStore(f.database);
      const link = taskValue(store.link({ ...child.handle, task: child.handle.task }));
      const input = {
        id: "restart",
        generation: 1,
        children: [link.handle],
        policy: {
          mode: "all" as const,
          quorum: null,
          partialOnFailure: false,
          cancelRemaining: false,
        },
      };
      let record = taskValue(store.create(link.owner, input));
      if (checkpoint === "join-settled")
        record = taskValue(
          await createAgentJoins({ store, tasks: f.store, artifacts: f.artifacts }).refresh(
            record,
            new AbortController().signal,
          ),
        );
      await f.close();
      closed = true;
      const database = await openProductStoreOrThrow(f.root);
      const artifacts = createArtifactStore({
        repository: createArtifactRepository(database, runId.from("run-task-fixture")),
        blobs: f.blobs,
        hasher: createSha256Hasher(),
        clock: f.clock,
      });
      try {
        const restored = createAgentJoinStore(database);
        const service = createAgentJoins({
          store: restored,
          tasks: createSqliteProcessTaskStore(database),
          artifacts,
        });
        const observed = taskValue(
          await service.refresh(
            taskValue(restored.get(link.owner, input)),
            new AbortController().signal,
          ),
        );
        expect(observed.state).toBe("satisfied");
        const accepted = taskValue(restored.integrate(observed, "accepted"));
        expect(taskValue(restored.integrate(observed, "accepted"))).toEqual(accepted);
        expect(executions).toBe(1);
        expect(
          taskValue(
            database.read("SELECT COUNT(*) AS count FROM agent_join_revisions WHERE revision=3"),
          )[0]?.count,
        ).toBe(1);
      } finally {
        await artifacts.quiesce();
        await database.close();
      }
    } finally {
      if (!closed) await f.close();
    }
  });

test("an inspection that waits returns once the join is decided, not at the first child change", async () => {
  const holds = Array.from({ length: 2 }, () => Promise.withResolvers<AgentExecution>());
  const runs: AgentRun[] = [];
  const started = Promise.withResolvers<void>();
  const f = await fixture(async (run) => {
    const index = runs.push(run) - 1;
    if (runs.length === 2) started.resolve();
    return holds[index]?.promise ?? facts;
  });
  try {
    const pending: Promise<ToolInvocationOutcome>[] = [];
    for (let i = 0; i < 2; i++)
      pending.push(
        f.service.execute(
          { ...launch, required: false, inputJson: JSON.stringify({ objective: `Writer ${i}` }) },
          await f.request(),
        ),
      );
    await started.promise;
    const join = async (id: string) =>
      f.service.execute(
        {
          operation: "join",
          join: {
            id,
            generation: 1,
            children: runs.map((run) => run.handle),
            policy: { mode: "all", quorum: null, partialOnFailure: false, cancelRemaining: false },
          },
        },
        await f.request(),
      );
    await join("all-writers");
    const inspect = (waitMs: number) =>
      f
        .request()
        .then((request) =>
          f.service.execute(
            { operation: "join-inspect", joinId: "all-writers", joinGeneration: 1, waitMs },
            request,
          ),
        );
    // A child that never finishes still ends the wait at its limit, undecided.
    expect(joinRecordSchema.parse(output(await inspect(50))).state).toBe("waiting");
    const inspecting = inspect(5_000);
    holds[0]?.resolve(facts);
    await pending[0];
    await Bun.sleep(50);
    holds[1]?.resolve(facts);
    await pending[1];
    expect(joinRecordSchema.parse(output(await inspecting)).state).toBe("satisfied");
  } finally {
    for (const hold of holds) hold.resolve(facts);
    await f.close();
  }
});

test("first-success ignores a faster failure and uses durable sibling settlement order", async () => {
  const holds = Array.from({ length: 3 }, () => Promise.withResolvers<AgentExecution>());
  const runs: AgentRun[] = [];
  const started = Promise.withResolvers<void>();
  const f = await fixture(async (run) => {
    const index = runs.push(run) - 1;
    if (runs.length === 3) started.resolve();
    return holds[index]?.promise ?? facts;
  });
  try {
    const pending: Promise<ToolInvocationOutcome>[] = [];
    for (let i = 0; i < 3; i++)
      pending.push(
        f.service.execute(
          { ...launch, required: false, inputJson: JSON.stringify({ objective: `Sibling ${i}` }) },
          await f.request(),
        ),
      );
    await started.promise;
    const joined = joinRecordSchema.parse(
      output(
        await f.service.execute(
          {
            operation: "join",
            join: {
              id: "race",
              generation: 1,
              children: runs.map((run) => run.handle),
              policy: {
                mode: "first-success",
                quorum: null,
                partialOnFailure: true,
                cancelRemaining: false,
              },
            },
          },
          await f.request(),
        ),
      ),
    );
    expect(joined.state).toBe("waiting");
    holds[0]?.resolve({ ...facts, outcome: "failed", effect: "partial", reason: "failed-fast" });
    await pending[0];
    holds[2]?.resolve(facts);
    await pending[2];
    holds[1]?.resolve(facts);
    await pending[1];
    const settled = joinRecordSchema.parse(
      output(
        await f.service.execute(
          { operation: "join-inspect", joinId: "race", joinGeneration: 1 },
          await f.request(),
        ),
      ),
    );
    expect(settled.state).toBe("satisfied");
    const winner = runs[2];
    if (!winner) throw new Error("missing sibling");
    expect(settled.selected).toEqual([winner.handle.taskId]);
    expect(settled.evidence[0]).toMatchObject({ state: "failed", effect: "partial", sequence: 1 });
    expect(settled.evidence[2]?.sequence).toBe(2);
    expect(settled.evidence[1]?.sequence).toBe(3);
  } finally {
    for (const hold of holds) hold.resolve(facts);
    await f.close();
  }
});

for (const settleWith of ["join-inspect", "join-integrate"] as const) {
  test(`${settleWith} waits for pending siblings and applies cancelRemaining`, async () => {
    const runs: AgentRun[] = [];
    const started = Promise.withResolvers<void>();
    const holds = Array.from({ length: 3 }, () => Promise.withResolvers<AgentExecution>());
    const f = await fixture(async (run) => {
      const index = runs.push(run) - 1;
      if (runs.length === 3) started.resolve();
      return holds[index]?.promise ?? facts;
    });
    try {
      const launches: Promise<ToolInvocationOutcome>[] = [];
      for (let i = 0; i < 3; i++)
        launches.push(
          f.service.execute(
            {
              ...launch,
              required: false,
              inputJson: JSON.stringify({ objective: `Wait sibling ${i}` }),
            },
            await f.request(),
          ),
        );
      await started.promise;
      await f.service.execute(
        {
          operation: "join",
          join: {
            id: "wait-siblings",
            generation: 1,
            children: runs.map((run) => run.handle),
            policy: {
              mode: "first-success",
              quorum: null,
              partialOnFailure: false,
              cancelRemaining: true,
            },
          },
        },
        await f.request(),
      );
      holds[0]?.resolve({ ...facts, outcome: "failed", reason: "first-failed" });
      await launches[0];
      const request = await f.request();
      let settled = false;
      const inspect =
        settleWith === "join-inspect"
          ? f.service
              .execute(
                {
                  operation: settleWith,
                  joinId: "wait-siblings",
                  joinGeneration: 1,
                  waitMs: 30000,
                },
                request,
              )
              .then((result) => {
                settled = true;
                return result;
              })
          : null;
      // Give the wait its opportunity to observe the already terminal first sibling.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      holds[1]?.resolve(facts);
      await launches[1];
      const result = joinRecordSchema.parse(
        output(
          await (inspect ??
            f.service.execute(
              {
                operation: settleWith,
                joinId: "wait-siblings",
                joinGeneration: 1,
                integration: "accepted",
              },
              request,
            )),
        ),
      );
      expect(result.state).toBe("satisfied");
      const winner = runs[1];
      if (!winner) throw new Error("missing winner");
      expect(result.selected).toEqual([winner.handle.taskId]);
      expect(runs[2]?.signal.aborted).toBe(true);
      if (settleWith === "join-integrate") expect(result.integration).toBe("accepted");
      holds[2]?.resolve({ ...facts, outcome: "cancelled" });
      await launches[2];
    } finally {
      for (const hold of holds) hold.resolve(facts);
      await f.close();
    }
  });
}

test("join retention is bounded and a corrupt revision cannot close the parent", async () => {
  const f = await fixture();
  try {
    const child = sealedAgentResultSchema.parse(
      output(await f.service.execute(launch, await f.request())),
    );
    if (!child.handle.task) throw new Error("missing task");
    const store = createAgentJoinStore(f.database);
    const link = taskValue(store.link({ ...child.handle, task: child.handle.task }));
    const input = {
      id: "capacity",
      generation: 1,
      children: [link.handle],
      policy: {
        mode: "all" as const,
        quorum: null,
        partialOnFailure: false,
        cancelRemaining: false,
      },
    };
    for (let i = 0; i < 64; i++)
      expect(store.create(link.owner, { ...input, id: `join-${i}` }).ok).toBe(true);
    expect(store.create(link.owner, input)).toMatchObject({
      ok: false,
      error: { code: "capacity" },
    });
    taskValue(
      f.database.write((sql) =>
        sql.run("UPDATE agent_join_revisions SET record='{}' WHERE sequence=1"),
      ),
    );
    expect(store.get(link.owner, { id: "join-0", generation: 1 })).toMatchObject({
      ok: false,
      error: { code: "corrupt" },
    });
    expect(store.finish(link.owner)).toMatchObject({ ok: false, error: { code: "corrupt" } });
    expect(taskValue(f.database.read("SELECT closed FROM agent_parents"))).toEqual([{ closed: 0 }]);
  } finally {
    await f.close();
  }
});

test("cancelled joins remain frozen when late terminal effects arrive", async () => {
  const started = Promise.withResolvers<AgentRun>();
  const hold = Promise.withResolvers<AgentExecution>();
  const f = await fixture(async (run) => {
    started.resolve(run);
    return hold.promise;
  });
  try {
    const pending = f.service.execute(launch, await f.request());
    const run = await started.promise;
    const input = {
      id: "cancel-race",
      generation: 1,
      children: [run.handle],
      policy: { mode: "all", quorum: null, partialOnFailure: false, cancelRemaining: false },
    };
    expect(
      joinRecordSchema.parse(
        output(await f.service.execute({ operation: "join", join: input }, await f.request())),
      ).state,
    ).toBe("waiting");
    if (!run.handle.task) throw new Error("missing task");
    const running = taskValue(f.store.get(run.handle.task));
    expect(
      await f.tasks.control(await f.request(), {
        operation: "cancel",
        ...run.handle.task,
        expectedRevision: running.revision,
      }),
    ).toMatchObject({ status: "unavailable", reason: "agent-control-owner-required" });
    expect(run.signal.aborted).toBe(false);
    const cancelled = joinRecordSchema.parse(
      output(
        await f.service.execute(
          { operation: "join-cancel", joinId: input.id, joinGeneration: 1 },
          await f.request(),
        ),
      ),
    );
    expect(cancelled.state).toBe("cancelled");
    expect(run.signal.aborted).toBe(true);
    hold.resolve({
      ...facts,
      outcome: "cancelled",
      effect: "partial",
      reason: "late-write-observed",
    });
    const child = sealedAgentResultSchema.parse(output(await pending));
    expect(child.effect).toBe("partial");
    expect(
      joinRecordSchema.parse(
        output(
          await f.service.execute(
            { operation: "join-inspect", joinId: input.id, joinGeneration: 1 },
            await f.request(),
          ),
        ),
      ),
    ).toEqual(cancelled);
    expect(
      await f.service.execute(
        {
          operation: "join-integrate",
          joinId: input.id,
          joinGeneration: 1,
          integration: "accepted",
        },
        await f.request(),
      ),
    ).toMatchObject({ status: "unavailable", reason: "agent-join-invalid" });
  } finally {
    hold.resolve(facts);
    await f.close();
  }
});

test("artifact corruption and a foreign parent cannot become accepted evidence", async () => {
  const f = await fixture();
  try {
    const child = sealedAgentResultSchema.parse(
      output(await f.service.execute(launch, await f.request())),
    );
    const command = {
      operation: "join",
      join: {
        id: "invalid-evidence",
        generation: 1,
        children: [child.handle],
        policy: { mode: "all", quorum: null, partialOnFailure: false, cancelRemaining: false },
      },
    };
    const foreign = await f.request();
    if (!foreign.processTask) throw new Error("missing owner");
    expect(
      await f.service.execute(command, {
        ...foreign,
        processTask: {
          ...foreign.processTask,
          owner: { ...foreign.processTask.owner, turnId: "foreign-turn" },
        },
      }),
    ).toMatchObject({ status: "unavailable", reason: "agent-join-foreign-parent" });
    const location = f.blobs.locations()[0];
    if (!location) throw new Error("missing artifact");
    f.blobs.put(location, new Uint8Array([0]));
    const joined = joinRecordSchema.parse(
      output(await f.service.execute(command, await f.request())),
    );
    expect(joined.state).toBe("failed");
    expect(joined.evidence[0]?.state).toBe("invalid");
    expect(joined.selected).toEqual([]);
  } finally {
    await f.close();
  }
});

test("a detached child can receive a later root assignment without resetting its lineage or allowance", async () => {
  const runs: AgentRun[] = [];
  const f = await fixture(async (run) => {
    runs.push(run);
    return facts;
  });
  const nextRoot = createProductResources(f.clock).openTask("0");
  try {
    const receipt = output(
      await f.service.execute(
        { ...launch, execution: { ...launch.execution, attachment: "background" } },
        await f.request(),
      ),
    );
    await f.service.execute(
      { operation: "wait", handle: receipt.handle, waitMs: 30000 },
      await f.request(),
    );
    // The durable terminal precedes the live executor's notify/finally cleanup.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const first = sealedAgentResultSchema.parse(
      output(
        await f.service.execute({ operation: "result", handle: receipt.handle }, await f.request()),
      ),
    );
    f.parent.close();
    const request = await f.request();
    if (!request.processTask) throw new Error("missing owner");
    const nextRequest = {
      ...request,
      taskResources: nextRoot,
      processTask: {
        ...request.processTask,
        owner: { ...request.processTask.owner, resourceTaskId: nextRoot.id },
      },
    };
    const next = output(
      await f.service.execute(
        {
          operation: "continue",
          handle: first.handle,
          inputJson: '{"objective":"Later independent assignment"}',
          context: [],
        },
        nextRequest,
      ),
    );
    await f.service.execute({ operation: "wait", handle: next.handle, waitMs: 30000 }, nextRequest);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = sealedAgentResultSchema.parse(
      output(await f.service.execute({ operation: "result", handle: next.handle }, nextRequest)),
    );
    expect(second.parent.taskId).toBe(nextRoot.id);
    expect(second.rootTaskId).toBe(first.rootTaskId);
    expect(second.previousResultDigest).toBe(first.resultDigest);
    expect(runs[0]?.admission.resources).toBe(runs[1]?.admission.resources);
  } finally {
    nextRoot.close();
    await f.close();
  }
});

test("parent closure settles outstanding joins once and releases their active retention", async () => {
  const f = await fixture();
  try {
    const child = sealedAgentResultSchema.parse(
      output(await f.service.execute(launch, await f.request())),
    );
    if (!child.handle.task) throw new Error("missing task");
    const store = createAgentJoinStore(f.database);
    const link = taskValue(store.link({ ...child.handle, task: child.handle.task }));
    const input = {
      id: "unfinished",
      generation: 1,
      children: [link.handle],
      policy: {
        mode: "all" as const,
        quorum: null,
        partialOnFailure: false,
        cancelRemaining: false,
      },
    };
    taskValue(store.create(link.owner, input));
    const completion = taskValue(store.finish(link.owner));
    expect(completion.complete).toBe(false);
    const record = taskValue(store.get(link.owner, input));
    expect(record).toMatchObject({
      state: "cancelled",
      integration: "follow-up-required",
      revision: 3,
    });
    expect(record.continuation).not.toBeNull();
    expect(taskValue(store.finish(link.owner))).toEqual(completion);
    expect(
      taskValue(f.database.read("SELECT COUNT(*) AS count FROM agent_joins WHERE released=0"))[0]
        ?.count,
    ).toBe(0);
    expect(
      taskValue(
        f.database.read("SELECT COUNT(*) AS count FROM agent_join_revisions WHERE revision=3"),
      )[0]?.count,
    ).toBe(1);
  } finally {
    await f.close();
  }
});
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
  scoped: {
    readonly effects?: EffectClass[];
    readonly capabilities?: readonly string[];
    readonly confined?: boolean;
  } = {},
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
    joins: createAgentJoins({
      store: createAgentJoinStore(f.database),
      tasks: f.tasks,
      artifacts: f.artifacts,
    }),
    registry,
    clock: f.clock,
    tasks,
    preferences: () => EMPTY_MODEL_PREFERENCES,
    configurationGeneration: () => generation,
    capability,
    commandWritesConfined: () => scoped.confined ?? false,
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
      delegation: {
        route,
        binding,
        effects: scoped.effects ?? ["observation"],
        capabilities: [...(scoped.capabilities ?? [])],
      },
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

const writer = (scope?: string[], objective = "Edit source"): AgentLaunch => ({
  ...launch,
  definitionId: "builtin/falryn/agents:implementer",
  inputJson: JSON.stringify({ objective }),
  effects: ["observation", "mutation"],
  execution: { ...launch.execution, foregroundWaitMs: 1 },
  ...(scope ? { editScope: scope } : {}),
});
const writing = { effects: ["observation", "mutation"] as EffectClass[] };
function held() {
  const gates: (() => void)[] = [];
  return {
    execute: (run: AgentRun) =>
      new Promise<AgentExecution>((resolve) => {
        gates.push(() => resolve({ ...facts, effect: "completed" }));
        run.signal.addEventListener("abort", () =>
          resolve({ ...facts, outcome: "cancelled", effect: "none" }),
        );
      }),
    releaseAll() {
      for (const gate of gates.splice(0)) gate();
    },
  };
}

test("disjoint writers run together; an overlapping launch names the running writer until it settles", async () => {
  const gate = held();
  const f = await fixture(gate.execute, undefined, writing);
  try {
    const a = output(await f.service.execute(writer(["src/a"], "Edit a"), await f.request())) as {
      handle: { taskId: string };
    };
    expect(a).toMatchObject({
      kind: "agent-running",
      preparation: { execution: { editScope: ["src/a"] } },
    });
    const b = output(
      await f.service.execute(writer(["./src/b/"], "Edit b"), await f.request()),
    ) as {
      handle: { taskId: string };
    };
    expect(b).toMatchObject({
      kind: "agent-running",
      preparation: { execution: { editScope: ["src/b"] } },
    });
    const overlap = writer(["src"], "Edit everything");
    const refused = output(await f.service.execute(overlap, await f.request()));
    expect(refused).toMatchObject({
      kind: "agent-launch-refused",
      reason: "edit-scope-overlap",
      executionStarted: false,
      conflict: { handle: { generation: 1, task: expect.any(Object) } },
    });
    // Either running writer is a truthful conflict; both overlap `src`.
    expect([a.handle.taskId, b.handle.taskId]).toContain(
      (refused as { conflict: { handle: { taskId: string } } }).conflict.handle.taskId,
    );
    gate.releaseAll();
    for (const handle of [a.handle, b.handle])
      await f.service.execute({ operation: "wait", handle, waitMs: 5000 }, await f.request());
    expect(output(await f.service.execute(overlap, await f.request()))).toMatchObject({
      kind: "agent-running",
    });
    gate.releaseAll();
  } finally {
    gate.releaseAll();
    await f.close();
  }
});

test("unscoped writers are exclusive, readers never reserve, and read-only definitions reject a scope", async () => {
  const gate = held();
  const f = await fixture(gate.execute, undefined, writing);
  try {
    output(await f.service.execute(writer(undefined, "Edit anything"), await f.request()));
    expect(
      output(await f.service.execute(writer(undefined, "Edit more"), await f.request())),
    ).toMatchObject({ reason: "edit-scope-overlap" });
    expect(
      output(await f.service.execute(writer(["docs"], "Edit docs"), await f.request())),
    ).toMatchObject({ reason: "edit-scope-overlap" });
    expect(
      output(
        await f.service.execute(
          { ...launch, execution: { ...launch.execution, foregroundWaitMs: 1 } },
          await f.request(),
        ),
      ),
    ).toMatchObject({ kind: "agent-running" });
    expect(
      await f.service.execute({ ...launch, editScope: ["src"] }, await f.request()),
    ).toMatchObject({ status: "unavailable", reason: "edit-scope-invalid" });
    expect(await f.service.execute(writer(["../outside"]), await f.request())).toMatchObject({
      status: "unavailable",
      reason: "edit-scope-invalid",
    });
  } finally {
    gate.releaseAll();
    await f.close();
  }
});

test("two overlapping launches racing for one scope admit exactly one", async () => {
  const gate = held();
  const f = await fixture(gate.execute, undefined, writing);
  try {
    const [left, right] = await Promise.all([
      f.request().then((request) => f.service.execute(writer(["src"], "Left"), request)),
      f.request().then((request) => f.service.execute(writer(["src/x"], "Right"), request)),
    ]);
    const kinds = [left, right].map((value) => output(value).kind).sort();
    expect(kinds).toEqual(["agent-launch-refused", "agent-running"]);
  } finally {
    gate.releaseAll();
    await f.close();
  }
});

test("command capabilities need a confining sandbox and directory scopes", async () => {
  const capability: DelegationOptions["capability"] = (id) => ({
    ready: true,
    reason: "",
    writes: id === "run_shell" ? "sandbox" : id === "git_commit" ? "unbounded" : "paths",
  });
  const request = { ...writing, capabilities: ["run_shell", "git_commit", "write_files"] };
  const withShell = (scope: string[]) => ({
    ...writer(scope),
    capabilities: ["run_shell", "write_files"],
  });
  const off = await fixture(async () => facts, capability, request);
  try {
    expect(output(await off.service.execute(withShell(["src"]), await off.request()))).toEqual({
      kind: "agent-launch-refused",
      reason: "edit-scope-unenforceable",
      capabilities: ["run_shell"],
      executionStarted: false,
    });
    expect(
      output(
        await off.service.execute(
          { ...writer(["src"]), capabilities: ["git_commit"] },
          await off.request(),
        ),
      ),
    ).toMatchObject({ reason: "edit-scope-unenforceable", capabilities: ["git_commit"] });
  } finally {
    await off.close();
  }
  const strict = await fixture(async () => facts, capability, { ...request, confined: true });
  try {
    expect(
      output(await strict.service.execute(withShell(["src"]), await strict.request())),
    ).toMatchObject({ outcome: expect.any(String) });
    expect(
      output(await strict.service.execute(withShell(["src/*.ts"]), await strict.request())),
    ).toMatchObject({ reason: "edit-scope-unenforceable", capabilities: ["run_shell"] });
  } finally {
    await strict.close();
  }
});

test("uncertain effects keep the scope reserved until cleanup; continuation reserves again", async () => {
  let uncertain = true;
  const f = await fixture(
    async () =>
      uncertain
        ? {
            ...facts,
            outcome: "uncertain",
            effect: "uncertain",
            reason: "agent-execution-interrupted",
          }
        : facts,
    undefined,
    writing,
  );
  try {
    // A background child can be cleaned up without the parent integrating it.
    const launched = writer(["src"], "Uncertain");
    const running = output(
      await f.service.execute(
        { ...launched, execution: { ...launched.execution, attachment: "background" } },
        await f.request(),
      ),
    ) as { handle: { taskId: string; generation: number } };
    await f.service.execute(
      { operation: "wait", handle: running.handle, waitMs: 5000 },
      await f.request(),
    );
    expect(running).toMatchObject({ preparation: { execution: { editScope: ["src"] } } });
    const settled = output(
      await f.service.execute({ operation: "result", handle: running.handle }, await f.request()),
    ) as { task: { handle: { version: 1; taskId: string; generation: string }; state: string } };
    expect(settled.task.state).toBe("terminal");
    const blocked = writer(["src/a"], "Later");
    expect(output(await f.service.execute(blocked, await f.request()))).toMatchObject({
      reason: "edit-scope-overlap",
      conflict: { handle: { taskId: running.handle.taskId } },
    });
    const revision = taskValue(f.store.get(settled.task.handle)).revision;
    expect(
      await f.service.execute(
        {
          operation: "cleanup",
          handle: { ...running.handle, task: settled.task.handle },
          expectedRevision: revision,
        },
        await f.request(),
      ),
    ).toMatchObject({ status: "completed" });
    uncertain = false;
    const next = sealedAgentResultSchema.parse(
      output(
        await f.service.execute(
          { ...blocked, execution: { ...blocked.execution, foregroundWaitMs: 30000 } },
          await f.request(),
        ),
      ),
    );
    expect(next.preparation.execution.editScope).toEqual(["src/a"]);
  } finally {
    await f.close();
  }
});

test("a restarted store restores active reservations, expires unlinked ones and relaunches nothing", async () => {
  const gate = held();
  let executions = 0;
  const f = await fixture(
    async (run) => {
      executions++;
      return gate.execute(run);
    },
    undefined,
    writing,
  );
  try {
    const running = output(await f.service.execute(writer(["src"], "Hold"), await f.request())) as {
      handle: { taskId: string };
    };
    // A second store over the same database is what a restarted process reads.
    const restarted = createAgentJoinStore(f.database);
    const now = Number(f.clock.now());
    expect(
      restarted.reserveEditScope({
        taskId: "agent-after-restart",
        generation: 1,
        workspaceId: f.snapshot.owner.workspaceId,
        scope: ["src/deep"],
        now,
      }),
    ).toMatchObject({ ok: true, value: { conflict: { taskId: running.handle.taskId } } });
    expect(executions).toBe(1);
    // An admission that never linked its task within the bound never started, so it expires.
    expect(
      restarted.reserveEditScope({
        taskId: "agent-crashed-before-link",
        generation: 1,
        workspaceId: "workspace-other",
        scope: null,
        now,
      }),
    ).toMatchObject({ ok: true, value: { conflict: null } });
    expect(
      restarted.reserveEditScope({
        taskId: "agent-later",
        generation: 1,
        workspaceId: "workspace-other",
        scope: ["docs"],
        now: now + 60_001,
      }),
    ).toMatchObject({ ok: true, value: { conflict: null } });
    gate.releaseAll();
    await f.service.execute(
      { operation: "wait", handle: running.handle, waitMs: 5000 },
      await f.request(),
    );
    expect(
      restarted.reserveEditScope({
        taskId: "agent-after-settle",
        generation: 1,
        workspaceId: f.snapshot.owner.workspaceId,
        scope: ["src"],
        now: Number(f.clock.now()),
      }),
    ).toMatchObject({ ok: true, value: { conflict: null } });
  } finally {
    gate.releaseAll();
    await f.close();
  }
});

test("inspect reports a running child's admitted edit scope", async () => {
  const gate = held();
  const f = await fixture(gate.execute, undefined, writing);
  try {
    const running = output(
      await f.service.execute(writer(["src/a"], "Inspect me"), await f.request()),
    ) as {
      handle: { taskId: string; generation: number };
    };
    expect(
      output(
        await f.service.execute(
          { operation: "inspect", handle: running.handle },
          await f.request(),
        ),
      ),
    ).toMatchObject({ editScope: ["src/a"] });
  } finally {
    gate.releaseAll();
    await f.close();
  }
});

test("a continuation refused for overlap can be retried unchanged after the sibling settles", async () => {
  let release = () => {};
  const blocking = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(
    async (run) => {
      if (JSON.stringify(run.input).includes("Hold")) await blocking;
      return facts;
    },
    undefined,
    writing,
  );
  try {
    const first = sealedAgentResultSchema.parse(
      output(
        await f.service.execute(
          { ...writer(["src/a"], "Edit a"), execution: { ...launch.execution } },
          await f.request(),
        ),
      ),
    );
    const sibling = output(await f.service.execute(writer(["src"], "Hold"), await f.request())) as {
      handle: { taskId: string; generation: number };
    };
    const command = {
      operation: "continue",
      handle: first.handle,
      inputJson: JSON.stringify({ objective: "Edit a again" }),
      context: [],
    };
    expect(output(await f.service.execute(command, await f.request()))).toMatchObject({
      reason: "edit-scope-overlap",
      conflict: { handle: { taskId: sibling.handle.taskId } },
    });
    release();
    await f.service.execute(
      { operation: "wait", handle: sibling.handle, waitMs: 5000 },
      await f.request(),
    );
    expect(output(await f.service.execute(command, await f.request()))).toMatchObject({
      kind: "agent-result",
      handle: { generation: 2 },
    });
  } finally {
    release();
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
