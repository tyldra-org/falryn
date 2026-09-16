import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTurnEventJournal } from "../../application/runtime/turn-event-journal.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createHostManagedServicePort } from "../../integrations/process/host-process-sessions.ts";
import { createDeterministicProviderAdapter } from "../../providers/index.ts";
import { snapshotOf } from "../../tui/composer/index.ts";
import { runMcp } from "../commands/mcp.ts";
import type { GlobalOptions } from "../options.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { composeProductMcp } from "./product-mcp.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";
import { createServiceProvider } from "./services.ts";
import { standaloneEnvironment } from "./standalone-environment.ts";

const posix = process.platform === "win32" ? test.skip : test;
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const fixturePath = fileURLToPath(
  new URL("../../integrations/extensions/mcp-fixtures.ts", import.meta.url),
);
async function fixture(mode = "environment", preparation?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "falryn-mcp-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const config = join(root, "config");
  const workspace = join(root, "workspace");
  await mkdir(config);
  await mkdir(workspace);
  const document = {
    schemaVersion: 2,
    minimumReaderSchemaVersion: 2,
    defaults: {
      execution: {
        environment: {
          set: {
            SELECTED: "selected-secret",
            OTHER_SERVER_TOKEN: "other-secret",
            OPENAI_API_KEY: "provider-secret",
          },
          ...(preparation ? { preparation } : {}),
        },
      },
    },
    connections: {
      mcp: {
        servers: [
          {
            id: "fixture",
            transport: "stdio",
            executable: process.execPath,
            args: [fixturePath, mode],
            environmentNames: ["SELECTED"],
          },
        ],
      },
    },
  };
  await writeFile(join(config, "falryn.jsonc"), JSON.stringify(document));
  const globals: GlobalOptions = {
    color: "never",
    format: "json",
    nonInteractive: true,
    profile: null,
    quiet: false,
    timeoutMs: null,
    verbose: false,
    workspace,
    addDirs: [],
    help: false,
    version: false,
  };
  const services = createServiceProvider(globals, {
    home: localPath(root),
    currentDirectory: localPath(workspace),
    environment: createStaticEnvironment({
      FALRYN_CONFIG_DIR: config,
      FALRYN_STATE_DIR: join(root, "state"),
    }),
  });
  return { config, document, services, globals };
}
async function open(f: Awaited<ReturnType<typeof fixture>>) {
  const graph = f.services();
  const environment = await standaloneEnvironment(graph, f.globals);
  cleanups.push(environment.close);
  const configuration = () => {
    const record = graph.loader.current();
    if (!record) throw new Error("missing configuration");
    return { values: record.values, generation: Number(record.generation), record };
  };
  const mcp = composeProductMcp({
    identity: crypto.randomUUID(),
    generation: configuration().record.generation,
    configuration,
    services: createHostManagedServicePort(),
    context: environment.context,
    environment: graph.environment,
    authorize: async (signal) => {
      const trust = await graph.workspaceTrust.resolve(undefined, signal);
      return trust.status === "empty" || trust.status === "accepted";
    },
  });
  cleanups.push(mcp.close);
  const admission = () => ({
    serverId: "fixture",
    configurationGeneration: configuration().generation,
    origin: "user" as const,
    requestId: crypto.randomUUID(),
    deadline: Date.now() + 3000,
    signal: new AbortController().signal,
  });
  return { mcp, environment, admission };
}

posix(
  "real scoped preparation filters other credentials and redacts the selected secret",
  async () => {
    const f = await fixture();
    const runtime = await open(f);
    expect(runtime.mcp.lifecycle.inspect()[0]?.state).toBe("unqueried");
    expect((await runtime.environment.control.execute("reload")).inspection.state).toBe("active");
    const ready = await runtime.mcp.lifecycle.connect(runtime.admission());
    expect(ready.kind).toBe("completed");
    if (ready.kind !== "completed") return;
    const result = await runtime.mcp.lifecycle.request(
      runtime.admission(),
      ready.snapshot.transportGeneration,
      "tools/call",
      { name: "echo" },
    );
    expect(result.kind).toBe("completed");
    const encoded = JSON.stringify(result);
    expect(encoded).toContain("SELECTED");
    expect(encoded).toContain("[REDACTED]");
    for (const forbidden of [
      "selected-secret",
      "other-secret",
      "provider-secret",
      "OTHER_SERVER_TOKEN",
      "OPENAI_API_KEY",
    ])
      expect(encoded).not.toContain(forbidden);
  },
);

