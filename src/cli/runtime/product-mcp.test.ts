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

posix("CLI inspect stays inert and probe discovers the catalog before closing", async () => {
  const f = await fixture("normal");
  const inspected = await runMcp(f.services, { action: "inspect" }, f.globals);
  expect(inspected.payload?.connections[0]?.state).toBe("unqueried");
  expect(inspected.payload?.catalogs[0]).toMatchObject({
    state: "unknown",
    catalogGeneration: null,
  });
  const probed = await runMcp(f.services, { action: "probe", serverId: "fixture" }, f.globals);
  expect(probed.outcome.kind).toBe("completed");
  expect(probed.payload?.probe?.kind).toBe("completed");
  expect(probed.payload?.connections[0]?.state).toBe("stopped");
  expect(probed.payload?.catalogs[0]).toMatchObject({
    state: "current",
    listChanges: "observed",
    entries: { tool: 1, resource: 2, "resource-template": 1, prompt: 1 },
  });
  expect(
    probed.payload?.entries.map((entry) => [entry.id, entry.kind, entry.availability]),
  ).toEqual([
    ["mcp:fixture/tool/echo", "tool", "available"],
    ["mcp:fixture/resource/fixture%3A%2F%2Fnotes%2Fa", "resource", "available"],
    ["mcp:fixture/resource/fixture%3A%2F%2Fnotes%2Fb", "resource", "available"],
    [
      "mcp:fixture/resource-template/fixture%3A%2F%2Fnotes%2F%7Bname%7D",
      "resource-template",
      "available",
    ],
    ["mcp:fixture/prompt/review", "prompt", "available"],
  ]);
});

