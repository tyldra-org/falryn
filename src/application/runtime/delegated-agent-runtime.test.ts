import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { createAgentJoinStore } from "../../data/orchestration/agent-join-store.ts";
import { createMailboxRepository } from "../../data/orchestration/mailbox-store.ts";
import { createSqliteWorkQueueStore } from "../../data/orchestration/work-queue-store.ts";
import { createWorkflowStore } from "../../data/orchestration/workflow-store.ts";
import { artifactId } from "../../domain/artifacts/artifact.ts";
import { createCapabilityRegistry } from "../../domain/capabilities/index.ts";
import { sourceFixture } from "../../domain/context/instruction-sources.fixtures.ts";
import { EMPTY_SOURCE_PREFERENCES } from "../../domain/context/instruction-sources.ts";
import { bytesDigest, canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  configurationGeneration,
  instant,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import type { WorkQueue } from "../../domain/orchestration/work-queue.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import { createPeerCrypto } from "../../integrations/process/peer-crypto.ts";
import { createPeerIpc } from "../../integrations/process/peer-ipc.ts";
import { namedRouteDefinitionSchema } from "../../providers/configuration/named-route.ts";
import { bindNamedModelPreferences } from "../../providers/configuration/named-route-binding.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  roleRouteBaseSchema,
} from "../../providers/configuration/policy-schema.ts";
import {
  catalogFromAdapterModels,
  createDeterministicProviderAdapter,
  type DeterministicProviderScript,
  type ModelRequest,
} from "../../providers/index.ts";
import { routeFacts } from "../../providers/routing/named-route.fixtures.ts";
import { capabilityEntryFromTool } from "../capabilities/product-capability-registry.ts";
import { createInstructionSourceOwner } from "../context/instruction-source-owner.ts";
import type { ProductInstructions } from "../context/product-instructions.ts";
import { agentDefinitionSchema } from "../orchestration/agent-definition.ts";
import { createAgentJoins } from "../orchestration/agent-joins.ts";
import { createAgentRegistry, starterAgentRegistrations } from "../orchestration/agent-registry.ts";
import {
  type SealedAgentResult,
  sealedAgentResultSchema,
} from "../orchestration/delegation-contract.ts";
import { openPeerMailbox, type PeerMailbox } from "../orchestration/peer-mailbox.ts";
import { createProcessTaskFixture, taskValue } from "../orchestration/process-task.fixtures.ts";
import { createProcessTaskSupervisor } from "../orchestration/process-task-supervisor.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import {
  createProductWorkQueueAuthority,
  PRODUCT_WORK_ACTOR,
  type ProductTaskLists,
} from "../orchestration/work-queue-authority.ts";
import { createWorkQueueActions } from "../orchestration/work-queues.ts";
import { composePeerTool, PEER_CAPABILITY } from "../tools/peer-tool.ts";
import { createWorkspacePatcher } from "../workspace/workspace-patch.ts";
import {
  composeDelegatedAgentRuntime,
  type DelegatedRuntimeOptions,
} from "./delegated-agent-runtime.ts";
import { createProductLiveTurnExecutor } from "./product-live-turn.ts";
import { processingProduct } from "./product-processing.fixture.ts";
import type { ToolRunnerRequest } from "./tool-call-loop.ts";

afterEach(removeTemporaryRoots);
type TaskListContext = {
  readonly runtime: Extract<ReturnType<typeof composeDelegatedAgentRuntime>, { ok: true }>["value"];
  readonly store: ReturnType<typeof workQueueStore>;
  readonly resources: ReturnType<typeof createProductResources>;
  readonly clock: Awaited<ReturnType<typeof createProcessTaskFixture>>["clock"];
  readonly database: Awaited<ReturnType<typeof createProcessTaskFixture>>["database"];
  readonly artifacts: Awaited<ReturnType<typeof createProcessTaskFixture>>["artifacts"];
};
function workQueueStore(
  database: Awaited<ReturnType<typeof createProcessTaskFixture>>["database"],
) {
  return createSqliteWorkQueueStore(database, {
    locator: "workspace-state",
    durability: "durable",
  });
}
const inspect = "builtin:workspace/inspect@1";
const delegate = "builtin:orchestration/delegate@1";
const explorerResult = JSON.stringify({
  locations: [],
  flow: [],
  findings: ["inspected"],
  unknowns: [],
});
const generalResult = JSON.stringify({
  outcome: ["child inspected"],
  evidence: [],
  changes: [],
  checks: [],
  unresolved: [],
});
function launch(
  definition: string,
  objective: string,
  capabilities: string[],
  effects: string[] = ["observation"],
  required = false,
): DeterministicProviderScript {
  return {
    kind: "tool",
    toolCallId: `launch-${definition}-${objective.replace(/\W/g, "-")}`,
    name: "delegate",
    argumentFragments: [
      JSON.stringify({
        operation: "launch",
        required,
        definitionId: `builtin/falryn/agents:${definition}`,
        inputJson: JSON.stringify({ objective }),
        context: [],
        capabilities,
        effects,
        limits: {},
        execution: {
          version: 1,
          attachment: "foreground",
          foregroundWaitMs: 1000,
          onSettle: "notify",
          shutdown: "drain",
        },
      }),
    ],
  };
}

