import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processProductResources } from "../../application/orchestration/product-resources.ts";
import type { LocalQuestionPresenter } from "../../application/orchestration/question-presenter.ts";
import { createTurnEventJournal } from "../../application/runtime/turn-event-journal.ts";
import { createStaticEnvironment, invocationId } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { mcpFixtureReply, until } from "../../integrations/extensions/mcp-fixtures.ts";
import { createHostManagedServicePort } from "../../integrations/process/host-process-sessions.ts";
import { createDeterministicProviderAdapter } from "../../providers/index.ts";
import { snapshotOf } from "../../tui/composer/index.ts";
import { runMcp } from "../commands/mcp.ts";
import type { GlobalOptions } from "../options.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { composeHostProductCredentials } from "./product-credentials.ts";
import { composeProductMcp } from "./product-mcp.ts";
import { composeProductShellAttachments } from "./product-shell-attachments.ts";
import { createServiceProvider } from "./services.ts";
import { standaloneEnvironment } from "./standalone-environment.ts";

// Every journey here starts a real MCP server process or drives a model turn through one, which
// takes seconds on a loaded hosted runner; the 5 s default fails there first.
const JOURNEY_TIMEOUT_MS = 30_000;
const journey =
  (run: typeof test) =>
  (name: string, body: () => Promise<void>): void =>
    run(name, body, JOURNEY_TIMEOUT_MS);
const posix = journey(process.platform === "win32" ? test.skip : test);
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const fixturePath = fileURLToPath(
  new URL("../../integrations/extensions/mcp-fixtures.ts", import.meta.url),
);
async function fixture(
  mode = "environment",
  preparation?: unknown,
  processEnvironment: Record<string, string> = {},
) {
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
            args:
              mode === "delayed" ? [fixturePath, mode, join(root, "release")] : [fixturePath, mode],
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
      ...processEnvironment,
    }),
  });
  return { config, document, services, globals, release: join(root, "release") };
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
    credentials: composeHostProductCredentials({
      clock: graph.clock,
      environment: graph.environment,
    }).resolver,
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
    await until(() => existsSync(`${f.release}.received`), "the server to receive the call");
    f.document.defaults.execution.environment.set.SELECTED = "replacement-secret";
    await writeFile(join(f.config, "falryn.jsonc"), JSON.stringify(f.document));
    expect((await r.environment.control.execute("reload")).inspection.state).toBe("active");
    await writeFile(f.release, "");
    expect(await request).toMatchObject({ kind: "stale", effect: "uncertain" });
    const next = await r.mcp.lifecycle.connect(r.admission());
    expect(next.kind).toBe("completed");
    if (next.kind === "completed")
      expect(next.snapshot.environmentGeneration).not.toBe(ready.snapshot.environmentGeneration);
  },
);

const zsh = journey(process.platform !== "win32" && Bun.which("zsh") ? test : test.skip);
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
    entries: { tool: 9, resource: 2, "resource-template": 1, prompt: 1 },
  });
  expect(
    probed.payload?.entries.map((entry) => [entry.id, entry.kind, entry.availability]),
  ).toEqual([
    ["mcp:fixture/tool/echo", "tool", "available"],
    ["mcp:fixture/tool/sum", "tool", "available"],
    ["mcp:fixture/tool/fail", "tool", "available"],
    ["mcp:fixture/tool/ask", "tool", "available"],
    ["mcp:fixture/tool/ask-url", "tool", "available"],
    ["mcp:fixture/tool/ask-sampling", "tool", "available"],
    ["mcp:fixture/tool/ask-forever", "tool", "available"],
    ["mcp:fixture/tool/ask-wide", "tool", "available"],
    ["mcp:fixture/tool/union", "tool", "unsupported"],
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

posix(
  "CLI probe authenticates through a credential reference and reports a rejection by code",
  async () => {
    let valid = "probe-secret";
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const message = (await request.json()) as Record<string, unknown>;
        const authorization = request.headers.get("authorization") ?? "";
        seen.push(authorization);
        if (authorization !== "Bearer " + valid) return new Response("no", { status: 401 });
        return Response.json(mcpFixtureReply(message));
      },
    });
    cleanups.push(() => server.stop(true));
    const f = await fixture("normal", undefined, { MCP_REMOTE_TOKEN: "probe-secret" });
    f.document.connections.mcp.servers = [
      {
        id: "remote",
        transport: "http",
        url: "http://127.0.0.1:" + server.port + "/mcp",
        credential: { storeKind: "environment", locator: "MCP_REMOTE_TOKEN" },
      } as never,
    ];
    await writeFile(join(f.config, "falryn.jsonc"), JSON.stringify(f.document));
    const probed = await runMcp(f.services, { action: "probe", serverId: "remote" }, f.globals);
    expect(probed.payload?.probe?.kind, JSON.stringify(probed.payload?.probe)).toBe("completed");
    expect(new Set(seen)).toEqual(new Set(["Bearer probe-secret"]));
    expect(JSON.stringify(probed)).not.toContain("probe-secret");

    valid = "rotated-at-the-server";
    const rejected = await runMcp(f.services, { action: "probe", serverId: "remote" }, f.globals);
    expect(rejected.payload?.probe).toMatchObject({
      kind: "denied",
      code: "mcp-auth-rejected",
      effect: "none",
    });
    expect(JSON.stringify(rejected)).not.toContain("probe-secret");
  },
);

