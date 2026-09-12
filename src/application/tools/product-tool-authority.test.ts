import { expect, test } from "bun:test";
import { z } from "zod";
import {
  configurationGeneration,
  createManualClock,
  instant,
  invocationId,
  modelId,
  providerId,
  sessionId,
  streamId,
  traceId,
  turnId,
  workspaceId,
} from "../../domain/foundation/index.ts";
import { createStubCommandRunner } from "../../domain/process/index.ts";
import { createInMemoryEventStore } from "../../domain/sessions/index.ts";
import { createToolHookRegistry } from "../../domain/tools/index.ts";
import { createInMemoryFileSystem, localPath } from "../../domain/workspace/index.ts";
import { responseBody } from "../../integrations/providers/openai-responses-sdk-adapter/requests.ts";
import { modelRequestId } from "../../providers/configuration/identity.ts";
import { OPENAI_RESPONSES_TRANSPORT_DEFAULT } from "../../providers/configuration/transport-compatibility.ts";
import { createMemoryRecords } from "../memory/memory-record.ts";
import { createProductResources } from "../orchestration/product-resources.ts";
import { createTurnEventJournal } from "../runtime/turn-event-journal.ts";
import { createProductToolGateway } from "../tools/product-tool-gateway.ts";
import { composeProductMemoryTools } from "../tools/product-tools-memory.ts";
import { composeProductWorkspaceTools } from "../tools/product-tools-workspace.ts";

const generation = configurationGeneration.from(3);

test("newly disclosed schemas satisfy strict Responses requirements", () => {
  const tools = composeProductWorkspaceTools({
    generation,
    fileSystem: createInMemoryFileSystem(),
    commands: createStubCommandRunner(() => ({ kind: "exited", exitCode: 0, stdout: "" })),
    workspaceRoot: localPath("/work"),
  });
  const defs = tools.toolNames.map((name) => {
    const entry = tools.registry.resolveByName(name);
    if (!entry) throw new Error("missing tool");
    const manifest = entry.manifest;
    return {
      name,
      description: manifest.description,
      parameters: z.toJSONSchema(manifest.inputSchema),
    };
  });
  const body = responseBody(
    {
      requestId: modelRequestId.from("req-probe"),
      providerId: providerId.from("openai"),
      modelId: modelId.from("gpt-test"),
      messages: [{ role: "user", parts: [{ kind: "text", text: "edit" }] }],
      tools: defs,
      output: { kind: "text" },
      budgets: {},
      metadata: { role: "default" },
    },
    OPENAI_RESPONSES_TRANSPORT_DEFAULT,
    new Map(),
  );
  const errors: string[] = [];
  function visit(value: unknown, path: string) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const s = value as Record<string, unknown>;
    if (s.type === "object") {
      for (const key of Object.keys((s.properties ?? {}) as Record<string, unknown>))
        if (!(Array.isArray(s.required) ? s.required : []).includes(key))
          errors.push(`${path}.${key} not required`);
    }
    for (const [key, v] of Object.entries(s))
      if (v && typeof v === "object") {
        if (Array.isArray(v))
          v.forEach((e, i) => {
            if (e && typeof e === "object") visit(e, `${path}/${key}/${i}`);
          });
        else visit(v, `${path}/${key}`);
      }
  }
  for (const tool of body.tools ?? []) {
    if (tool.type !== "function") continue;
    expect(tool.strict).toBe(true);
    if (tool.parameters?.type !== "object") errors.push(`${tool.name} has no root object type`);
    visit(tool.parameters, tool.name);
  }
  expect(errors).toEqual([]);
});