async function run(
  script: (request: ModelRequest, index: number) => DeterministicProviderScript,
  options: Partial<
    Pick<DelegatedRuntimeOptions, "preferences" | "resolveProvider" | "registry">
  > & {
    nativeDenied?: boolean;
    withPeers?: boolean;
    withWorkflows?: boolean;
    /** Registers the fixture database's workspace-state queue location with the workflows. */
    withTaskLists?: {
      before(context: TaskListContext): Promise<void>;
      after(context: TaskListContext): Promise<void>;
    };
    prompt?: string;
    processing?: boolean;
    instructions?: ProductInstructions;
  } = {},
  nativeEffect: "observation" | "mutation" | "external" = "observation",
  native?: {
    name: string;
    schema: z.ZodType<Readonly<Record<string, unknown>>>;
    execute(request: ToolRunnerRequest): Promise<ToolInvocationOutcome>;
  },
  afterParent?: () => void,
  maxConcurrent = 1,
) {
  const f = await createProcessTaskFixture(false);
  const requests: ModelRequest[] = [];
  const scripted = createDeterministicProviderAdapter({
    script,
    onRequest: (request) => requests.push(request),
  });
  const qualified = options.processing ? processingProduct() : null;
  const adapter = qualified
    ? {
        ...qualified.adapter,
        modelCapabilities:
          scripted.modelCapabilities?.map((capability) => ({
            ...capability,
            pricing: qualified.state.pricing,
          })) ?? [],
        stream: scripted.stream,
      }
    : scripted;
  const catalog = catalogFromAdapterModels(adapter.supportedModels, {
    generation: 0,
    fetchedAt: instant(0),
    capabilities: adapter.modelCapabilities,
  });
  const notices: unknown[] = [];
  const tasks = createProcessTaskSupervisor({
    store: f.tasks,
    artifacts: f.artifacts,
    clock: f.clock,
    runId: "agent-runtime-test",
    process: f.snapshot.supervisor.process,
    notify: async (notice) => {
      notices.push(notice);
      return true;
    },
  });
  const entry = taskValue(
    createToolRegistryEntry(
      {
        namespace: "workspace",
        name: native?.name ?? "inspect",
        version: 1,
        source: "builtin",
        title: "Inspect workspace",
        description: "Inspect a source fact",
        effect: nativeEffect,
        capabilityKind: "filesystem",
        platforms: [],
        limits: defaultToolLimits(),
        concurrency: defaultConcurrencyContract(),
        resultProjection: defaultProjectionContract(),
      },
      {
        inputSchema: native?.schema ?? z.strictObject({}),
        outputSchema: z.record(z.string(), z.unknown()),
      },
    ),
  );
  const peerTool = composePeerTool(configurationGeneration.from(0), null);
  const registry = taskValue(
    createToolRegistry(configurationGeneration.from(0), [
      entry,
      ...(options.withPeers ? peerTool.registry.entries : []),
    ]),
  );
  const capability = capabilityEntryFromTool(entry, true);
  const capabilityRegistry = taskValue(
    createCapabilityRegistry(configurationGeneration.from(0), [
      {
        ...capability,
        state: {
          ...capability.state,
          operational: {
            ...capability.state.operational,
            allowed: !options.nativeDenied,
            denied: options.nativeDenied ?? false,
          },
        },
      },
    ]),
  );
  let tools = 0;
  const resources = createProductResources(f.clock, { maxConcurrent });
  const peers: PeerMailbox[] = [];
  const peerIdentities: unknown[] = [];
  const repository = createMailboxRepository(f.database);
  const composed = composeDelegatedAgentRuntime(
    {
      ...(options.instructions ? { instructions: options.instructions } : {}),
      historyArtifacts: f.artifacts,
      eventStore: f.events,
      clock: f.clock,
      resources,
      streamId: streamId.from("agent-test-parent"),
      correlation: {
        sessionId: sessionId.from("agent-test-parent"),
        workspaceId: workspaceId.from("workspace-fixture"),
        traceId: traceId.from("agent-test-trace"),
        configurationGeneration: configurationGeneration.from(0),
      },
      providerAdapter: adapter,
      toolConfirmation: {
        async resolve(request) {
          return { kind: "confirmed", confirmationId: request.confirmationId };
        },
      },
      toolRegistry: registry,
      capabilityRegistry,
      toolRunner: {
        hasBinding: (id) =>
          id === entry.manifest.capabilityId ||
          (options.withPeers === true && String(id) === PEER_CAPABILITY),
        async execute(request) {
          tools++;
          if (native) return native.execute(request);
          return {
            status: "completed",
            effect: "completed",
            output: { evidence: "native inspection" },
          };
        },
      },
    },
    {
      tasks,
      ...(options.withWorkflows || options.withTaskLists
        ? { workflows: createWorkflowStore(f.database) }
        : {}),
      ...(options.withTaskLists
        ? {
            workQueues: {
              at: async (locator: string) =>
                locator === "workspace-state" ? workQueueStore(f.database) : null,
            },
          }
        : {}),
      joins: createAgentJoins({
        store: createAgentJoinStore(f.database),
        tasks: f.tasks,
        artifacts: f.artifacts,
      }),
      artifacts: f.artifacts,
      providerCatalog: catalog,
      ...(options.withPeers
        ? {
            peers: {
              async open(identity, task, initialState) {
                if (!task) throw new Error("child resource scope missing");
                const opened = await openPeerMailbox({
                  repository,
                  clock: f.clock,
                  resources: task,
                  identity,
                  initialState: initialState ?? "idle",
                  label: "child",
                  crypto: createPeerCrypto(),
                  transport: createPeerIpc({ directory: `${f.root}/ipc` }),
                  scope: {
                    workspace: canonicalDigest("w"),
                    project: canonicalDigest("p"),
                    user: canonicalDigest("u"),
                    environment: canonicalDigest("e"),
                    trust: canonicalDigest("t"),
                  },
                  authorizeArtifacts: async (message) => message.artifacts.length === 0,
                  redact: (text) => text,
                });
                if (!opened.ok) throw new Error(opened.error.code);
                peers.push(opened.value);
                peerIdentities.push({ identity, state: opened.value.endpoint() });
                return opened.value;
              },
            } satisfies NonNullable<DelegatedRuntimeOptions["peers"]>,
          }
        : {}),
      ...options,
    },
  );
  if (!composed.ok) throw new Error(composed.error.code);
  const taskListContext = {
    runtime: composed.value,
    store: workQueueStore(f.database),
    resources,
    clock: f.clock,
    database: f.database,
    artifacts: f.artifacts,
  };
  await options.withTaskLists?.before(taskListContext);
  const executor = createProductLiveTurnExecutor({
    runtime: composed.value,
    clock: f.clock,
    providerCatalog: catalog,
    artifacts: f.artifacts,
  });
  if (options.processing)
    expect(executor.processing.change({ mode: "fast" }).kind).toBe("processing-changed");
  try {
    const result = await executor.run({
      prompt: options.prompt ?? "Delegate an independent source inspection",
      turnId: turnId.from("agent-parent-turn"),
      signal: AbortSignal.timeout(3000),
    });
    if (afterParent) {
      afterParent();
      await tasks.drain();
    }
    await options.withTaskLists?.after(taskListContext);
    return {
      result,
      requests,
      tools,
      notices,
      peerIdentities,
      peerEndpoints: peers.map((peer) => peer.endpoint()),
    };
  } finally {
    tasks.interrupt();
    await tasks.drain();
    for (const peer of peers) await peer.close();
    await f.close();
  }
}