type ToolStep = { readonly name: string; readonly input: Record<string, unknown> };
type ToolReply = { readonly status: string; readonly text: string };
/** Run one deterministic terminal turn whose next tool call may depend on earlier results. */
async function terminalTurn(
  f: Awaited<ReturnType<typeof fixture>>,
  steps: (replies: readonly ToolReply[], generation: number) => ToolStep | null,
  prompt = "Use the configured MCP fixture",
  options: {
    /** Present questions locally, and answer them the way the question sheet does. */
    readonly answer?: (presenter: LocalQuestionPresenter) => void;
  } = {},
) {
  const services = f.services();
  const environment = await standaloneEnvironment(services, f.globals);
  cleanups.push(environment.close);
  const record = services.loader.current();
  if (!record) throw new Error("configuration missing");
  const workspace = await services.ensureWorkspaceSet();
  if (!workspace.ok) throw new Error("workspace missing");
  const clock = services.clock;
  const history = await openProductArtifactSession(
    services,
    undefined,
    undefined,
    options.answer ? { localPresenter: true } : {},
  );
  if (!history) throw new Error("history unavailable");
  cleanups.push(history.close);
  const replies: ToolReply[] = [];
  const confirmations: string[] = [];
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
    ...(history.localUserQuestions ? { localUserQuestions: history.localUserQuestions } : {}),
    configurationValues: () => record.values,
    authorizeMcp: async () => true,
    eventStore: history.eventStore,
    artifacts: history.artifacts,
    clock,
    fileSystem: services.fileSystem,
    workspaceSet: workspace.value.set,
    configurationGeneration: record.generation,
    toolConfirmation: {
      resolve: async (request) => {
        confirmations.push(JSON.stringify(request));
        return { kind: "confirmed", confirmationId: request.confirmationId };
      },
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
  if (options.answer && history.questionPresenter) options.answer(history.questionPresenter);
  const result = await submit(prompt);
  return { attached, history, replies, result, submit, confirmations };
}
/** Tool results as persisted in session history, including outcomes that ended a turn. */
async function recordedResults(turn: Awaited<ReturnType<typeof terminalTurn>>, tool: string) {
  const first = turn.attached.transcriptFeed.events()[0];
  if (!first) throw new Error("missing transcript");
  type Page = Awaited<ReturnType<typeof turn.history.eventStore.readFrom>>;
  const events: Extract<Page, { ok: true }>["value"][number][] = [];
  let afterSequence: (typeof events)[number]["sequence"] | null = null;
  for (;;) {
    const page = await turn.history.eventStore.readFrom(
      { streamId: first.streamId, afterSequence },
      256,
    );
    if (!page.ok) throw new Error("history unreadable");
    events.push(...page.value);
    if (page.value.length < 256) break;
    afterSequence = page.value.at(-1)?.sequence ?? null;
  }
  return events.flatMap((event) => {
    const payload = (event as { payload?: Record<string, unknown> }).payload;
    // Each invocation records an exact result and one settlement; keep the settlement.
    return event.kind === "history.recorded" &&
      payload?.type === "result" &&
      String(payload.id).endsWith(":settlement") &&
      String(payload.capabilityId).includes(tool)
      ? [{ status: payload.status, effect: payload.effect, reason: payload.reason }]
      : [];
  });
}

/** The tool result value inside the model-visible JSON projection. */
function resultOf(reply: ToolReply | undefined): Record<string, unknown> {
  const parsed = JSON.parse(reply?.text ?? "{}") as {
    output?: { value?: { result?: Record<string, unknown> } };
  };
  return parsed.output?.value?.result ?? {};
}

posix(
  "a turn whose prompt names an MCP server still records its attempt start (#1267)",
  async () => {
    const f = await fixture("normal");
    const turn = await terminalTurn(f, () => null, "Use the configured MCP fixture");
    expect(turn.result.kind).toBe("accepted");
    const first = turn.attached.transcriptFeed.events()[0];
    if (!first) throw new Error("missing transcript");
    const page = await turn.history.eventStore.readFrom(
      { streamId: first.streamId, afterSequence: null },
      256,
    );
    if (!page.ok) throw new Error("history unreadable");
    const kinds = page.value.map((event) => event.kind);
    expect(kinds.filter((kind) => kind === "model.attempt.started")).toHaveLength(
      kinds.filter((kind) => kind === "model.attempt.completed").length,
    );
    const started = page.value.find((event) => event.kind === "model.attempt.started");
    // This prompt's full binding exceeded the event bound; the stored record is the bounded one.
    expect(
      started?.kind === "model.attempt.started" && started.payload.binding?.trimmed,
    ).toBeTruthy();
  },
);

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
              name: "mcp_call_tool",
              input: {
                entryId: "mcp:fixture/tool/echo",
                catalogGeneration: first,
                argumentsJson: JSON.stringify({ value: "x" }),
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
      "Connect the MCP fixture, read the note named x y, call its echo tool and get its review prompt",
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

posix(
  "a model selects and calls MCP tools through the gateway with approval and typed results",
  async () => {
    const f = await fixture("normal");
    let generation = 0;
    const sum = "mcp:fixture/tool/sum";
    const turn = await terminalTurn(
      f,
      (done, configurationGeneration) => {
        const last = resultOf(done.at(-1));
        const call = (entryId: string, values: unknown) => ({
          name: "mcp_call_tool",
          input: { entryId, catalogGeneration: generation, argumentsJson: JSON.stringify(values) },
        });
        switch (done.length) {
          case 0:
            return { name: "mcp_connect", input: { serverId: "fixture", configurationGeneration } };
          case 1:
            generation = Number((last.catalog as Record<string, unknown>).catalogGeneration);
            return { name: "mcp_catalog", input: { entryId: sum } };
          case 2:
            return call(sum, { a: 2, b: 3 });
          case 3:
            return call("mcp:fixture/tool/fail", {});
          case 4:
            return call(sum, { a: "two" });
          default:
            return null;
        }
      },
      "Connect the MCP fixture, call its sum tool with 2 and 3, then call its fail tool",
    );
    const { replies } = turn;
    expect(replies.map((reply) => reply.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    const [selected] = resultOf(replies[1]).entries as Record<string, unknown>[];
    expect(selected).toMatchObject({
      id: sum,
      detail: "complete",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
        additionalProperties: false,
      },
    });
    expect(resultOf(replies[2])).toMatchObject({
      entryId: sum,
      catalogGeneration: generation,
      isError: false,
      content: [{ type: "text", text: "5" }],
      structuredContent: { sum: 5 },
    });
    expect(resultOf(replies[3])).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "bad input" }],
    });
    // Invalid arguments end the turn before any server call; history keeps the refusal.
    expect(await recordedResults(turn, "mcp_call_tool")).toEqual([
      { status: "completed", effect: "completed", reason: "completed" },
      { status: "completed", effect: "completed", reason: "completed" },
      { status: "malformed", effect: "none", reason: "mcp-tool-arguments-invalid" },
    ]);
    // A server read-only hint never skips Falryn's external-effect approval.
    expect(
      turn.confirmations.filter((request) => request.includes("mcp_call_tool")).length,
    ).toBeGreaterThanOrEqual(2);
  },
);

