import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  configurationGeneration,
  createSystemClock,
  invocationId,
  managedServiceId,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import { createToolHookRegistry, type ToolInvocationOutcome } from "../../domain/tools/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createHostManagedServicePort } from "../../integrations/process/host-process-sessions.ts";
import { createProductCapabilityRegistry } from "../capabilities/product-capability-registry.ts";
import { createDebugAdapterSupervisor } from "../debugging/debug-adapter.ts";
import { createLanguageServerSupervisor } from "../language/language-server.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { createTurnEventJournal } from "../runtime/turn-event-journal.ts";
import { languageServiceFixtureConfiguration } from "./product-language-tools/test-support.ts";
import { discloseProductTools } from "./product-tool-disclosure.ts";
import { createProductToolGateway } from "./product-tool-gateway.ts";
import { composeProductLanguageTools } from "./product-tools-language.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});
const hostTest = process.platform === "win32" ? test.skip : test;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "falryn-language-gateway-")));
  const configuration = { generation: 0, services: languageServiceFixtureConfiguration(root) };
  const hostManaged = createHostManagedServicePort();
  const queriesStarted = Promise.withResolvers<void>();
  let queries = 0;
  const managed: typeof hostManaged = {
    ...hostManaged,
    send: async (id, generation, input) => {
      const result = await hostManaged.send(id, generation, input);
      if (new TextDecoder().decode(input).includes("textDocument/hover") && ++queries === 2)
        queriesStarted.resolve();
      return result;
    },
  };
  const lsp = createLanguageServerSupervisor(managed);
  const dap = createDebugAdapterSupervisor(managed, { confirmationPolicy: "auto-allow" });
  cleanups.push(async () => {
    const server = lsp.snapshot(managedServiceId.from("fixture-lsp"));
    if (server) await lsp.shutdown(server.serviceId, server.generation);
    const adapter = dap.snapshot(managedServiceId.from("fixture-dap"));
    if (adapter) await dap.disconnect(adapter.serviceId, adapter.generation);
    await rm(root, { recursive: true, force: true });
  });
  let unread = false;
  const generation = configurationGeneration.from(0);
  const tools = composeProductLanguageTools({
    generation,
    languageServers: lsp,
    debugAdapters: dap,
    workspaceRoot: localPath(root),
    configuration: () => {
      if (unread) throw new Error("unread");
      return configuration;
    },
  });
  const clock = createSystemClock();
  const correlation = {
    workspaceId: workspaceId.from(root),
    sessionId: sessionId.from("language-test"),
    traceId: traceId.from("language-test"),
    configurationGeneration: generation,
  };
  const journal = createTurnEventJournal({
    eventStore: createInMemoryEventStore(),
    clock,
    streamId: streamId.from("language-test"),
    correlation,
  });
  const hooks = createToolHookRegistry(generation, []);
  if (!hooks.ok) throw new Error("hooks unavailable");
  const capabilities = createProductCapabilityRegistry(
    generation,
    tools.registry,
    [],
    (id) => tools.runner.hasBinding?.(id) === true,
  );
  let confirm = true;
  const disclosed = new Set<string>();
  const gateway = createProductToolGateway({
    clock,
    resources: createProductResources(clock),
    registry: tools.registry,
    runner: tools.runner,
    journal,
    correlation,
    turnId: turnId.from("language-test"),
    attemptId: "language-test",
    disclosedToolNames: disclosed,
    hooks: hooks.value,
    effectLedger: new Map(),
    confirmation: {
      resolve: async (request) =>
        confirm
          ? { kind: "confirmed", confirmationId: request.confirmationId }
          : { kind: "refused" },
    },
  });
  let sequence = 0;
  const run = (
    name: string,
    input: Readonly<Record<string, unknown>>,
    signal = new AbortController().signal,
  ) => {
    const entry = tools.registry.resolveByName(name);
    if (!entry) throw new Error(`missing ${name}`);
    const disclosure = discloseProductTools(capabilities, tools.registry, {
      task: name,
      preferredCapabilityIds: [entry.manifest.capabilityId],
    });
    expect(
      disclosure.modelTools.some((tool) => tool.name === name),
      JSON.stringify(disclosure.receipt.omitted),
    ).toBe(true);
    disclosed.add(name);
    sequence++;
    return gateway.execute({
      invocationId: invocationId.from(`language-${sequence}`),
      toolCallId: `language-${sequence}`,
      toolName: name,
      capabilityId: entry.manifest.capabilityId,
      version: 1,
      effect: entry.manifest.effect,
      input,
      signal,
    });
  };
  const reference = async (kind: "lsp" | "dap") =>
    first(
      z
        .array(z.object({ serviceId: z.string(), configurationDigest: z.string() }))
        .parse(value(await run(`${kind}_configurations`, {}))),
    );
  const start = async (kind: "lsp" | "dap") => {
    const ref = await reference(kind);
    const result = value(await run(`${kind}_start`, ref));
    const snapshot = z.object({ generation: z.number() }).parse(result);
    return { ...ref, generation: snapshot.generation };
  };
  return {
    root,
    queriesStarted: queriesStarted.promise,
    loseConfiguration: () => {
      unread = true;
    },
    configuration,
    lsp,
    dap,
    tools,
    run,
    start,
    reference,
    deny: () => {
      confirm = false;
    },
  };
}