test("an admitted child receives its exact owning-session endpoint and closes it terminal", async () => {
  const observed = await run(
    (request, index) => {
      if (index === 0) return launch("general", "Inspect child endpoint", [PEER_CAPABILITY]);
      if (request.tools.some((tool) => tool.name === "delegate"))
        return { kind: "text", text: "Child finished." };
      if (!request.messages.some((message) => message.role === "tool"))
        return {
          kind: "tool",
          name: "peer",
          toolCallId: "child-endpoint",
          argumentFragments: [JSON.stringify({ operation: "endpoint" })],
        };
      return { kind: "text", text: generalResult };
    },
    { withPeers: true },
  );
  expect(observed.peerIdentities).toHaveLength(1);
  expect(observed.peerIdentities[0]).toMatchObject({
    identity: { sessionId: "agent-test-parent", generation: 1 },
    state: { ok: true, value: { endpoint: { state: "busy" } } },
  });
  expect(observed.peerEndpoints[0]).toMatchObject({
    ok: true,
    value: { endpoint: { state: "terminal" } },
  });
  expect(observed.tools).toBe(0);
  const toolMessages = observed.requests.flatMap((request) =>
    request.messages.filter((message) => message.role === "tool"),
  );
  expect(JSON.stringify(toolMessages)).toContain("agent-test-parent");
});

test("a background child completes another provider turn after its parent has closed", async () => {
  let release!: () => void;
  let preferences = {
    ...EMPTY_MODEL_PREFERENCES,
    processing: { mode: "standard" as "standard" | "fast" },
  };
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { result, requests, notices } = await run(
    (request, index) => {
      if (index === 0) {
        const command = launch("explorer", "Inspect in the background", [inspect]);
        if (command.kind !== "tool") throw new Error("expected launch");
        const input = JSON.parse(command.argumentFragments.join(""));
        input.execution.attachment = "background";
        return { ...command, argumentFragments: [JSON.stringify(input)] };
      }
      if (request.tools.some((tool) => tool.name === "delegate"))
        return { kind: "text", text: "Parent finished while the child is running." };
      if (!request.messages.some((message) => message.role === "tool"))
        return {
          kind: "tool",
          toolCallId: "background-inspect",
          name: "inspect",
          argumentFragments: ["{}"],
        };
      return { kind: "text", text: explorerResult };
    },
    { processing: true, preferences: () => preferences },
    "observation",
    {
      name: "inspect",
      schema: z.strictObject({}),
      async execute() {
        await held;
        return { status: "completed", effect: "completed", output: { observed: true } };
      },
    },
    () => {
      preferences = { ...preferences, processing: { mode: "fast" } };
      release();
    },
    2,
  );
  expect(result.terminalOutcome.kind).toBe("completed");
  expect(requests).toHaveLength(4);
  expect(
    requests
      .filter((request) => !request.tools.some((tool) => tool.name === "delegate"))
      .every((request) => request.processing?.preference.mode === "standard"),
  ).toBe(true);
  expect(
    JSON.stringify(
      requests.filter((request) => request.tools.some((tool) => tool.name === "delegate"))[1]
        ?.messages,
    ),
  ).toContain("agent-running");
  expect(JSON.stringify(notices)).toContain("agent-completed");
});

