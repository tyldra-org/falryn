import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createDeterministicProviderAdapter } from "../../providers/index.ts";
import type { GlobalOptions } from "../options.ts";
import { resultEvents } from "../output/result-events.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { runCoding } from "./coding-run.ts";
import { createServiceProvider } from "./services.ts";

afterEach(removeTemporaryRoots);
test("model selection discovers schedule controls, registers inert intent and cannot enable it", async () => {
  const root = await temporaryRoot("schedule-model-");
  const globals: GlobalOptions = {
    format: "json",
    color: "never",
    quiet: false,
    verbose: false,
    nonInteractive: true,
    workspace: root,
    addDirs: [],
    profile: null,
    timeoutMs: null,
    help: false,
    version: false,
  };
  const environment = createStaticEnvironment({
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
  const services = createServiceProvider(globals, {
    home: localPath(root),
    currentDirectory: localPath(root),
    environment,
  });
  const commands = [
    { operation: "list" },
    {
      operation: "create",
      id: "model-draft",
      definition: {
        version: 1,
        timing: { trigger: { kind: "interval", everyMs: 1000 } },
        target: {
          kind: "action",
          capability: "builtin:workspace/stat_path@1",
          input: { path: "." },
        },
      },
    },
    { operation: "inspect", id: "model-draft" },
  ];
  const requests: string[] = [];
  const provider = createDeterministicProviderAdapter({
    onRequest: (request) => requests.push(JSON.stringify(request)),
    script: (_request, index) => {
      const command = commands[index];
      return command
        ? {
            kind: "tool",
            name: "schedule",
            toolCallId: `schedule-model-${index}`,
            argumentFragments: [
              JSON.stringify({
                operation: command.operation,
                commandJson: JSON.stringify(command),
              }),
            ],
          }
        : { kind: "text", text: "The schedule is disabled and needs the user's explicit enable." };
    },
  });
  const result = await runCoding(
    services,
    {
      promptParts: [
        "Prepare a disabled schedule for workspace inspection. Inspect it and leave activation to me.",
      ],
    },
    {
      globals,
      input: createRecordingCliStreams({ stdin: null }).input,
      providerAdapter: provider,
      toolConfirmation: {
        resolve: async (request) => ({ kind: "confirmed", confirmationId: request.confirmationId }),
      },
    },
  );
  expect(result.payload?.stage).toBe("attempt-completed");
  expect(requests.length).toBe(4);
  expect(requests[0]).toContain('"name":"schedule"');
  const final = JSON.parse(requests.at(-1) ?? "{}");
  const results = final.messages
    .filter((message: { role: string }) => message.role === "tool")
    .flatMap((message: { parts: { text?: string }[] }) =>
      message.parts.map((part) => part.text ?? ""),
    )
    .join("\n");
  expect(results).toContain('"state":"disabled"');
  expect(results).not.toContain('"state":"enabled"');
  const enable = createDeterministicProviderAdapter({
    script: () => ({
      kind: "tool",
      name: "schedule",
      toolCallId: "forbidden-enable",
      argumentFragments: [
        JSON.stringify({
          operation: "enable",
          commandJson: JSON.stringify({
            operation: "enable",
            id: "model-draft",
            expectedRevision: 1,
          }),
        }),
      ],
    }),
  });
  const denied = await runCoding(
    services,
    { promptParts: ["Enable the prepared schedule."] },
    {
      globals,
      input: createRecordingCliStreams({ stdin: null }).input,
      providerAdapter: enable,
      toolConfirmation: {
        resolve: async (request) => ({ kind: "confirmed", confirmationId: request.confirmationId }),
      },
    },
  );
  expect(denied.payload?.stage).toBe("attempt-failed");
  expect(JSON.stringify(resultEvents(denied))).toContain("schedule-user-action-required");
}, 30000);

test.skipIf(process.platform === "win32")(
  "live product controls honor profile defaults, publish one durable notice, and reject changed config",
  async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { loadProductConfiguration, productConfigurationLoadRequest } = await import(
      "./product-configuration.ts"
    );
    const { openProductArtifactSession } = await import("./product-artifact-session.ts");
    const { composeProductShellAttachments } = await import("./product-shell-attachments.ts");
    const { configurationGeneration, streamId } = await import("../../domain/foundation/index.ts");
    const root = await temporaryRoot("schedule-product-");
    const globals: GlobalOptions = {
      format: "json",
      color: "never",
      quiet: false,
      verbose: false,
      nonInteractive: false,
      workspace: root,
      addDirs: [],
      profile: "scheduled",
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
    await mkdir(join(root, "config", "profiles"), { recursive: true });
    const path = join(root, "config", "profiles", "scheduled.jsonc");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 2,
        minimumReaderSchemaVersion: 2,
        overrides: {
          execution: {
            schedules: { version: 1, missed: { kind: "latest" }, timezone: "America/New_York" },
          },
        },
      }),
    );
    const graph = createServiceProvider(globals, {
      home: localPath(root),
      currentDirectory: localPath(root),
      environment: env,
    })();
    const loaded = await loadProductConfiguration(graph, productConfigurationLoadRequest(globals));
    expect(loaded.outcome.kind).toBe("published");
    const product = await openProductArtifactSession(graph);
    if (!product) throw new Error("storage");
    const { writeFileSync } = await import("node:fs");
    const { EMPTY_MODEL_PREFERENCES, roleRouteBaseSchema } = await import(
      "../../providers/configuration/policy-schema.ts"
    );
    const { catalogFromAdapterModels } = await import("../../providers/index.ts");
    let revokeDuringModel = false;
    let scheduledRequests = 0;
    const scheduledProvider = createDeterministicProviderAdapter({
      onRequest() {
        scheduledRequests++;
        if (revokeDuringModel)
          writeFileSync(
            path,
            JSON.stringify({ schemaVersion: 2, minimumReaderSchemaVersion: 2, overrides: {} }),
          );
      },
      script: () => ({ kind: "text", text: '{"value":"ok"}' }),
    });
    const route = roleRouteBaseSchema.parse({
      providerId: scheduledProvider.identity.providerId,
      providerProfileId: scheduledProvider.identity.profileId,
      modelId: scheduledProvider.supportedModels[0],
      reasoning: "provider-default",
    });
    const catalog = catalogFromAdapterModels(scheduledProvider.supportedModels, {
      generation: Number(loaded.generation),
      fetchedAt: graph.clock.now(),
      capabilities: scheduledProvider.modelCapabilities,
    });
    const attached = await composeProductShellAttachments({
      modelPreferences: () => ({
        ...EMPTY_MODEL_PREFERENCES,
        roles: { ...EMPTY_MODEL_PREFERENCES.roles, default: route },
      }),
      resolveAgentProvider: async () => ({ adapter: scheduledProvider, catalog }),
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
      joins: product.joins,
      schedules: { ...product.schedules, autostart: false },
      taskNotices: product.taskNotices,
    });
    if (!attached?.submission.schedule || !attached.schedules) throw new Error("schedule-controls");
    const signal = new AbortController().signal;
    try {
      const invoke = (input: unknown) => attached.submission.schedule?.(input, signal);
      const definition = {
        version: 1,
        timing: { trigger: { kind: "interval", everyMs: 1000 } },
        target: {
          kind: "action",
          capability: "builtin:workspace/stat_path@1",
          input: { path: "." },
        },
      };
      expect(await invoke({ operation: "create", id: "live", definition })).toMatchObject({
        ok: true,
        value: { state: "disabled", missed: { kind: "latest" } },
      });
      expect(await invoke({ operation: "enable", id: "live", expectedRevision: 1 })).toMatchObject({
        ok: true,
      });
      await attached.schedules.wake();
      for (let i = 0; i < 100 && attached.schedules.inspect().active; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      await attached.schedules.wake();
      const attempts = product.schedules.store.attempts("root-1");
      if (!attempts.ok || !attempts.value[0]) throw new Error("missing-attempt");
      const attempt = attempts.value[0];
      expect(attempt.terminal).toMatchObject({ status: "succeeded" });
      const stream = streamId.from(`schedule-attempt:${attempt.id}`);
      const before = await product.eventStore.readFrom(
        { streamId: stream, afterSequence: null },
        100,
        signal,
      );
      expect(
        before.ok && before.value.filter((event) => event.kind === "schedule.settled").length,
      ).toBe(1);
      expect(await product.schedules.notify(attempt, signal, "root-1")).toBe(true);
      expect(
        await product.eventStore.readFrom({ streamId: stream, afterSequence: null }, 100, signal),
      ).toEqual(before);
      expect(
        product.taskNotices.events().filter((event) => event.kind === "schedule.settled"),
      ).toHaveLength(1);
      const partialDefinition = {
        ...definition,
        target: {
          kind: "workflow",
          arguments: {},
          definition: {
            version: 1,
            id: "user:partial-scheduled",
            label: "Partial inspection",
            argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
            nodes: [
              {
                key: "stat",
                kind: "action",
                capability: "builtin:workspace/stat_path@1",
                effect: "observation",
                input: { path: { from: "literal", value: "." } },
                resultPath: ["kind"],
                resultSchema: { type: "string" },
              },
              {
                key: "missing",
                dependencies: ["stat"],
                kind: "action",
                capability: "builtin:workspace/read_file@1",
                effect: "observation",
                input: { path: { from: "literal", value: "missing-file" } },
                resultSchema: { type: "string" },
              },
            ],
            outputs: { kind: { from: "node", node: "stat" } },
          },
        },
      };
      expect(
        await invoke({ operation: "create", id: "partial", definition: partialDefinition }),
      ).toMatchObject({ ok: true });
      expect(
        await invoke({ operation: "enable", id: "partial", expectedRevision: 1 }),
      ).toMatchObject({ ok: true });
      await attached.schedules.wake();
      for (let i = 0; i < 100 && attached.schedules.inspect().active; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      const partial = product.schedules.store.latest("root-1", "partial");
      expect(partial).toMatchObject({
        ok: true,
        value: { terminal: { status: "failed", effect: "partial" } },
      });
      if (!partial.ok || !partial.value?.workflow) throw new Error("missing-workflow");
      const workflow = product.workflows.get(partial.value.workflow);
      expect(workflow).toMatchObject({
        ok: true,
        value: { nodes: [{ state: "completed" }, { state: "failed" }] },
      });
      const deniedDefinition = {
        ...definition,
        target: {
          kind: "action",
          capability: "builtin:workspace/write_files@1",
          input: { targets: [{ kind: "create", path: "must-not-exist", text: "secret-canary" }] },
        },
      };
      expect(
        await invoke({ operation: "create", id: "denied", definition: deniedDefinition }),
      ).toMatchObject({ ok: true });
      expect(
        await invoke({ operation: "enable", id: "denied", expectedRevision: 1 }),
      ).toMatchObject({ ok: true });
      await attached.schedules.wake();
      for (let i = 0; i < 100 && attached.schedules.inspect().active; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(product.schedules.store.latest("root-1", "denied")).toMatchObject({
        ok: true,
        value: { terminal: { status: "denied", effect: "none" } },
      });
      expect(await Bun.file(join(root, "must-not-exist")).exists()).toBe(false);
      expect(JSON.stringify(await invoke({ operation: "list" }))).not.toContain("secret-canary");
      const modelDefinition = {
        ...definition,
        target: {
          kind: "workflow",
          arguments: {},
          definition: {
            version: 1,
            id: "user:scheduled-models",
            label: "Two governed model nodes",
            argumentsSchema: { type: "object", properties: {}, additionalProperties: false },
            nodes: ["first", "second"].map((key, index) => ({
              key,
              kind: "model",
              instruction: "Return the requested JSON object.",
              input: {},
              dependencies: index ? ["first"] : [],
              resultSchema: {
                type: "object",
                properties: { value: { type: "string" } },
                required: ["value"],
                additionalProperties: false,
              },
            })),
            outputs: { value: { from: "node", node: "second" } },
          },
        },
      };
      for (const id of ["models-current", "models-revoked"]) {
        revokeDuringModel = id === "models-revoked";
        const before = scheduledRequests;
        expect(
          await invoke({ operation: "create", id, definition: modelDefinition }),
        ).toMatchObject({ ok: true });
        expect(await invoke({ operation: "enable", id, expectedRevision: 1 })).toMatchObject({
          ok: true,
        });
        await attached.schedules.wake();
        for (let i = 0; i < 200 && attached.schedules.inspect().active; i++)
          await new Promise((resolve) => setTimeout(resolve, 10));
        const attempt = product.schedules.store.latest("root-1", id);
        expect(attempt).toMatchObject({
          ok: true,
          value: { terminal: { status: revokeDuringModel ? "failed" : "succeeded" } },
        });
        expect(scheduledRequests - before).toBe(revokeDuringModel ? 1 : 2);
        if (!attempt.ok || !attempt.value?.workflow) throw new Error("missing-model-workflow");
        expect(product.workflows.get(attempt.value.workflow)).toMatchObject({
          ok: true,
          value: {
            nodes: [{ state: "completed" }, { state: revokeDuringModel ? "failed" : "completed" }],
          },
        });
        const saved = product.schedules.store.get("root-1", id);
        if (saved.ok)
          await invoke({ operation: "pause", id, expectedRevision: saved.value.revision });
      }
      expect(await invoke({ operation: "inspect", id: "live" })).toMatchObject({
        ok: true,
        value: {
          availability: "unavailable",
          blocker: "configuration-source-changed",
          missed: { kind: "latest" },
        },
      });
      const record = product.schedules.store.get("root-1", "live");
      if (!record.ok) throw new Error(record.error.code);
      expect(
        await invoke({
          operation: "trigger-now",
          id: "live",
          expectedRevision: record.value.revision,
          requestId: "changed-config",
        }),
      ).toMatchObject({ ok: false, error: { code: "configuration-source-changed" } });
    } finally {
      await attached.close();
      await product.close();
    }
  },
);