posix(
  "published environment reload fences pending replies and reconnect uses a new generation",
  async () => {
    const f = await fixture("delayed");
    const r = await open(f);
    await r.environment.control.execute("reload");
    const ready = await r.mcp.lifecycle.connect(r.admission());
    expect(ready.kind).toBe("completed");
    if (ready.kind !== "completed") return;
    const request = r.mcp.lifecycle.request(
      r.admission(),
      ready.snapshot.transportGeneration,
      "tools/call",
      { name: "echo" },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    f.document.defaults.execution.environment.set.SELECTED = "replacement-secret";
    await writeFile(join(f.config, "falryn.jsonc"), JSON.stringify(f.document));
    expect((await r.environment.control.execute("reload")).inspection.state).toBe("active");
    expect(await request).toMatchObject({ kind: "stale", effect: "uncertain" });
    const next = await r.mcp.lifecycle.connect(r.admission());
    expect(next.kind).toBe("completed");
    if (next.kind === "completed")
      expect(next.snapshot.environmentGeneration).not.toBe(ready.snapshot.environmentGeneration);
  },
);

const zsh = process.platform !== "win32" && Bun.which("zsh") ? test : test.skip;
zsh("malformed required setup cannot leak stdout into protocol or start a server", async () => {
  const f = await fixture("normal", {
    interpreter: Bun.which("zsh"),
    exports: ["SELECTED"],
    required: true,
  });
  await writeFile(join(f.config, "env.zsh"), "printf 'invalid diagnostic stdout'; return 1");
  const r = await open(f);
  expect((await r.environment.control.execute("reload")).inspection.state).toBe("blocked");
  expect((await r.mcp.lifecycle.connect(r.admission())).kind).not.toBe("completed");
  expect(JSON.stringify(r.mcp.lifecycle.inspect())).not.toContain("invalid diagnostic stdout");
});

posix("CLI inspect stays inert and probe closes the same supervised transport", async () => {
  const f = await fixture("normal");
  const inspected = await runMcp(f.services, { action: "inspect" }, f.globals);
  expect(inspected.payload?.connections[0]?.state).toBe("unqueried");
  const probed = await runMcp(f.services, { action: "probe", serverId: "fixture" }, f.globals);
  expect(probed.outcome.kind).toBe("completed");
  expect(probed.payload?.probe?.kind).toBe("completed");
  expect(probed.payload?.connections[0]?.state).toBe("stopped");
});

posix(
  "terminal MCP controls persist the same semantic results exposed in its transcript",
  async () => {
    const f = await fixture("normal");
    const services = f.services();
    const environment = await standaloneEnvironment(services, f.globals);
    cleanups.push(environment.close);
    const record = services.loader.current();
    if (!record) throw new Error("configuration missing");
    const workspace = await services.ensureWorkspaceSet();
    if (!workspace.ok) throw new Error("workspace missing");
    const clock = services.clock;
    const history = await openProductArtifactSession(services);
    if (!history) throw new Error("history unavailable");
    cleanups.push(history.close);
    const statuses: string[] = [];
    const adapter = createDeterministicProviderAdapter({
      script(request, index) {
        if (index > 0) {
          const part = request.messages
            .findLast((message) => message.role === "tool")
            ?.parts.find((part) => part.kind === "text");
          if (part?.kind !== "text") throw new Error("MCP result missing");
          const result = JSON.parse(part.text);
          statuses.push(result.status);
        }
        const name = ["mcp_inspect", "mcp_connect", "mcp_stop"][index];
        if (!name) return { kind: "text", text: "MCP lifecycle complete." };
        return {
          kind: "tool",
          name,
          toolCallId: `terminal-mcp-${index}`,
          argumentFragments: [
            JSON.stringify(
              index === 0
                ? {}
                : index === 1
                  ? { serverId: "fixture", configurationGeneration: Number(record.generation) }
                  : { serverId: "fixture" },
            ),
          ],
        };
      },
    });
    const model = adapter.supportedModels[0];
    if (!model) throw new Error("model missing");
    const attached = await composeProductShellAttachments({
      configurationValues: () => record.values,
      authorizeMcp: async () => true,
      eventStore: history.eventStore,
      artifacts: history.artifacts,
      clock,
      fileSystem: services.fileSystem,
      workspaceSet: workspace.value.set,
      configurationGeneration: record.generation,
      toolConfirmation: {
        resolve: async (request) => ({ kind: "confirmed", confirmationId: request.confirmationId }),
      },
      provider: {
        kind: "ready",
        adapter,
        session: {
          kind: "ready",
          release: async () => {},
          connection: {
            profile: {
              ...adapter.identity,
              adapterKind: "deterministic",
              displayName: "Sandbox fixture",
              endpoint: null,
              credential: null,
              organization: null,
              project: null,
              enabledModels: [model],
              transportCompatibility: null,
              modelCapabilities: [],
              discovery: "static",
              timeouts: { connectMs: 1_000, requestMs: 10_000 },
            },
            account: null,
            updatedAt: clock.now(),
          },
          auth: {
            profileId: adapter.identity.profileId,
            state: "ready",
            consumer: "provider:fixture",
            observedAt: clock.now(),
            health: null,
            code: null,
            retryable: false,
          },
          catalog: {
            generation: 1,
            provenance: "static-config",
            fetchedAt: clock.now(),
            expiresAt: null,
            models: [
              {
                schemaVersion: 1,
                modelId: model,
                displayName: null,
                inputModalities: ["text"],
                outputModalities: ["text"],
                tools: "supported",
                structuredOutput: "supported",
                streaming: "supported",
                reasoning: "supported",
                reasoningControls: ["balanced"],
                completeness: "complete",
                availability: "available",
                provenance: ["profile-declaration"],
                contextTokens: 128_000,
                outputTokens: 8_000,
              },
            ],
          },
        },
      },
    });
    if (!attached) throw new Error("terminal unavailable");
    cleanups.push(attached.close);
    const result = await attached.submission.submit(
      snapshotOf("Inspect, connect and stop the configured MCP fixture", 1),
    );
    expect(result.kind).toBe("accepted");
    expect(statuses).toEqual(["completed", "completed", "completed"]);
    const events = attached.transcriptFeed.events();
    const invocations = events.filter(
      (event) =>
        event.kind === "capability.invocation.completed" &&
        String(event.capabilityId).startsWith("builtin:extensions/mcp_"),
    );
    expect(invocations).toHaveLength(3);
    const first = invocations[0];
    if (!first) throw new Error("missing event");
    const rebuilt = await createTurnEventJournal({
      eventStore: history.eventStore,
      clock,
      streamId: first.streamId,
      correlation: first.correlation,
    }).replay();
    expect(rebuilt.kind).toBe("rebuilt");
    if (rebuilt.kind === "rebuilt")
      expect(
        rebuilt.events.filter((event) =>
          invocations.some((item) => item.eventId === event.eventId),
        ),
      ).toEqual(invocations);
    expect(statuses).toHaveLength(3);
    const persisted = await history.eventStore.readFrom(
      { streamId: first.streamId, afterSequence: null },
      256,
    );
    expect(persisted.ok).toBe(true);
    if (persisted.ok)
      expect(
        persisted.value.filter((event) =>
          invocations.some((item) => item.eventId === event.eventId),
        ),
      ).toEqual(invocations);
  },
);