test("nested children complete with one runnable slot and return immediate-parent lineage", async () => {
  const { result, requests, tools } = await run((_request, index) => {
    switch (index) {
      case 0:
        return launch("general", "Delegate a narrower independent inspection", [delegate, inspect]);
      case 1:
        return launch("explorer", "Inspect the source", [inspect]);
      case 2:
        return {
          kind: "tool",
          toolCallId: "native-inspect",
          name: "inspect",
          argumentFragments: ["{}"],
        };
      case 3:
        return { kind: "text", text: explorerResult };
      case 4:
        return { kind: "text", text: generalResult };
      default:
        return { kind: "text", text: "Parent has the nested result." };
    }
  });
  expect(result.terminalOutcome.kind, JSON.stringify(result)).toBe("completed");
  expect(requests).toHaveLength(6);
  expect(tools).toBe(1);
  expect(JSON.stringify(requests[4]?.messages)).toContain("agent-result");
  expect(JSON.stringify(requests[5]?.messages)).toContain("agent-result");
  expect(requests[2]?.tools.map((tool) => tool.name)).toEqual(["inspect"]);
});

function childResult(request: ModelRequest): SealedAgentResult {
  function find(value: unknown, depth = 0): SealedAgentResult | null {
    const parsed = sealedAgentResultSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    if (depth > 8) return null;
    if (typeof value === "string") {
      try {
        return find(JSON.parse(value), depth + 1);
      } catch {
        return null;
      }
    }
    if (typeof value !== "object" || value === null) return null;
    for (const item of Object.values(value)) {
      const result = find(item, depth + 1);
      if (result) return result;
    }
    return null;
  }
  for (const message of [...request.messages].reverse()) {
    if (message.role !== "tool") continue;
    const result = find(message.parts);
    if (result) return result;
  }
  throw new Error("provider continuation lacks a sealed immediate-child result");
}
function joinTool(id: string, input: Record<string, unknown>): DeterministicProviderScript {
  return {
    kind: "tool",
    name: "delegate",
    toolCallId: id,
    argumentFragments: [JSON.stringify(input)],
  };
}

test("three nested child levels integrate through delegate before any parent completes", async () => {
  const receipts: SealedAgentResult[] = [];
  const { result, requests } = await run((request, index) => {
    if (index === 0 || index === 1)
      return launch("general", `Nested level ${index}`, [delegate], ["observation"], true);
    if (index === 2) return launch("explorer", "Final leaf", [], ["observation"], true);
    if (index === 3) return { kind: "text", text: explorerResult };
    if ([4, 7, 10].includes(index)) {
      const child = childResult(request);
      receipts.push(child);
      expect(child.outcome).toBe("completed");
      return joinTool(`join-${index}`, {
        operation: "join",
        join: {
          id: "children",
          generation: 1,
          children: [child.handle],
          policy: { mode: "all", quorum: null, partialOnFailure: false, cancelRemaining: false },
        },
      });
    }
    if ([5, 8, 11].includes(index))
      return joinTool(`integrate-${index}`, {
        operation: "join-integrate",
        joinId: "children",
        joinGeneration: 1,
        integration: "accepted",
      });
    return {
      kind: "text",
      text: index === 12 ? "Root integrated all descendants." : generalResult,
    };
  });
  expect(result.terminalOutcome.kind).toBe("completed");
  expect(receipts).toHaveLength(3);
  expect(receipts[0]?.parent.taskId).toBe(receipts[1]?.handle.taskId);
  expect(receipts[1]?.parent.taskId).toBe(receipts[2]?.handle.taskId);
  expect(requests).toHaveLength(13);
  expect(JSON.stringify(requests[12]?.messages)).toContain("join:sha256:");
  expect(receipts.slice(1).every((receipt) => (receipt.joins?.length ?? 0) === 1)).toBe(true);
});

test("a provider final response cannot bypass mandatory integration", async () => {
  const { result } = await run((_request, index) =>
    index === 0
      ? launch("explorer", "Required inspection", [], ["observation"], true)
      : { kind: "text", text: index === 1 ? explorerResult : "Claimed complete without joining." },
  );
  expect(result.kind).toBe("failed");
  expect(result.terminalOutcome.kind).toBe("failed");
  expect(
    result.events.filter((event) => event.kind === "turn.completed").at(-1)?.payload,
  ).toMatchObject({ outcome: { kind: "failed" } });
});

