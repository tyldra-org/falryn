import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { removeTemporaryRoots } from "../../data/fixtures.ts";
import {
  configurationGeneration,
  instant,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
} from "../../domain/tools/index.ts";
import {
  catalogFromAdapterModels,
  createDeterministicProviderAdapter,
  type ModelRequest,
} from "../../providers/index.ts";
import { createProcessTaskFixture, taskValue } from "../orchestration/process-task.fixtures.ts";
import { createProcessTaskSupervisor } from "../orchestration/process-task-supervisor.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { mergeProductToolBundles } from "../tools/product-tools-merge.ts";
import { composeDelegatedAgentRuntime } from "./delegated-agent-runtime.ts";
import { composeProductAgentRuntime } from "./product-agent-runtime.ts";
import { createProductLiveTurnExecutor } from "./product-live-turn.ts";

afterEach(removeTemporaryRoots);
for (const delegated of [false, true])
  test(`next-turn native publication preserves session ownership (delegation=${delegated})`, async () => {
    const fixture = await createProcessTaskFixture(false);
    const generation = configurationGeneration.from(0);
    let name = "read_native_one";
    let refuse = false;
    let calls = 0;
    const requests: ModelRequest[] = [];
    const provider = createDeterministicProviderAdapter({
      onRequest: (request) => requests.push(request),
      script: (_request, index) =>
        index % 2 === 0
          ? { kind: "tool", name, toolCallId: `native-${index}`, argumentFragments: ["{}"] }
          : { kind: "text", text: "Observed." },
    });
    const catalog = catalogFromAdapterModels(provider.supportedModels, {
      generation: 0,
      fetchedAt: instant(0),
      capabilities: provider.modelCapabilities,
    });
    const tasks = createProcessTaskSupervisor({
      store: fixture.tasks,
      artifacts: fixture.artifacts,
      clock: fixture.clock,
      runId: "native-refresh",
      process: fixture.snapshot.supervisor.process,
      notify: async () => true,
    });
    const empty = mergeProductToolBundles(generation, []);
    const ports = {
      historyArtifacts: fixture.artifacts,
      resources: createProductResources(fixture.clock),
      eventStore: fixture.events,
      clock: fixture.clock,
      streamId: streamId.from("native-refresh"),
      correlation: {
        sessionId: sessionId.from("native-refresh"),
        workspaceId: workspaceId.from("workspace-fixture"),
        traceId: traceId.from("native-refresh"),
        configurationGeneration: generation,
      },
      providerAdapter: provider,
      toolRegistry: empty.registry,
      toolCatalog: empty.catalog,
      toolRunner: empty.runner,
      capabilityRegistry: empty.capabilityRegistry,
    };
    let runtime = taskValue(
      delegated
        ? composeDelegatedAgentRuntime(ports, {
            tasks,
            artifacts: fixture.artifacts,
            providerCatalog: catalog,
          })
        : composeProductAgentRuntime(ports),
    );
    const original = runtime;
    const executor = createProductLiveTurnExecutor({
      runtime,
      clock: fixture.clock,
      artifacts: fixture.artifacts,
      providerCatalog: catalog,
      async refreshRuntime() {
        if (refuse) throw new Error("invalid candidate");
        const entry = taskValue(
          createToolRegistryEntry(
            {
              namespace: "fixture",
              name,
              version: 1,
              source: "builtin",
              title: "Read native fact",
              description: "Read the native fixture",
              effect: "observation",
              capabilityKind: "filesystem",
              platforms: [],
              limits: defaultToolLimits(),
              concurrency: defaultConcurrencyContract(),
              resultProjection: defaultProjectionContract(),
            },
            {
              inputSchema: z.strictObject({}),
              outputSchema: z.strictObject({ answer: z.number() }),
            },
          ),
        );
        const registry = taskValue(createToolRegistry(generation, [entry]));
        const tools = mergeProductToolBundles(generation, [
          {
            registry,
            catalog: registry.catalog,
            toolNames: [name],
            runner: {
              hasBinding: (id) => id === entry.manifest.capabilityId,
              execute: async () => {
                calls++;
                return { status: "completed", effect: "completed", output: { answer: calls } };
              },
            },
          },
        ]);
        const next = taskValue(runtime.recomposeTools(tools));
        expect(next.attachments.turnProducer).toBe(original.attachments.turnProducer);
        expect(next.turnCoordinator).toBe(original.turnCoordinator);
        runtime = next;
        return next;
      },
    });
    try {
      const firstResult = await executor.run({
        prompt: "Read the native fixture",
        turnId: turnId.from("native-one"),
      });
      expect(firstResult.kind).toBe("completed");
      expect(calls).toBe(1);
      const first = runtime;
      name = "read_native_two";
      expect(
        (
          await executor.run({
            prompt: "Read the native fixture",
            turnId: turnId.from("native-two"),
          })
        ).kind,
      ).toBe("completed");
      expect(calls).toBe(2);
      expect(first.toolRegistry?.resolveByName(name)).toBeNull();
      expect(requests[2]?.tools.map((tool) => tool.name)).toContain(name);
      expect(requests[2]?.tools.map((tool) => tool.name)).not.toContain("read_native_one");
      const prior = runtime;
      refuse = true;
      expect(
        (await executor.run({ prompt: "Read native fact", turnId: turnId.from("native-three") }))
          .kind,
      ).toBe("unavailable");
      expect(runtime).toBe(prior);
      expect(requests).toHaveLength(4);
    } finally {
      await tasks.drain();
      await fixture.close();
    }
  });