type ToolStep = { readonly name: string; readonly input: Record<string, unknown> };
type ToolReply = { readonly status: string; readonly text: string };
/** Run one deterministic terminal turn whose next tool call may depend on earlier results. */
async function terminalTurn(
  f: Awaited<ReturnType<typeof fixture>>,
  steps: (replies: readonly ToolReply[], generation: number) => ToolStep | null,
  prompt = "Use the configured MCP fixture",
) {
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
  const replies: ToolReply[] = [];
  const seen = new Set<string>();
  const adapter = createDeterministicProviderAdapter({
    script(request, index) {
      const message = request.messages.findLast((item) => item.role === "tool");
      const part = message?.parts.find((item) => item.kind === "text");
      const id = message && "toolCallId" in message ? String(message.toolCallId) : "";
      // A later turn replays earlier history; record each tool result once.
      if (index > 0 && part?.kind === "text" && !seen.has(id)) {
        seen.add(id);
        replies.push({ status: JSON.parse(part.text).status, text: part.text });
      }
      const step = steps(replies, Number(record.generation));
      if (!step) return { kind: "text", text: "MCP work complete." };
      return {
        kind: "tool",
        name: step.name,
        toolCallId: "terminal-mcp-" + index,
        argumentFragments: [JSON.stringify(step.input)],
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
  let sequence = 0;
  const submit = (text: string) => attached.submission.submit(snapshotOf(text, ++sequence));
  const result = await submit(prompt);
  return { attached, history, replies, result, submit };
}
/** The tool result value inside the model-visible JSON projection. */
function resultOf(reply: ToolReply | undefined): Record<string, unknown> {
  const parsed = JSON.parse(reply?.text ?? "{}") as {
    output?: { value?: { result?: Record<string, unknown> } };
  };
  return parsed.output?.value?.result ?? {};
}

posix(
  "terminal MCP controls persist the same semantic results exposed in its transcript",
  async () => {
    const f = await fixture("normal");
    const { attached, history, replies, result } = await terminalTurn(f, (done, generation) => {
      const name = ["mcp_inspect", "mcp_connect", "mcp_stop"][done.length];
      if (!name) return null;
      return {
        name,
        input:
          done.length === 0
            ? {}
            : done.length === 1
              ? { serverId: "fixture", configurationGeneration: generation }
              : { serverId: "fixture" },
      };
    });
    expect(result.kind).toBe("accepted");
    expect(replies.map((reply) => reply.status)).toEqual(["completed", "completed", "completed"]);
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
      clock: f.services().clock,
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

posix(
  "a model discovers, reads a template through unified Read and gets a prompt, then sees a list change",
  async () => {
    const f = await fixture("catalog-change");
    const template = "mcp:fixture/resource-template/fixture%3A%2F%2Fnotes%2F%7Bname%7D";
    const prompt = "mcp:fixture/prompt/review";
    let first = 0;
    let refreshTurn = false;
    let transportGeneration = 0;
    const turn = await terminalTurn(
      f,
      (done, generation) => {
        const last = resultOf(done.at(-1));
        switch (done.length) {
          case 0:
            return {
              name: "mcp_connect",
              input: { serverId: "fixture", configurationGeneration: generation },
            };
          case 1:
            first = Number((last.catalog as Record<string, unknown>).catalogGeneration);
            transportGeneration = Number(
              (last.connection as Record<string, unknown>).transportGeneration,
            );
            return { name: "mcp_catalog", input: { kind: "resource-template" } };
          case 2:
            return {
              name: "mcp_resource_template",
              input: {
                entryId: template,
                catalogGeneration: first,
                arguments: [{ name: "name", value: "x y" }],
              },
            };
          case 3:
            return {
              name: "read",
              input: { resources: [{ kind: "virtual", uri: String(last.readHandle) }] },
            };
          case 4:
            // The fixture announces a resource list change after this tool call.
            return {
              name: "mcp_request",
              input: {
                serverId: "fixture",
                configurationGeneration: generation,
                transportGeneration,
                method: "tools/call",
                paramsJson: JSON.stringify({ name: "echo", arguments: { value: "x" } }),
              },
            };
          case 5:
            return {
              name: "mcp_get_prompt",
              input: {
                entryId: prompt,
                catalogGeneration: first,
                arguments: [{ name: "topic", value: "notes" }],
              },
            };
          case 6:
            // The first turn ends on the stale result; the user asks again in a second turn.
            if (!refreshTurn) return null;
            return {
              name: "mcp_connect",
              input: { serverId: "fixture", configurationGeneration: generation },
            };
          case 7:
            return {
              name: "mcp_get_prompt",
              input: {
                entryId: prompt,
                catalogGeneration: Number(
                  (last.catalog as Record<string, unknown>).catalogGeneration,
                ),
                arguments: [{ name: "topic", value: "notes" }],
              },
            };
          default:
            return null;
        }
      },
      "Connect the MCP fixture, read the note named x y, call its echo tool with an MCP request and get its review prompt",
    );
    const { replies } = turn;
    // The model receives the stale result and answers; it does not act on the old generation.
    expect(turn.result.kind).toBe("accepted");
    expect(replies.map((reply) => reply.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "unavailable",
    ]);
    refreshTurn = true;
    const second = await turn.submit("Refresh the MCP fixture and get the review prompt");
    expect(second.kind).toBe("accepted");
    expect(replies.map((reply) => reply.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
      "completed",
      "unavailable",
      "completed",
      "completed",
    ]);
    expect(resultOf(replies[0]).catalog).toMatchObject({
      state: "current",
      listChanges: "observed",
    });
    const listed = resultOf(replies[1]).entries as Record<string, unknown>[];
    expect(listed.map((entry) => [entry.id, entry.availability])).toEqual([
      [template, "available"],
    ]);
    expect(resultOf(replies[2]).uri).toBe("fixture://notes/x%20y");
    expect(replies[3]?.text).toContain("note fixture://notes/x%20y");
    // The change lands before or during the prompt request; both are stale, neither is served.
    expect(replies[5]?.text).toMatch(/mcp-catalog-(entry-stale|changed-during-request)/u);
    const refreshed = Number(
      (resultOf(replies[6]).catalog as Record<string, unknown>).catalogGeneration,
    );
    expect(refreshed).toBeGreaterThan(first);
    expect(resultOf(replies[7]).messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Review notes" }] },
      { role: "assistant", content: [{ type: "unsupported", contentType: "image" }] },
    ]);
  },
);
