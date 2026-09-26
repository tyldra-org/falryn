/** Scheduled Todo selections through the live product host (#1112). */
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import {
  createAgentRegistry,
  starterAgentRegistrations,
} from "../../application/orchestration/agent-registry.ts";
import { createProductResources } from "../../application/orchestration/product-resources.ts";
import {
  createProductWorkQueueAuthority,
  PRODUCT_WORK_ACTOR,
} from "../../application/orchestration/work-queue-authority.ts";
import { createWorkQueueActions } from "../../application/orchestration/work-queues.ts";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { artifactId } from "../../domain/artifacts/index.ts";
import { configurationGeneration, createStaticEnvironment } from "../../domain/foundation/index.ts";
import type { WorkItem } from "../../domain/orchestration/work-queue.ts";
import { localPath } from "../../domain/workspace/index.ts";
import {
  EMPTY_MODEL_PREFERENCES,
  roleRouteBaseSchema,
} from "../../providers/configuration/policy-schema.ts";
import {
  catalogFromAdapterModels,
  createDeterministicProviderAdapter,
} from "../../providers/index.ts";
import type { GlobalOptions } from "../options.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import {
  loadProductConfiguration,
  productConfigurationLoadRequest,
} from "./product-configuration.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";
import { createServiceProvider } from "./services.ts";

afterEach(removeTemporaryRoots);
const WORKSPACE = "root-1";
const EXPLORER = "builtin/falryn/agents:explorer";
const explorerResult = JSON.stringify({
  locations: [],
  flow: [],
  findings: ["done"],
  unknowns: [],
});