/** Connect, then call one fixture tool; the model stops after the call. */
function callAfterConnect(tool: string) {
  let generation = 0;
  return (done: readonly ToolReply[], configurationGeneration: number): ToolStep | null => {
    if (done.length === 0)
      return { name: "mcp_connect", input: { serverId: "fixture", configurationGeneration } };
    if (done.length === 1) {
      generation = Number((resultOf(done[0]).catalog as Record<string, unknown>).catalogGeneration);
      return {
        name: "mcp_call_tool",
        input: {
          entryId: `mcp:fixture/tool/${tool}`,
          catalogGeneration: generation,
          argumentsJson: "{}",
        },
      };
    }
    return null;
  };
}

posix("a server's form question is answered by the local user and the call completes", async () => {
  const f = await fixture("normal");
  const presented: unknown[] = [];
  const turn = await terminalTurn(f, callAfterConnect("ask"), "Call the MCP fixture's ask tool", {
    answer: (presenter) =>
      presenter.subscribe(() => {
        const current = presenter.view().current;
        if (!current || presented.length > 0) return;
        presented.push({ source: current.source, prompt: current.items[0]?.prompt });
        void presenter.answer(current.key, [
          { itemId: "f0", kind: "selection", optionIds: ["o1"] },
          { itemId: "f1", kind: "selection", optionIds: ["skip"] },
        ]);
      }),
  });
  expect(presented).toEqual([
    { source: "fixture · ask", prompt: "Which branch should the release use?\n\nBranch" },
  ]);
  expect(turn.replies.map((reply) => reply.status)).toEqual(["completed", "completed"]);
  const result = resultOf(turn.replies[1]);
  expect(result).toMatchObject({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          requestState: "ask-1",
          responses: { confirm: { action: "accept", content: { branch: "next" } } },
        }),
      },
    ],
    inputRounds: [{ round: 1, key: "confirm", disposition: "accept" }],
  });
});

