import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import { createAgentJoinStore } from "../../data/orchestration/agent-join-store.ts";
import { createCapabilityRegistry } from "../../domain/capabilities/index.ts";
import {
  configurationGeneration,
  instant,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import type { ToolInvocationOutcome } from "../../domain/tools/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
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
import { capabilityEntryFromTool } from "../capabilities/product-capability-registry.ts";
import { createAgentJoins } from "../orchestration/agent-joins.ts";
import {
  type SealedAgentResult,
  sealedAgentResultSchema,
} from "../orchestration/delegation-contract.ts";
import { createProcessTaskFixture, taskValue } from "../orchestration/process-task.fixtures.ts";
import { createProcessTaskSupervisor } from "../orchestration/process-task-supervisor.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { createWorkspacePatcher } from "../workspace/workspace-patch.ts";
import {
  composeDelegatedAgentRuntime,
  type DelegatedRuntimeOptions,
} from "./delegated-agent-runtime.ts";
import { createProductLiveTurnExecutor } from "./product-live-turn.ts";
import type { ToolRunnerRequest } from "./tool-call-loop.ts";

afterEach(removeTemporaryRoots);
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
  > & { nativeDenied?: boolean } = {},
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
  const adapter = createDeterministicProviderAdapter({
    script,
    onRequest: (request) => requests.push(request),
  });
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
  const registry = taskValue(createToolRegistry(configurationGeneration.from(0), [entry]));
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
  const composed = composeDelegatedAgentRuntime(
    {
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
        hasBinding: (id) => id === entry.manifest.capabilityId,
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
      joins: createAgentJoins({
        store: createAgentJoinStore(f.database),
        tasks: f.tasks,
        artifacts: f.artifacts,
      }),
      artifacts: f.artifacts,
      providerCatalog: catalog,
      ...options,
    },
  );
  if (!composed.ok) throw new Error(composed.error.code);
  const executor = createProductLiveTurnExecutor({
    runtime: composed.value,
    clock: f.clock,
    providerCatalog: catalog,
    artifacts: f.artifacts,
  });
  try {
    const result = await executor.run({
      prompt: "Delegate an independent source inspection",
      turnId: turnId.from("agent-parent-turn"),
      signal: AbortSignal.timeout(3000),
    });
    if (afterParent) {
      afterParent();
      await tasks.drain();
    }
    return { result, requests, tools, notices };
  } finally {
    tasks.interrupt();
    await tasks.drain();
    await f.close();
  }
}

test("a background child completes another provider turn after its parent has closed", async () => {
  let release!: () => void;
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
    {},
    "observation",
    {
      name: "inspect",
      schema: z.strictObject({}),
      async execute() {
        await held;
        return { status: "completed", effect: "completed", output: { observed: true } };
      },
    },
    () => release(),
    2,
  );
  expect(result.terminalOutcome.kind).toBe("completed");
  expect(requests).toHaveLength(4);
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

test("Small preset resolves an independent account and model without consulting Fast", async () => {
  const childRequests: ModelRequest[] = [];
  const child = createDeterministicProviderAdapter({
    profileId: "child-account",
    supportedModels: ["child-small"],
    onRequest: (request) => childRequests.push(request),
    script: (_request, index) =>
      index === 0
        ? { kind: "tool", toolCallId: "child-inspect", name: "inspect", argumentFragments: ["{}"] }
        : { kind: "text", text: explorerResult },
  });
  const route = roleRouteBaseSchema.parse({
    providerId: String(child.identity.providerId),
    providerProfileId: "child-account",
    modelId: "child-small",
  });
  const { result, requests, tools } = await run(
    (_request, index) =>
      index === 0
        ? launch("explorer", "Inspect source", [inspect])
        : { kind: "text", text: "Parent received the result." },
    {
      preferences: () => ({
        ...EMPTY_MODEL_PREFERENCES,
        roles: {
          subagents: { presets: { small: route } },
          fast: {
            default: {
              ...route,
              modelId: roleRouteBaseSchema.parse({ ...route, modelId: "wrong-fast-model" }).modelId,
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
  expect(tools).toBe(1);
  expect(JSON.stringify(requests[1]?.messages)).toContain("subagents.preset:small");
});

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