test("an unknown definition remains unstarted and does not substitute General", async () => {
  const { result, requests, tools } = await run((_request, index) =>
    index === 0
      ? launch("missing", "Inspect", [])
      : { kind: "text", text: "Definition unavailable." },
  );
  expect(result.terminalOutcome.kind).toBe("completed");
  expect(requests).toHaveLength(2);
  expect(tools).toBe(0);
  expect(JSON.stringify(requests[1]?.messages)).toContain("agent-definition-not-found");
});

test("a denied native capability cannot become available through child composition", async () => {
  const { requests, tools } = await run(
    (_request, index) =>
      index === 0
        ? launch("explorer", "Inspect denied source", [inspect])
        : { kind: "text", text: "The required capability is unavailable." },
    { nativeDenied: true },
  );
  expect(requests).toHaveLength(2);
  expect(tools).toBe(0);
  expect(JSON.stringify(requests[1]?.messages)).toContain("agent-capability-denied");
});

test.each(["concrete", "named"])(
  "%s Small preset captures an independent account and model without consulting Fast",
  async (selectionKind) => {
    const childRequests: ModelRequest[] = [];
    let changePreferences = () => {};
    const child = createDeterministicProviderAdapter({
      profileId: "child-account",
      supportedModels: ["child-small"],
      onRequest: (request) => {
        childRequests.push(request);
        changePreferences();
      },
      script: (_request, index) =>
        index === 0
          ? {
              kind: "tool",
              toolCallId: "child-inspect",
              name: "inspect",
              argumentFragments: ["{}"],
            }
          : { kind: "text", text: explorerResult },
    });
    const route = roleRouteBaseSchema.parse({
      providerId: String(child.identity.providerId),
      providerProfileId: "child-account",
      modelId: "child-small",
    });
    const definition = namedRouteDefinitionSchema.parse({
      id: "child-route",
      revision: 1,
      primary: {
        connectionId: "child-account",
        providerId: String(child.identity.providerId),
        modelId: "child-small",
      },
    });
    const fact = routeFacts()[0];
    const facts = [
      {
        ...fact,
        target: definition.primary,
        capability:
          catalogFromAdapterModels(child.supportedModels, {
            generation: 0,
            fetchedAt: instant(0),
            capabilities: child.modelCapabilities,
          }).models[0] ?? null,
      },
    ];
    let namedPreferences = bindNamedModelPreferences(
      {
        ...EMPTY_MODEL_PREFERENCES,
        roles: {
          subagents: {
            presets: {
              small: { kind: "route", routeId: definition.id, reasoning: "provider-default" },
            },
          },
        },
      },
      [definition],
      facts,
      0,
    );
    changePreferences = () => {
      namedPreferences = bindNamedModelPreferences(
        {
          ...EMPTY_MODEL_PREFERENCES,
          roles: {
            subagents: {
              presets: {
                small: { kind: "route", routeId: definition.id, reasoning: "provider-default" },
              },
            },
          },
        },
        [{ ...definition, revision: 2 }],
        facts,
        1,
      );
    };
    const { result, requests, tools } = await run(
      (_request, index) =>
        index === 0
          ? launch("explorer", "Inspect source", [inspect])
          : { kind: "text", text: "Parent received the result." },
      {
        preferences: () => ({
          ...EMPTY_MODEL_PREFERENCES,
          roles: {
            subagents: {
              presets: {
                small:
                  selectionKind === "named"
                    ? (namedPreferences.roles.subagents?.presets?.small ?? route)
                    : route,
              },
            },
            fast: {
              default: {
                ...route,
                modelId: roleRouteBaseSchema.parse({ ...route, modelId: "wrong-fast-model" })
                  .modelId,
              },
            },
          },
        }),
        resolveProvider: async (profileId) => {
          expect(profileId).toBe("child-account");
          return {
            adapter: child,
            catalog: catalogFromAdapterModels(child.supportedModels, {
              generation: 0,
              fetchedAt: instant(0),
              capabilities: child.modelCapabilities,
            }),
          };
        },
      },
    );
    expect(result.terminalOutcome.kind).toBe("completed");
    expect(requests).toHaveLength(2);
    expect(childRequests).toHaveLength(2);
    expect(childRequests.every((request) => request.modelId === "child-small")).toBe(true);
    if (selectionKind === "named") {
      expect(childRequests.map((request) => request.namedRoute?.routeId)).toEqual([
        "child-route",
        "child-route",
      ]);
      expect(childRequests.every((request) => request.namedRoute?.definitionRevision === 1)).toBe(
        true,
      );
    }
    expect(tools).toBe(1);
    expect(JSON.stringify(requests[1]?.messages)).toContain("subagents.preset:small");
  },
);

test.each(["explorer", "planner", "reviewer", "researcher"])(
  "%s cannot widen its effect ceiling through a selected native tool",
  async (definition) => {
    const { requests, tools } = await run(
      (_request, index) =>
        index === 0
          ? launch(definition, "Inspect source", [inspect])
          : index === 1
            ? {
                kind: "tool",
                toolCallId: "forbidden-effect",
                name: "inspect",
                argumentFragments: ["{}"],
              }
            : { kind: "text", text: "Parent has the refusal." },
      {},
      definition === "researcher" ? "external" : "mutation",
    );
    expect(tools).toBe(0);
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const parent = JSON.stringify(requests.at(-1)?.messages);
    expect(parent).toContain("agent-result");
    expect(parent).toContain("failed");
  },
);