posix("without a local presenter a form question is cancelled, never answered", async () => {
  const f = await fixture("normal");
  const turn = await terminalTurn(f, callAfterConnect("ask"));
  expect(resultOf(turn.replies[1])).toMatchObject({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          requestState: "ask-1",
          responses: { confirm: { action: "cancel" } },
        }),
      },
    ],
    inputRounds: [{ disposition: "cancel" }],
  });
});

posix(
  "a URL input request ends the call as unsupported and uncertain, releasing its task",
  async () => {
    const f = await fixture("normal");
    const held = () => {
      const { reservations, uncertain } = processProductResources.report();
      return { reservations, uncertain };
    };
    const before = held();
    const turn = await terminalTurn(
      f,
      callAfterConnect("ask-url"),
      "Call the MCP fixture's ask-url tool",
      {
        answer: () => {},
      },
    );
    expect(await recordedResults(turn, "mcp_call_tool")).toEqual([
      { status: "failed", effect: "uncertain", reason: "mcp-input-request-unsupported" },
    ]);
    // The server's effect is uncertain, but nothing of the call still runs locally, so its
    // reservation is released instead of being held for a termination that never comes.
    expect(held()).toEqual(before);
  },
);

posix("a call lost to a disconnect is uncertain and never retried", async () => {
  const f = await fixture("disconnect");
  const runtime = await open(f);
  await runtime.environment.control.execute("reload");
  const { runner, registry } = runtime.mcp.tools;
  let calls = 0;
  const run = (toolName: string, input: Record<string, unknown>) => {
    const entry = registry.resolveByName(toolName);
    if (!entry) throw new Error("missing " + toolName);
    return runner.execute({
      invocationId: invocationId.from("disconnect-" + ++calls),
      toolCallId: "disconnect-" + calls,
      toolName,
      capabilityId: entry.manifest.capabilityId,
      version: entry.manifest.version,
      effect: entry.manifest.effect,
      input,
      signal: new AbortController().signal,
    });
  };
  const connected = await run("mcp_connect", {
    serverId: "fixture",
    configurationGeneration: runtime.admission().configurationGeneration,
  });
  if (connected.status !== "completed") throw new Error(connected.status);
  const generation = Number(
    (connected.output.result as { catalog: { catalogGeneration: number } }).catalog
      .catalogGeneration,
  );
  const call = () =>
    run("mcp_call_tool", {
      entryId: "mcp:fixture/tool/echo",
      catalogGeneration: generation,
      argumentsJson: JSON.stringify({ value: "once" }),
    });
  // The server exits while handling the call: the effect is unknown and not retried.
  expect(await call()).toEqual({
    status: "failed",
    reason: "mcp-request-failed",
    effect: "uncertain",
  });
  // The lost transport makes the selection stale; nothing reconnects to repeat the call.
  expect(await call()).toEqual({
    status: "unavailable",
    reason: "mcp-catalog-entry-stale",
    effect: "none",
  });
  expect(runtime.mcp.lifecycle.inspect()[0]?.transportGeneration).toBe(1);
});