test("memory recall cannot select another workspace or raise sensitivity", async () => {
  const records = createMemoryRecords();
  const record = records.define({
    memoryId: "other-workspace-memory",
    scope: { kind: "workspace", workspaceId: "other-workspace" },
    kind: "project-fact",
    subject: "private fixture",
    content: "other workspace fixture content",
    sensitivity: "sensitive",
    provenance: [{ origin: "user-request", locator: "turn:fixture" }],
    confidence: 90,
    createdAt: "2026-09-11T00:00:00.000Z",
  });
  expect(record.ok).toBe(true);
  expect(
    records.define({
      memoryId: "current",
      scope: { kind: "workspace", workspaceId: "current-workspace" },
      kind: "project-fact",
      subject: "local",
      content: "permitted current workspace fact",
      confidence: 90,
      provenance: [{ origin: "user-request", locator: "turn:fixture" }],
      createdAt: "2026-09-11T00:00:00.000Z",
    }).ok,
  ).toBe(true);
  const tools = composeProductMemoryTools({
    generation,
    records,
    workspaceId: "current-workspace",
  });
  const clock = createManualClock(instant(100));
  const correlation = {
    workspaceId: workspaceId.from("current-workspace"),
    sessionId: sessionId.from("session-probe"),
    traceId: traceId.from("trace-probe"),
    configurationGeneration: generation,
  };
  const hooks = createToolHookRegistry(generation, []);
  if (!hooks.ok) throw Error("hooks");
  const gateway = createProductToolGateway({
    clock,
    resources: createProductResources(clock),
    registry: tools.registry,
    runner: tools.runner,
    hooks: hooks.value,
    journal: createTurnEventJournal({
      eventStore: createInMemoryEventStore(),
      clock,
      streamId: streamId.from("session:probe"),
      correlation,
    }),
    correlation,
    turnId: turnId.from("turn-probe"),
    disclosedToolNames: new Set(["memory_recall"]),
    effectLedger: new Map(),
  });
  const entry = tools.registry.resolveByName("memory_recall");
  if (!entry) throw new Error("missing memory tool");
  const manifest = entry.manifest;
  const call = (input: Readonly<Record<string, unknown>>, id: string) =>
    gateway.execute({
      invocationId: invocationId.from(id),
      toolCallId: id,
      toolName: "memory_recall",
      capabilityId: manifest.capabilityId,
      version: manifest.version,
      effect: manifest.effect,
      input,
      signal: new AbortController().signal,
    });
  const scoped = await call({}, "call-scoped");
  expect(scoped.status).toBe("completed");
  expect(JSON.stringify(scoped)).toContain("permitted current workspace fact");
  expect(JSON.stringify(scoped)).not.toContain("other workspace fixture content");
  const cross = await call(
    { workspaceId: "other-workspace", destination: "sensitive" },
    "call-cross",
  );
  expect(JSON.stringify(cross)).not.toContain("other workspace fixture content");
});

test("observation search cannot select an arbitrary executable", async () => {
  const calls: unknown[] = [];
  const tools = composeProductWorkspaceTools({
    generation,
    fileSystem: createInMemoryFileSystem({ nodes: { "/work": { kind: "directory" } } }),
    commands: createStubCommandRunner((input) => {
      calls.push(input);
      return { kind: "exited", exitCode: 0, stdout: "" };
    }),
    workspaceRoot: localPath("/work"),
  });
  const clock = createManualClock(instant(100));
  const correlation = {
    workspaceId: workspaceId.from("current-workspace"),
    sessionId: sessionId.from("session-search"),
    traceId: traceId.from("trace-search"),
    configurationGeneration: generation,
  };
  const hooks = createToolHookRegistry(generation, []);
  if (!hooks.ok) throw Error("hooks");
  const gateway = createProductToolGateway({
    clock,
    resources: createProductResources(clock),
    registry: tools.registry,
    runner: tools.runner,
    hooks: hooks.value,
    journal: createTurnEventJournal({
      eventStore: createInMemoryEventStore(),
      clock,
      streamId: streamId.from("session:search"),
      correlation,
    }),
    correlation,
    turnId: turnId.from("turn-search"),
    disclosedToolNames: new Set(["search_text"]),
    effectLedger: new Map(),
  });
  const entry = tools.registry.resolveByName("search_text");
  if (!entry) throw new Error("missing search tool");
  const manifest = entry.manifest;
  expect(manifest.effect).toBe("observation");
  const result = await gateway.execute({
    invocationId: invocationId.from("call-search"),
    toolCallId: "call-search",
    toolName: "search_text",
    capabilityId: manifest.capabilityId,
    version: manifest.version,
    effect: manifest.effect,
    input: { query: "needle", ripgrepExecutable: "/work/repo-supplied-executable" },
    signal: new AbortController().signal,
  });
  expect(result.status).not.toBe("completed");
  expect(calls).toHaveLength(0);
});