test("two child edits use native patch preconditions and preserve the earlier sealed result after a stale edit", async () => {
  const root = localPath("/agent-workspace");
  const fileSystem = createInMemoryFileSystem({
    nodes: {
      "/agent-workspace": { kind: "directory" },
      "/agent-workspace/a.ts": { kind: "file", text: "original\n", revision: "original-revision" },
    },
  });
  const patcher = createWorkspacePatcher({ fileSystem });
  const outcomes: unknown[] = [];
  const resultText = JSON.stringify({
    changes: ["attempted native patch"],
    checks: [],
    failures: [],
    limitations: [],
  });
  const { result, requests, tools } = await run(
    (_request, index) => {
      if (index === 0 || index === 3)
        return launch(
          "implementer",
          index === 0 ? "Edit the first source" : "Apply a later edit",
          ["builtin:workspace/apply_patch@1"],
          ["observation", "mutation"],
        );
      if (index === 1 || index === 4)
        return {
          kind: "tool",
          toolCallId: `patch-${index}`,
          name: "apply_patch",
          argumentFragments: [JSON.stringify({ replacement: index === 1 ? "first" : "second" })],
        };
      return {
        kind: "text",
        text: index < 6 ? resultText : "Parent observed both child generations.",
      };
    },
    {},
    "mutation",
    {
      name: "apply_patch",
      schema: z.strictObject({ replacement: z.string() }),
      async execute(request) {
        const result = await patcher.apply(
          root,
          {
            targets: [
              {
                path: "a.ts",
                expectedRevision: "original-revision",
                hunks: [
                  {
                    oldStart: 1,
                    oldLines: ["original"],
                    newLines: [String(request.input.replacement)],
                  },
                ],
              },
            ],
          },
          request.signal,
        );
        outcomes.push(result);
        return { status: "completed", effect: "completed", output: { nativeResult: result } };
      },
    },
  );
  expect(
    tools,
    JSON.stringify({
      requests: requests.map((r) => ({
        tools: r.tools.map((t) => t.name),
        messages: r.messages.filter((m) => m.role === "tool"),
      })),
      result: result.terminalOutcome,
    }),
  ).toBe(2);
  expect(result.terminalOutcome.kind).toBe("completed");
  expect(outcomes[0]).toMatchObject({ ok: true });
  expect(JSON.stringify(outcomes[1])).toContain("revision-mismatch");
  const firstResult = requests[3]?.messages.filter((message) => message.role === "tool").at(-1);
  expect(JSON.stringify(firstResult)).toContain("agent-result");
  expect(JSON.stringify(requests[6]?.messages)).toContain(JSON.stringify(firstResult).slice(1, -1));
});

test("main session Fast never becomes a delegated role preference", async () => {
  const observed = await run(
    (request, index) => {
      if (index === 0) return launch("general", "Inspect independently", []);
      return {
        kind: "text",
        text: request.tools.some((tool) => tool.name === "delegate")
          ? "Parent finished"
          : generalResult,
      };
    },
    { processing: true },
  );
  const main = observed.requests.filter((request) =>
    request.tools.some((tool) => tool.name === "delegate"),
  );
  const children = observed.requests.filter(
    (request) => !request.tools.some((tool) => tool.name === "delegate"),
  );
  expect(main.length).toBeGreaterThan(0);
  expect(children.length).toBeGreaterThan(0);
  expect(main.every((request) => request.processing?.preference.mode === "fast")).toBe(true);
  expect(
    children.every((request) => request.processing?.preference.mode === "provider-default"),
  ).toBe(true);
  expect(
    new Set(observed.requests.map((request) => JSON.stringify(request.processing?.admission))).size,
  ).toBe(observed.requests.length);
});

test("a child resolves its declared subtree after a parent edit while the parent retains its admitted bytes", async () => {
  let rootText = "ROOT_ORIGINAL";
  const root = sourceFixture("AGENTS.md");
  const docs = sourceFixture("docs/AGENTS.md", { scope: "docs" });
  const excluded = sourceFixture("src/AGENTS.md", { scope: "src" });
  const snapshots: unknown[] = [];
  const owner = createInstructionSourceOwner({
    async scan() {
      return {
        configuration: "0",
        workspace: "workspace",
        sources: [
          { ...root, digest: bytesDigest(new TextEncoder().encode(rootText)) },
          docs,
          excluded,
        ],
        preferences: EMPTY_SOURCE_PREFERENCES,
      };
    },
    async read(source) {
      return new TextEncoder().encode(
        source.identity.path === "AGENTS.md" ? rootText : source.identity.path,
      );
    },
    async current() {
      return true;
    },
  });
  const registry = createAgentRegistry(
    starterAgentRegistrations().map((registration) => {
      const parsed = agentDefinitionSchema.parse(registration.definition);
      if (parsed.identity.localId !== "general") return registration;
      const { identity, ...descriptor } = parsed;
      const replacement = { ...descriptor, instructionDirectory: "docs" };
      return {
        ...registration,
        definition: {
          ...replacement,
          identity: { ...identity, descriptorDigest: canonicalDigest(replacement) },
        },
      };
    }),
  );
  const { result, requests } = await run(
    (_request, index) => {
      snapshots.push(owner.snapshot());
      if (index === 0) {
        rootText = "ROOT_EDITED";
        return launch("general", "Read docs instructions", []);
      }
      return { kind: "text", text: index === 1 ? generalResult : "Parent completed." };
    },
    {
      registry,
      instructions: { owner, scope: { root: "workspace", directory: "", kind: "main" } },
    },
  );
  expect(result.terminalOutcome.kind).toBe("completed");
  expect(requests).toHaveLength(3);
  const inputs = requests.map((request) => JSON.stringify(request.messages));
  expect(inputs[0]).toContain("ROOT_ORIGINAL");
  expect(inputs[1]).toContain("ROOT_EDITED");
  expect(inputs[1]).toContain("docs/AGENTS.md");
  expect(inputs[1]).not.toContain("src/AGENTS.md");
  expect(inputs[2]).toContain("ROOT_ORIGINAL");
  expect(inputs[2]).not.toContain("ROOT_EDITED");
  expect(result.instructions?.scope.kind).toBe("main");
  expect(snapshots[0]).not.toEqual(snapshots[1]);
});