test.skipIf(process.platform === "win32")(
  "a scheduled Todo selection freezes each occurrence, runs only eligible tasks and settles for acceptance",
  async () => {
    const root = await temporaryRoot("schedule-task-list-");
    const globals: GlobalOptions = {
      format: "json",
      color: "never",
      quiet: false,
      verbose: false,
      nonInteractive: false,
      workspace: root,
      addDirs: [],
      profile: null,
      timeoutMs: null,
      help: false,
      version: false,
    };
    const env = createStaticEnvironment({
      PATH: process.env.PATH ?? "",
      HOME: root,
      FALRYN_CONFIG_DIR: join(root, "config"),
      FALRYN_STATE_DIR: join(root, "state"),
      FALRYN_ARTIFACT_DIR: join(root, "artifacts"),
      FALRYN_TEMP_DIR: join(root, "temp"),
      FALRYN_CACHE_DIR: join(root, "cache"),
      FALRYN_LOG_DIR: join(root, "logs"),
      FALRYN_EXPORT_DIR: join(root, "exports"),
    });
    const graph = createServiceProvider(globals, {
      home: localPath(root),
      currentDirectory: localPath(root),
      environment: env,
    })();
    const loaded = await loadProductConfiguration(graph, productConfigurationLoadRequest(globals));
    const product = await openProductArtifactSession(graph);
    if (!product) throw new Error("storage");
    const objectives: string[] = [];
    const provider = createDeterministicProviderAdapter({
      onRequest(request) {
        objectives.push(JSON.stringify(request.messages).match(/Objective: ([^\\"]+)/u)?.[1] ?? "");
      },
      script: () => ({ kind: "text", text: explorerResult }),
    });
    const route = roleRouteBaseSchema.parse({
      providerId: provider.identity.providerId,
      providerProfileId: provider.identity.profileId,
      modelId: provider.supportedModels[0],
      reasoning: "provider-default",
    });
    const catalog = catalogFromAdapterModels(provider.supportedModels, {
      generation: Number(loaded.generation),
      fetchedAt: graph.clock.now(),
      capabilities: provider.modelCapabilities,
    });
    const compose = () =>
      composeProductShellAttachments({
        modelPreferences: () => ({
          ...EMPTY_MODEL_PREFERENCES,
          roles: { ...EMPTY_MODEL_PREFERENCES.roles, default: route },
        }),
        resolveAgentProvider: async () => ({ adapter: provider, catalog }),
        eventStore: product.eventStore,
        clock: graph.clock,
        fileSystem: graph.fileSystem,
        workspaceSet: graph.workspaceSet,
        configurationGeneration: configurationGeneration.from(Number(loaded.generation)),
        configurationValues: () => loaded.values,
        sandboxConfiguration: () => graph.loader.current(),
        artifacts: product.artifacts,
        tasks: product.tasks,
        workflows: product.workflows,
        workQueues: product.workQueues,
        joins: product.joins,
        schedules: { ...product.schedules, autostart: false },
        taskNotices: product.taskNotices,
      });
    let attached = await compose();
    const signal = new AbortController().signal;

    // The user's own queue owner, standing in for #949's task command.
    const store = await product.workQueues.at("workspace-state");
    if (!store) throw new Error("queue location");
    const bytes = new TextEncoder().encode("todo source");
    const ingested = await product.artifacts.ingest({
      artifactId: artifactId.from("todo-source"),
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
    if (!ingested.ok) throw new Error("source");
    const userIn = (sessionId: string) =>
      createWorkQueueActions(store, {
        resources: createProductResources(graph.clock).openTask("0"),
        authority: createProductWorkQueueAuthority({
          role: "user",
          sessionId,
          workspaceId: WORKSPACE,
          persistentSession: true,
          agents: createAgentRegistry(starterAgentRegistrations()),
          artifacts: product.artifacts,
          workflows: product.workflows,
        }),
      });
    const user = userIn("user-session");
    let mutation = 0;
    let revision = 0;
    const scope = (kind: "project" | "session", sessionId: string | null) => ({
      kind,
      generation: "scope-1",
      configurationGeneration: 0,
      sessionId,
      workspaceId: WORKSPACE,
      owner: PRODUCT_WORK_ACTOR,
      members: [],
      locator: "workspace-state",
    });
    const send = async (queueId: string, request: object, actions = user) => {
      const result = await actions.execute(
        JSON.stringify({
          version: 2,
          queueId,
          ...request,
          source: "todo-source",
          sourceGeneration: String(ingested.value.record.digest),
          mutationId: `seed-${mutation++}`,
          reason: "seed",
        }),
        signal,
      );
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      revision = result.value.queue?.revision ?? revision;
      return result.value;
    };
    const mutate = (operations: object[]) =>
      send("todo", {
        action: "mutate",
        scopeGeneration: "scope-1",
        expectedRevision: revision,
        operations,
      });
    const task = (itemId: string, agentType: string | null = EXPLORER) => ({
      kind: "add",
      itemId,
      fields: {
        subject: `Task ${itemId}`,
        objective: `Inspect ${itemId}`,
        description: "",
        activeForm: null,
        agentType,
        metadata: {},
        criteria: [`${itemId} is inspected`],
      },
    });
    const place = (nodeId: string, parentId: string) => ({
      kind: "place",
      nodeId,
      parentId,
      position: { at: "end" },
    });
    await send("todo", { action: "create", scope: scope("project", null), objective: "Todo" });
    await mutate([
      {
        kind: "group",
        groupId: "outer",
        subject: "Outer",
        parentId: null,
        position: { at: "end" },
      },
      {
        kind: "group",
        groupId: "inner",
        subject: "Inner",
        parentId: "outer",
        position: { at: "end" },
      },
      task("a"),
      task("b"),
      task("c"),
      task("e"),
      task("f", null),
      place("a", "outer"),
      place("b", "inner"),
      place("c", "inner"),
      place("e", "inner"),
      place("f", "inner"),
      { kind: "link", itemId: "e", dependency: "a" },
      { kind: "cancel", itemId: "c" },
    ]);
    const item = async (itemId: string): Promise<WorkItem> => {
      const shown = await user.execute(
        JSON.stringify({
          version: 1,
          action: "show",
          queueId: "todo",
          scopeGeneration: "scope-1",
          expectedRevision: revision,
          itemId,
        }),
        signal,
      );
      if (!shown.ok && shown.error.currentRevision !== undefined) {
        revision = shown.error.currentRevision;
        return item(itemId);
      }
      const found = shown.ok ? shown.value.items?.[0] : undefined;
      if (!found) throw new Error(`missing ${itemId}`);
      return found;
    };
    const accept = async (itemId: string) => {
      const found = await item(itemId);
      await mutate([
        {
          kind: "validate",
          itemId,
          itemRevision: found.revision,
          claimGeneration: found.claimGeneration,
          criteriaRevision: found.criteriaRevision,
          evidence: found.evidence,
          authority: "user",
          verdict: "accept",
          reason: "Verified",
        },
      ]);
    };

    try {
      if (!attached?.submission.schedule || !attached.schedules) throw new Error("controls");
      const invoke = (input: unknown) => attached?.submission.schedule?.(input, signal);
      const definition = (target: object) => ({
        version: 1,
        timing: { trigger: { kind: "interval", everyMs: 86_400_000 } },
        target: { kind: "task-list", scopeGeneration: "scope-1", ...target },
      });
      // Overlapping nested groups and an explicit task deduplicate to one manifest.
      const selector = definition({ queueId: "todo", groups: ["outer", "inner"], tasks: ["a"] });
      const preview = await invoke({ operation: "preview", definition: selector });
      expect(preview).toMatchObject({
        ok: true,
        value: {
          valid: true,
          executionStarted: false,
          target: {
            kind: "task-list-selection",
            counts: { admissible: 4, cancelled: 1 },
            complete: true,
          },
        },
      });
      expect(objectives).toHaveLength(0);

      // Session-bound, stale-scope and missing-group selectors are refused before enable.
      await send(
        "mine",
        { action: "create", scope: scope("session", "another"), objective: "Mine" },
        userIn("another"),
      );
      for (const [target, blocker] of [
        [{ queueId: "mine", tasks: ["a"] }, "task-list-denied"],
        [{ queueId: "todo", tasks: ["a"], scopeGeneration: "scope-0" }, "task-list-denied"],
        [{ queueId: "todo", groups: ["missing"] }, "task-list-unavailable"],
        [{ queueId: "absent", tasks: ["a"] }, "task-list-unavailable"],
      ] as const)
        expect(
          await invoke({ operation: "preview", definition: definition(target) }),
        ).toMatchObject({ ok: true, value: { valid: false, blocker, target: null } });

      const settle = async (id: string) => {
        await attached?.schedules?.wake();
        for (let i = 0; i < 300 && attached?.schedules?.inspect().active; i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        await attached?.schedules?.wake();
        const latest = product.schedules.store.latest(WORKSPACE, id);
        if (!latest.ok || !latest.value) throw new Error("missing attempt");
        return latest.value;
      };
      const manifest = async (attempt: { terminal: { result: unknown } | null }) => {
        const result = attempt.terminal?.result as { artifactId: string; byteLength: number };
        const read = await product.artifacts.readRange(
          artifactId.from(result.artifactId),
          0,
          result.byteLength,
        );
        if (!read.ok) throw new Error("manifest");
        return new TextDecoder().decode(read.value.bytes);
      };
      expect(await invoke({ operation: "create", id: "todo", definition: selector })).toMatchObject(
        {
          ok: true,
        },
      );
      expect(await invoke({ operation: "enable", id: "todo", expectedRevision: 1 })).toMatchObject({
        ok: true,
      });
      let record = product.schedules.store.get(WORKSPACE, "todo");
      if (!record.ok) throw new Error("record");
      expect(
        await invoke({
          operation: "trigger-now",
          id: "todo",
          expectedRevision: record.value.revision,
          requestId: "first",
        }),
      ).toMatchObject({ ok: true });
      const first = await settle("todo");
      expect(first.terminal).toMatchObject({
        status: "succeeded",
        reason: "task-list-acceptance-required",
        result: { artifactId: `schedule-task-list-${first.id}` },
      });
      expect(first.workflow).toEqual({ id: first.id, generation: first.id });
      expect(objectives.sort()).toEqual(["Inspect a", "Inspect b"]);
      const frozen = await manifest(first);
      expect(JSON.parse(frozen).manifest.tasks).toEqual(
        expect.arrayContaining([
          { id: "a", status: "admissible" },
          { id: "c", status: "cancelled" },
          { id: "e", status: "admissible" },
          { id: "f", status: "admissible" },
        ]),
      );
      expect(await item("b")).toMatchObject({
        disposition: "completion-claimed",
        acceptance: null,
      });
      expect(product.workflows.get(first.workflow ?? { id: "", generation: "" })).toMatchObject({
        ok: true,
        value: { state: "waiting" },
      });

      // A lost executor is reconciled from the persisted run and never relaunched.
      const before = objectives.length;
      const dead = product.schedules.store.changeAttempt(
        WORKSPACE,
        first.id,
        first.revision,
        (prior) => ({
          ok: true,
          value: {
            ...prior,
            revision: prior.revision + 1,
            process: { ...prior.process, pid: 2 ** 22 - 3 },
            terminal: null,
          },
        }),
      );
      expect(dead.ok).toBe(true);
      await attached.close();
      attached = await compose();
      const recovered = await settle("todo");
      expect(recovered.id).toBe(first.id);
      expect(recovered.terminal).toMatchObject({
        status: "succeeded",
        reason: "task-list-acceptance-required",
        result: { artifactId: `schedule-task-list-${first.id}` },
      });
      expect(objectives.length).toBe(before);

      // Acceptance and a membership edit change only later occurrences.
      await accept("a");
      await mutate([task("g"), place("g", "inner")]);
      record = product.schedules.store.get(WORKSPACE, "todo");
      if (!record.ok) throw new Error("record");
      await invoke({
        operation: "trigger-now",
        id: "todo",
        expectedRevision: record.value.revision,
        requestId: "second",
      });
      const second = await settle("todo");
      expect(second.id).not.toBe(first.id);
      expect(second.terminal).toMatchObject({
        status: "succeeded",
        reason: "task-list-acceptance-required",
      });
      expect(objectives.slice(before).sort()).toEqual(["Inspect e", "Inspect g"]);
      expect(await manifest(first)).toBe(frozen);
      expect(JSON.parse(await manifest(second)).manifest.tasks).toEqual(
        expect.arrayContaining([
          { id: "a", status: "accepted" },
          { id: "b", status: "blocked" },
        ]),
      );

      // Nothing admissible with a registered agent remains: a truthful no-work receipt.
      record = product.schedules.store.get(WORKSPACE, "todo");
      if (!record.ok) throw new Error("record");
      await invoke({
        operation: "trigger-now",
        id: "todo",
        expectedRevision: record.value.revision,
        requestId: "third",
      });
      const third = await settle("todo");
      expect(third.terminal).toMatchObject({
        status: "succeeded",
        effect: "none",
        reason: "task-list-no-work",
      });
      expect(third.workflow).toBeNull();
      expect(objectives.length).toBe(before + 2);
      expect(await invoke({ operation: "inspect", id: "todo" })).toMatchObject({
        ok: true,
        value: { availability: "available", target: { kind: "task-list-selection" } },
      });
    } finally {
      await attached?.close();
      await product.close();
    }
  },
  60_000,
);