function value(outcome: ToolInvocationOutcome): unknown {
  expect(outcome.status, JSON.stringify(outcome)).toBe("completed");
  if (outcome.status !== "completed") throw new Error("expected completion");
  return z.object({ value: z.object({ result: z.unknown() }) }).parse(outcome.output).value.result;
}

hostTest(
  "startup references reject drift, raw options, missing executables and denied authority",
  async () => {
    const f = await fixture();
    const reference = await f.reference("lsp");
    f.configuration.generation++;
    expect(await f.run("lsp_start", reference)).toMatchObject({
      status: "unavailable",
      reason: "stale-service-configuration",
    });
    expect(await f.run("lsp_start", { ...reference, executable: process.execPath })).toMatchObject({
      status: "malformed",
    });
    first(f.configuration.services.languageServers).executable = join(f.root, "missing-executable");
    expect(await f.run("lsp_start", await f.reference("lsp"))).toMatchObject({
      status: "failed",
      effect: "none",
    });
    first(f.configuration.services.languageServers).executable = process.execPath;
    f.deny();
    expect(await f.run("lsp_start", await f.reference("lsp"))).toMatchObject({
      status: "denied",
      effect: "none",
    });
    expect(
      f.lsp.snapshot(managedServiceId.from(reference.serviceId))?.state ?? "not-started",
    ).not.toBe("ready");
  },
);

hostTest(
  "all hierarchy references preserve extension data and reject changed documents and generations",
  async () => {
    const f = await fixture();
    const started = await f.start("lsp");
    const session = { serviceId: started.serviceId, generation: started.generation };
    const uri = pathToFileURL(join(f.root, "fixture.ts")).href;
    value(
      await f.run("lsp_open_document", {
        ...session,
        uri,
        languageId: "typescript",
        text: "const answer = 42;",
        version: 1,
      }),
    );
    const position = { ...session, uri, line: 0, character: 1 };
    const call = first(
      z
        .array(z.object({ itemRef: z.string() }))
        .parse(value(await f.run("lsp_call_hierarchy_prepare", position))),
    );
    const type = first(
      z
        .array(z.object({ itemRef: z.string() }))
        .parse(value(await f.run("lsp_type_hierarchy_prepare", position))),
    );
    for (const [name, ref] of [
      ["lsp_call_hierarchy_incoming", call],
      ["lsp_call_hierarchy_outgoing", call],
      ["lsp_type_hierarchy_supertypes", type],
      ["lsp_type_hierarchy_subtypes", type],
    ] as const)
      expect(value(await f.run(name, { ...session, ...ref }))).toEqual([]);
    value(
      await f.run("lsp_change_document", {
        ...session,
        uri,
        version: 2,
        contentChanges: [{ kind: "full", text: "const answer = 43;" }],
      }),
    );
    expect(await f.run("lsp_call_hierarchy_incoming", { ...session, ...call })).toMatchObject({
      status: "unavailable",
      reason: "stale-hierarchy-item",
    });
    const restarted = z
      .object({ generation: z.number() })
      .parse(value(await f.run("lsp_restart", started)));
    expect(restarted.generation).toBeGreaterThan(session.generation);
    expect(await f.run("lsp_hover", position)).toMatchObject({
      status: "unavailable",
      reason: "stale-language-server-generation",
    });
  },
);