test("workflow model steps retain named receipts when preferences change between nodes", async () => {
  const adapter = createDeterministicProviderAdapter({ script: { kind: "text", text: "{}" } });
  const model = adapter.supportedModels[0];
  if (!model) throw new Error("Missing fixture model");
  const definition = namedRouteDefinitionSchema.parse({
    id: "workflow-route",
    revision: 1,
    primary: {
      connectionId: adapter.identity.profileId,
      providerId: String(adapter.identity.providerId),
      modelId: String(model),
    },
  });
  const facts = [
    {
      ...routeFacts()[0],
      target: definition.primary,
      capability:
        catalogFromAdapterModels(adapter.supportedModels, {
          generation: 0,
          fetchedAt: instant(0),
          capabilities: adapter.modelCapabilities,
        }).models[0] ?? null,
    },
  ];
  const authored = {
    ...EMPTY_MODEL_PREFERENCES,
    roles: {
      workflows: {
        default: {
          kind: "route" as const,
          routeId: definition.id,
          reasoning: "provider-default" as const,
        },
      },
    },
  };
  let preferences = bindNamedModelPreferences(authored, [definition], facts, 0);
  const schema = { type: "object", properties: {}, additionalProperties: false };
  const workflow = {
    version: 1,
    id: "user/test:route",
    label: "Route capture",
    argumentsSchema: schema,
    nodes: [
      { key: "first", kind: "model", instruction: "Return an empty object", resultSchema: schema },
      {
        key: "second",
        kind: "model",
        instruction: "Return an empty object",
        resultSchema: schema,
        dependencies: ["first"],
      },
    ],
    outputs: { result: { from: "node", node: "second" } },
  };
  const observed = await run(
    (request, index) => {
      if (index === 0)
        return {
          kind: "tool",
          toolCallId: "workflow-route",
          name: "workflow",
          argumentFragments: [
            JSON.stringify({
              operation: "execute",
              handle: { id: "workflow-route", generation: "one" },
              definitionJson: JSON.stringify(workflow),
              argumentsJson: "{}",
            }),
          ],
        };
      if (request.tools.length === 0) {
        preferences = bindNamedModelPreferences(
          authored,
          [{ ...definition, revision: 2 }],
          facts,
          1,
        );
        return { kind: "text", text: "{}" };
      }
      return { kind: "text", text: "Workflow complete." };
    },
    {
      withWorkflows: true,
      prompt: "Use workflow to execute two model nodes",
      preferences: () => preferences,
    },
  );
  expect(observed.result.terminalOutcome.kind).toBe("completed");
  const nodes = observed.requests.filter((request) => request.tools.length === 0);
  expect(nodes).toHaveLength(2);
  expect(nodes.map((request) => request.namedRoute?.definitionRevision)).toEqual([1, 1]);
  expect(nodes.map((request) => request.namedRoute?.routeId)).toEqual([
    "workflow-route",
    "workflow-route",
  ]);
});