hostTest(
  "debug target references reject unsupported options and preserve stopped-generation ordering",
  async () => {
    const f = await fixture();
    first(f.configuration.services.debugAdapters).targets.push({
      id: "unsupported",
      kind: "launch",
      configuration: { reject: true },
    });
    const started = await f.start("dap");
    expect(await f.run("dap_launch", { ...started, targetId: "unsupported" })).toMatchObject({
      status: "failed",
      reason: "unsupported",
      effect: "none",
    });
    expect(await f.run("dap_attach", { ...started, targetId: "fixture-target" })).toMatchObject({
      status: "unavailable",
      reason: "debug-target-configuration-not-found",
    });
    const launched = z
      .object({ session: z.object({ stopped: z.object({ generation: z.number() }) }) })
      .parse(value(await f.run("dap_launch", { ...started, targetId: "fixture-target" })));
    const stopped = {
      serviceId: started.serviceId,
      generation: started.generation,
      threadId: 1,
      stoppedGeneration: launched.session.stopped.generation,
    };
    const outcomes = await Promise.all([f.run("dap_next", stopped), f.run("dap_next", stopped)]);
    expect(outcomes.filter((result) => result.status === "completed")).toHaveLength(1);
    expect(outcomes.filter((result) => result.status === "unavailable")).toHaveLength(1);
    expect(await f.run("dap_stack_trace", { ...stopped, stoppedGeneration: 999 })).toMatchObject({
      status: "failed",
      reason: "stale-stopped-generation",
    });
    f.configuration.generation++;
    expect(
      await f.run("dap_threads", { serviceId: started.serviceId, generation: started.generation }),
    ).toMatchObject({ status: "unavailable", reason: "stale-service-configuration" });
    expect(
      value(
        await f.run("dap_disconnect", {
          serviceId: started.serviceId,
          generation: started.generation,
        }),
      ),
    ).toMatchObject({ state: "stopped" });
  },
);

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("fixture item missing");
  return item;
}

hostTest("concurrent language queries discard results after a document change", async () => {
  const f = await fixture();
  first(f.configuration.services.languageServers).environment.FALRYN_FIXTURE_HOVER_DELAY_MS = "200";
  const started = await f.start("lsp");
  const session = { serviceId: started.serviceId, generation: started.generation };
  const uri = pathToFileURL(join(f.root, "fixture.ts")).href;
  value(
    await f.run("lsp_open_document", {
      ...session,
      uri,
      languageId: "typescript",
      text: "old",
      version: 1,
    }),
  );
  const query = { ...session, uri, line: 0, character: 0 };
  const pending = [f.run("lsp_hover", query), f.run("lsp_hover", { ...query, character: 1 })];
  await f.queriesStarted;
  value(
    await f.run("lsp_change_document", {
      ...session,
      uri,
      version: 2,
      contentChanges: [{ kind: "full", text: "new" }],
    }),
  );
  const results = await Promise.all(pending);
  expect(results).toHaveLength(2);
  for (const result of results)
    expect(result).toMatchObject({ status: "unavailable", reason: "stale-document" });
});

hostTest("a lost target response stays uncertain and cannot start another target", async () => {
  const f = await fixture();
  const adapter = first(f.configuration.services.debugAdapters);
  adapter.environment.FALRYN_FIXTURE_DROP_TARGET_RESPONSE = "1";
  adapter.limits = { requestTimeoutMs: 25 };
  const started = await f.start("dap");
  expect(await f.run("dap_launch", { ...started, targetId: "fixture-target" })).toMatchObject({
    status: "uncertain",
    effect: "uncertain",
  });
  const snapshot = f.dap.snapshot(managedServiceId.from(started.serviceId));
  if (snapshot === null) throw new Error("adapter disappeared");
  expect(snapshot).toMatchObject({ state: "failed", failureReason: "target-start-uncertain" });
  expect(
    await f.dap.launch(snapshot.serviceId, snapshot.generation, {
      configuration: { program: "second" },
    }),
  ).toMatchObject({ ok: false, error: { code: "not-ready" } });
});

hostTest("cleanup remains available when configuration becomes unreadable", async () => {
  const f = await fixture();
  const started = await f.start("lsp");
  const session = { serviceId: started.serviceId, generation: started.generation };
  expect(
    await f.run("lsp_signature_help", {
      ...session,
      uri: pathToFileURL(join(f.root, "missing.ts")).href,
      line: 0,
      character: 0,
    }),
  ).toMatchObject({
    status: "unavailable",
    reason: "unsupported-capability:textDocument/signatureHelp",
  });
  expect(
    await f.run("lsp_hover", { ...session, uri: "file:///outside.ts", line: 0, character: 0 }),
  ).toMatchObject({ status: "unavailable", effect: "none" });
  f.loseConfiguration();
  expect(await f.run("lsp_configurations", {})).toMatchObject({
    status: "unavailable",
    reason: "service-configuration-unavailable",
  });
  expect(value(await f.run("lsp_shutdown", session))).toMatchObject({ state: "stopped" });
});

hostTest("cancelled startup never starts a process", async () => {
  const f = await fixture();
  const ref = await f.reference("dap");
  const controller = new AbortController();
  controller.abort();
  expect(await f.run("dap_start", ref, controller.signal)).toMatchObject({
    status: "cancelled",
    effect: "none",
  });
  expect(f.dap.snapshot(managedServiceId.from(ref.serviceId))).toBeNull();
});