test("a root workflow runs an existing project task through the runtime port and waits for the user", async () => {
  const signal = new AbortController().signal;
  const scope = {
    kind: "project" as const,
    generation: "scope-1",
    configurationGeneration: 0,
    sessionId: null,
    workspaceId: "workspace-fixture",
    owner: PRODUCT_WORK_ACTOR,
    members: [],
    locator: "workspace-state",
  };
  let definition: unknown = null;
  let queue: WorkQueue | null | undefined = null;
  let source = { source: "list-source", sourceGeneration: "" };
  let mutation = 0;
  const provenance = () => ({ ...source, mutationId: `edit-${mutation++}`, reason: "test" });
  const userActions = (context: TaskListContext) =>
    createWorkQueueActions(context.store, {
      resources: context.resources.openTask("0"),
      now: () => Number(context.clock.now()),
      authority: createProductWorkQueueAuthority({
        role: "user",
        sessionId: "agent-test-parent",
        workspaceId: "workspace-fixture",
        persistentSession: true,
        agents: createAgentRegistry(starterAgentRegistrations()),
        artifacts: context.artifacts,
        workflows: createWorkflowStore(context.database),
      }),
    });
  const port = (context: TaskListContext) => {
    const found = (context.runtime as { readonly taskLists?: ProductTaskLists | null }).taskLists;
    if (!found) throw new Error("task-list port unavailable");
    return found;
  };
  const observed = await run(
    (request, index) => {
      if (request.tools.some((tool) => tool.name === "workflow"))
        return index === 0
          ? {
              kind: "tool",
              toolCallId: "task-list-workflow",
              name: "workflow",
              argumentFragments: [
                JSON.stringify({
                  operation: "execute",
                  handle: { id: "task-list-run", generation: "run-1" },
                  definitionJson: JSON.stringify(definition),
                  argumentsJson: "{}",
                }),
              ],
            }
          : { kind: "text", text: "The task waits for acceptance." };
      return { kind: "text", text: explorerResult };
    },
    {
      prompt: "Run the selected task list",
      withTaskLists: {
        async before(context) {
          const bytes = new TextEncoder().encode("task list source");
          const ingested = await context.artifacts.ingest({
            artifactId: artifactId.from("list-source"),
            mediaType: "text/plain",
            encoding: "identity",
            sensitivity: "user-content",
            origin: "user-supplied",
            invocationId: null,
            declaredByteLength: bytes.byteLength,
            content: (async function* () {
              yield bytes;
            })(),
          });
          if (!ingested.ok) throw new Error(ingested.error.code);
          source = { ...source, sourceGeneration: String(ingested.value.record.digest) };
          const user = userActions(context);
          const send = async (value: object) =>
            taskValue(await user.execute(JSON.stringify({ version: 1, ...value }), signal));
          queue = (
            await send({
              action: "create",
              queueId: "queue-1",
              scope,
              objective: "Tasks",
              ...provenance(),
            })
          ).queue;
          queue = (
            await send({
              action: "mutate",
              queueId: "queue-1",
              scopeGeneration: scope.generation,
              expectedRevision: queue?.revision,
              operations: [
                {
                  kind: "add",
                  itemId: "a",
                  fields: {
                    subject: "Inspect the owner",
                    objective: "Report where the owner lives",
                    description: "",
                    activeForm: null,
                    agentType: "builtin/falryn/agents:explorer",
                    metadata: {},
                    criteria: ["The owner is located"],
                  },
                },
              ],
              ...provenance(),
            })
          ).queue;
          if (!queue) throw new Error("missing queue");
          definition = await port(context).prepare({
            queue,
            selected: ["a"],
            ...source,
            id: "user/tasks:runtime",
            signal,
          });
        },
        async after(context) {
          const actions = port(context).actions;
          const first = queue?.revision ?? 0;
          const show = async () => {
            for (let revision = first; revision < first + 8; revision++) {
              const shown = await actions.execute(
                JSON.stringify({
                  version: 1,
                  action: "show",
                  queueId: "queue-1",
                  scopeGeneration: scope.generation,
                  expectedRevision: revision,
                  itemId: "a",
                }),
                signal,
              );
              const item = shown.ok ? shown.value.items?.[0] : undefined;
              if (item) return { item, revision };
            }
            throw new Error("item unavailable");
          };
          const submitted = await show();
          expect(submitted.item).toMatchObject({
            disposition: "completion-claimed",
            acceptance: null,
          });
          expect(submitted.item.claim?.holder).toMatchObject({
            actor: PRODUCT_WORK_ACTOR,
            generation: "run-1",
          });
          const record = taskValue(
            createWorkflowStore(context.database).find("workspace-fixture", "run-1"),
          );
          expect(record?.state).toBe("waiting");
          expect(record?.nodes.find((node) => node.state === "waiting")?.reason).toBe(
            "workflow-task-list-acceptance-required",
          );
          const validate = {
            version: 1,
            action: "mutate",
            queueId: "queue-1",
            scopeGeneration: scope.generation,
            expectedRevision: submitted.revision,
            operations: [
              {
                kind: "validate",
                itemId: "a",
                itemRevision: submitted.item.revision,
                criteriaRevision: submitted.item.criteriaRevision,
                claimGeneration: submitted.item.claimGeneration,
                evidence: submitted.item.evidence,
                authority: "user",
                verdict: "accept",
                reason: "Owner located",
              },
            ],
          };
          expect(
            await actions.execute(JSON.stringify({ ...validate, ...provenance() }), signal),
          ).toMatchObject({ ok: false, error: { code: "denied" } });
          taskValue(
            await userActions(context).execute(
              JSON.stringify({ ...validate, ...provenance() }),
              signal,
            ),
          );
          expect((await show()).item).toMatchObject({
            disposition: "completed",
            acceptance: { actor: PRODUCT_WORK_ACTOR, authority: "user" },
          });
        },
      },
    },
  );
  expect(observed.result.terminalOutcome.kind).toBe("completed");
  const children = observed.requests.filter(
    (request) => !request.tools.some((tool) => tool.name === "workflow"),
  );
  expect(children).toHaveLength(1);
  expect(JSON.stringify(children[0]?.messages)).toContain("Report where the owner lives");
});
