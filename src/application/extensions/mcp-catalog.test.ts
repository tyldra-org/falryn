import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type McpConfiguration,
  type McpListChanges,
  type McpMethod,
  McpRequestFailure,
  mcpConnectionSchema,
} from "../../domain/extensions/mcp.ts";
import { createMcpCatalog, mcpReadHandle } from "./mcp-catalog.ts";
import { createMcpLifecycle } from "./mcp-lifecycle.ts";

type Reply = (params: Readonly<Record<string, unknown>>) => unknown;
const scope = { workspaceId: "w", sessionId: "s", generation: "1" };

function harness() {
  let configuration: McpConfiguration = {
    generation: 1,
    servers: [
      mcpConnectionSchema.parse({ id: "s", transport: "stdio", executable: "/bin/fixture" }),
    ],
  };
  const calls: McpMethod[] = [];
  let changed: (listChanges: McpListChanges) => void = () => {};
  const replies: Partial<Record<McpMethod, Reply>> = {
    "tools/list": () => ({
      tools: [
        {
          name: "echo",
          annotations: { readOnlyHint: true },
          inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: { value: { type: "string", title: "Value" } },
            required: ["value"],
          },
        },
        {
          name: "union",
          inputSchema: { type: "object", properties: { v: { anyOf: [{ type: "string" }] } } },
        },
      ],
    }),
    "tools/call": (params) => ({
      content: [{ type: "text", text: JSON.stringify(params.arguments) }],
      structuredContent: { echoed: (params.arguments as Record<string, unknown>).value },
    }),
    "resources/list": () => ({
      resources: [
        { uri: "docs://a", name: "a", mimeType: "text/markdown" },
        { uri: "docs://b", name: "b" },
      ],
    }),
    "resources/templates/list": () => ({
      resourceTemplates: [{ uriTemplate: "docs://{id}", name: "doc" }],
    }),
    "prompts/list": () => ({
      prompts: [{ name: "review", arguments: [{ name: "topic", required: true }] }],
    }),
    "resources/read": (params) => ({
      contents: [{ uri: params.uri, mimeType: "text/plain", text: "body " + String(params.uri) }],
    }),
    "prompts/get": (params) => ({
      description: "Review",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Review " + String((params.arguments as Record<string, string>).topic),
          },
        },
        { role: "assistant", content: [{ type: "image", data: "AA==", mimeType: "image/png" }] },
      ],
    }),
  };
  const lifecycle = createMcpLifecycle({
    configuration: () => configuration,
    authorize: async () => true,
    clients: async ({ onCatalogChanged }) => {
      changed = onCatalogChanged;
      return {
        environmentGeneration: null,
        client: {
          current: () => true,
          async connect() {},
          catalog: () => ({
            features: ["tools", "resources", "prompts"] as const,
            listChanges: "observed" as const,
          }),
          async request(method, params) {
            calls.push(method);
            return replies[method]?.(params);
          },
          async close() {},
        },
      };
    },
  });
  const catalog = createMcpCatalog({ lifecycle, configuration: () => configuration });
  const call = () => ({
    origin: "user" as const,
    requestId: randomUUID(),
    deadline: Date.now() + 5_000,
    signal: new AbortController().signal,
  });
  return {
    catalog,
    lifecycle,
    calls,
    replies,
    call,
    change: (listChanges: McpListChanges = "observed") => changed(listChanges),
    configure(next: McpConfiguration) {
      configuration = next;
    },
    async connect() {
      const connected = await lifecycle.connect({
        ...call(),
        serverId: "s",
        configurationGeneration: configuration.generation,
      });
      expect(connected.kind).toBe("completed");
    },
    async discover() {
      const discovered = await catalog.discover("s", call());
      if (discovered.kind !== "completed") throw new Error(discovered.code);
      return discovered.value;
    },
  };
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("discovery publishes one generation and binds page cursors to it", async () => {
  const h = harness();
  expect(h.catalog.summaries()[0]).toMatchObject({ state: "unknown", catalogGeneration: null });
  expect((await h.catalog.discover("s", h.call())).kind).toBe("unavailable");
  await h.connect();
  const first = await h.discover();
  expect(first).toMatchObject({
    state: "current",
    listChanges: "observed",
    entries: { tool: 2, resource: 2, "resource-template": 1, prompt: 1 },
  });
  expect(h.calls).toEqual([
    "tools/list",
    "resources/list",
    "resources/templates/list",
    "prompts/list",
  ]);
  const page = h.catalog.page({ limit: 3 });
  if (page.kind !== "completed") throw new Error(page.code);
  expect(page.value.entries.map((entry) => [entry.kind, entry.availability])).toEqual([
    ["tool", "available"],
    ["tool", "unsupported"],
    ["resource", "available"],
  ]);
  expect(page.value.entries[2]?.readHandle).toBe(
    mcpReadHandle("s", "docs://a", first.catalogGeneration ?? 0),
  );
  // Pages are compact: tool schemas are omitted until one entry is selected.
  expect(page.value.entries[0]).toMatchObject({ detail: "compact", inputSchema: null });
  const cursor = page.value.nextCursor ?? "";
  const next = h.catalog.page({ limit: 3, cursor });
  expect(next.kind === "completed" && next.value.entries.map((entry) => entry.name)).toEqual([
    "b",
    "doc",
    "review",
  ]);
  expect(h.catalog.page({ limit: 3, cursor, kind: "prompt" })).toMatchObject({ kind: "malformed" });
  const second = await h.discover();
  expect(second.catalogGeneration).toBeGreaterThan(first.catalogGeneration ?? 0);
  expect(h.catalog.page({ limit: 2, cursor })).toMatchObject({
    kind: "stale",
    code: "mcp-catalog-cursor-stale",
  });
});

test("templates, reads and prompts use only their selected catalog generation", async () => {
  const h = harness();
  await h.connect();
  const generation = (await h.discover()).catalogGeneration ?? 0;
  const template = "mcp:s/resource-template/" + encodeURIComponent("docs://{id}");
  expect(h.catalog.resolveTemplate(template, generation, {})).toMatchObject({
    kind: "malformed",
    code: "mcp-argument-missing:id",
  });
  const resolved = h.catalog.resolveTemplate(template, generation, { id: "x y" });
  if (resolved.kind !== "completed") throw new Error(resolved.code);
  expect(resolved.value.uri).toBe("docs://x%20y");
  const handle = resolved.value.readHandle;
  expect((await h.catalog.resources.authorize(handle, scope)).ok).toBe(true);
  const described = await h.catalog.resources.reader.describe(handle);
  if (!described.ok) throw new Error(described.error.code);
  expect(described.value).toMatchObject({ uri: handle, mediaType: "text/plain", exactBytes: true });
  const bytes = await h.catalog.resources.reader.readRange(handle, 0, 64);
  expect(bytes.ok && text(bytes.value)).toBe("body docs://x%20y");
  const unlisted = mcpReadHandle("s", "docs://never-listed", generation);
  expect(await h.catalog.resources.reader.describe(unlisted)).toEqual({
    ok: false,
    error: { code: "not-found" },
  });

  const prompt = "mcp:s/prompt/review";
  expect(await h.catalog.getPrompt(prompt, generation, { other: "x" }, h.call())).toMatchObject({
    kind: "malformed",
    code: "mcp-argument-unknown:other",
  });
  const got = await h.catalog.getPrompt(prompt, generation, { topic: "notes" }, h.call());
  expect(got.kind === "completed" && got.value.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "Review notes" }] },
    { role: "assistant", content: [{ type: "unsupported", contentType: "image" }] },
  ]);

  const before = h.calls.length;
  h.change();
  h.change();
  expect(h.catalog.summaries()[0]).toMatchObject({ state: "stale", code: "mcp-catalog-changed" });
  expect(await h.catalog.resources.reader.describe(handle)).toEqual({
    ok: false,
    error: { code: "stale" },
  });
  expect(await h.catalog.getPrompt(prompt, generation, { topic: "x" }, h.call())).toMatchObject({
    kind: "stale",
  });
  expect(h.catalog.resolveTemplate(template, generation, { id: "x" })).toMatchObject({
    kind: "stale",
  });
  const stale = h.catalog.page({});
  expect(
    stale.kind === "completed" &&
      stale.value.entries.every(
        (entry) => entry.availability === "stale" && entry.readHandle === null,
      ),
  ).toBe(true);
  expect(h.calls.length).toBe(before);

  // The same name in the next generation is never selected through an old handle.
  const next = (await h.discover()).catalogGeneration ?? 0;
  expect(next).not.toBe(generation);
  expect(await h.catalog.getPrompt(prompt, generation, { topic: "x" }, h.call())).toMatchObject({
    kind: "stale",
  });
  expect((await h.catalog.getPrompt(prompt, next, { topic: "x" }, h.call())).kind).toBe(
    "completed",
  );
  expect(
    (await h.catalog.resources.reader.describe(mcpReadHandle("s", "docs://a", generation))).ok,
  ).toBe(false);
});

test("a failed refresh keeps the last snapshot as stale evidence", async () => {
  const h = harness();
  const working = h.replies["prompts/list"];
  if (!working) throw new Error("fixture reply missing");
  h.replies["prompts/list"] = () => {
    throw new Error("down");
  };
  await h.connect();
  expect((await h.catalog.discover("s", h.call())).kind).toBe("failed");
  expect(h.catalog.summaries()[0]).toMatchObject({
    state: "unknown",
    code: "mcp-catalog-refresh-mcp-request-failed",
  });
  h.replies["prompts/list"] = working;
  const published = await h.discover();
  h.replies["prompts/list"] = () => {
    throw new Error("down");
  };
  expect((await h.catalog.discover("s", h.call())).kind).toBe("failed");
  expect(h.catalog.summaries()[0]).toMatchObject({
    state: "stale",
    code: "mcp-catalog-refresh-mcp-request-failed",
    catalogGeneration: published.catalogGeneration,
    entries: published.entries,
  });
});

test("reads require one exact item and removal revokes the server", async () => {
  const h = harness();
  await h.connect();
  const generation = (await h.discover()).catalogGeneration ?? 0;
  const handle = mcpReadHandle("s", "docs://a", generation);
  h.replies["resources/read"] = () => ({
    contents: [
      { uri: "docs://a", text: "one" },
      { uri: "docs://a", text: "two" },
    ],
  });
  expect(await h.catalog.resources.reader.describe(handle)).toEqual({
    ok: false,
    error: { code: "unsupported" },
  });
  h.replies["resources/read"] = () => ({ contents: [{ uri: "docs://other", text: "x" }] });
  expect(await h.catalog.resources.reader.describe(handle)).toEqual({
    ok: false,
    error: { code: "failed" },
  });
  h.replies["resources/read"] = () => ({
    contents: [{ uri: "docs://a", blob: Buffer.from([0, 1, 2]).toString("base64") }],
  });
  const described = await h.catalog.resources.reader.describe(handle);
  expect(described.ok && described.value).toMatchObject({
    mediaType: "application/octet-stream",
    byteLength: 3,
  });
  h.replies["prompts/get"] = () => {
    throw new McpRequestFailure("mcp-result-too-large");
  };
  expect(
    await h.catalog.getPrompt("mcp:s/prompt/review", generation, { topic: "x" }, h.call()),
  ).toMatchObject({ kind: "failed", code: "mcp-result-too-large" });

  await h.lifecycle.stop("s");
  expect(h.catalog.summaries()[0]).toMatchObject({ state: "stale", code: "mcp-server-stopped" });
  expect((await h.catalog.resources.authorize(handle, scope)).ok).toBe(true);
  h.configure({ generation: 2, servers: [] });
  expect(await h.catalog.resources.authorize(handle, scope)).toEqual({
    ok: false,
    error: { code: "mcp-server-revoked" },
  });
});

test("a list change during a read or prompt fences its result", async () => {
  const h = harness();
  await h.connect();
  const generation = (await h.discover()).catalogGeneration ?? 0;
  const read = h.replies["resources/read"];
  const prompt = h.replies["prompts/get"];
  h.replies["resources/read"] = (params) => {
    h.change();
    return read?.(params);
  };
  expect(
    await h.catalog.resources.reader.describe(mcpReadHandle("s", "docs://a", generation)),
  ).toEqual({ ok: false, error: { code: "stale" } });
  await h.discover();
  const next = h.catalog.summaries()[0]?.catalogGeneration ?? 0;
  h.replies["prompts/get"] = (params) => {
    h.change();
    return prompt?.(params);
  };
  expect(
    await h.catalog.getPrompt("mcp:s/prompt/review", next, { topic: "x" }, h.call()),
  ).toMatchObject({ kind: "stale", code: "mcp-catalog-changed-during-request" });
  // A lost subscription marks the catalog stale once and reports list changes as unobserved.
  await h.discover();
  h.change("unobserved");
  expect(h.catalog.summaries()[0]).toMatchObject({
    state: "stale",
    code: "mcp-catalog-changed",
    listChanges: "unobserved",
  });
  expect(await h.discover()).toMatchObject({ state: "current", listChanges: "unobserved" });
});

test("tool selection returns the normalized schema and calls validate before one dispatch", async () => {
  const h = harness();
  await h.connect();
  const generation = (await h.discover()).catalogGeneration ?? 0;
  const echo = "mcp:s/tool/echo";
  const selected = h.catalog.page({ entryId: echo });
  if (selected.kind !== "completed") throw new Error(selected.code);
  expect(selected.value.entries).toHaveLength(1);
  expect(selected.value.entries[0]).toMatchObject({
    detail: "complete",
    availability: "available",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  });
  expect(h.catalog.page({ entryId: "mcp:s/tool/missing" })).toMatchObject({
    kind: "unavailable",
    code: "mcp-catalog-entry-unknown",
  });

  const before = h.calls.length;
  for (const values of [{}, { value: 1 }, { value: "x", extra: true }])
    expect(await h.catalog.callTool(echo, generation, values, h.call())).toMatchObject({
      kind: "malformed",
      code: "mcp-tool-arguments-invalid",
    });
  expect(await h.catalog.callTool("mcp:s/tool/union", generation, {}, h.call())).toMatchObject({
    kind: "unsupported",
    code: "mcp-tool-schema-unsupported",
  });
  expect(h.calls.length).toBe(before);

  const called = await h.catalog.callTool(echo, generation, { value: "hi" }, h.call());
  if (called.kind !== "completed") throw new Error(called.code);
  expect(called.value).toMatchObject({
    entryId: echo,
    catalogGeneration: generation,
    isError: false,
    structuredContent: { echoed: "hi" },
  });
  expect(called.value.schemaDigest).toMatch(/^sha256:/u);
  expect(h.calls.filter((method) => method === "tools/call")).toHaveLength(1);

  h.replies["tools/call"] = () => ({ isError: true, content: [{ type: "text", text: "bad" }] });
  const reported = await h.catalog.callTool(echo, generation, { value: "hi" }, h.call());
  expect(reported.kind === "completed" && reported.value.isError).toBe(true);
  h.replies["tools/call"] = () => ({ content: "not a list" });
  expect(await h.catalog.callTool(echo, generation, { value: "hi" }, h.call())).toMatchObject({
    kind: "failed",
    code: "mcp-tool-result-malformed",
    effect: "uncertain",
  });
  h.replies["tools/call"] = () => {
    throw new McpRequestFailure("mcp-input-required-unavailable");
  };
  expect(await h.catalog.callTool(echo, generation, { value: "hi" }, h.call())).toMatchObject({
    kind: "failed",
    code: "mcp-input-required-unavailable",
    effect: "uncertain",
  });
});

test("stale, changed and revoked tool selections fail before any call", async () => {
  const h = harness();
  await h.connect();
  const generation = (await h.discover()).catalogGeneration ?? 0;
  const echo = "mcp:s/tool/echo";
  const calls = () => h.calls.filter((method) => method === "tools/call").length;
  h.change();
  expect(await h.catalog.callTool(echo, generation, { value: "x" }, h.call())).toMatchObject({
    kind: "stale",
    code: "mcp-catalog-entry-stale",
  });
  const next = (await h.discover()).catalogGeneration ?? 0;
  expect((await h.catalog.callTool(echo, next, { value: "x" }, h.call())).kind).toBe("completed");
  expect(calls()).toBe(1);
  h.configure({ generation: 2, servers: [] });
  expect(await h.catalog.callTool(echo, next, { value: "x" }, h.call())).toMatchObject({
    kind: "stale",
  });
  expect(calls()).toBe(1);
});

test("published catalog tools follow current state; bursts only mark them stale (#1157)", async () => {
  const h = harness();
  expect(h.catalog.currentTools()).toEqual([]);
  await h.connect();
  const discovered = await h.catalog.discover("s", h.call());
  // tools, resources, resource templates and prompts: one list request each.
  expect(discovered).toMatchObject({ kind: "completed", requests: 4 });
  const current = h.catalog.currentTools();
  expect(current.map((item) => item.entry.name)).toEqual(["echo", "union"]);
  const sent = h.calls.length;
  for (let index = 0; index < 5; index++) h.change();
  // A burst publishes nothing and asks the server nothing; the catalog is just stale.
  expect(h.catalog.currentTools()).toEqual([]);
  expect(h.catalog.summaries()[0]).toMatchObject({ state: "stale", code: "mcp-catalog-changed" });
  expect(h.calls).toHaveLength(sent);
  await h.catalog.discover("s", h.call());
  expect(h.catalog.currentTools()).toHaveLength(2);
});

test("a schema digest that changed after publication fails before dispatch (#1157)", async () => {
  const h = harness();
  await h.connect();
  const generation = (await h.discover()).catalogGeneration ?? 0;
  const [echo] = h.catalog.currentTools();
  if (!echo?.entry.schemaDigest) throw new Error("missing echo");
  const calls = () => h.calls.filter((method) => method === "tools/call").length;
  expect(
    await h.catalog.callTool(echo.entry.id, generation, { value: "x" }, h.call(), {
      expectedSchemaDigest: "sha-256:other",
    }),
  ).toMatchObject({ kind: "stale", code: "mcp-tool-schema-changed", effect: "none" });
  expect(calls()).toBe(0);
  expect(
    (
      await h.catalog.callTool(echo.entry.id, generation, { value: "x" }, h.call(), {
        expectedSchemaDigest: echo.entry.schemaDigest,
      })
    ).kind,
  ).toBe("completed");
  expect(calls()).toBe(1);
});

describe("tool calls that need user input", () => {
  const FORM = {
    method: "elicitation/create",
    params: {
      mode: "form",
      message: "Which branch?",
      requestedSchema: {
        type: "object",
        properties: { branch: { type: "string", enum: ["main", "next"] } },
        required: ["branch"],
      },
    },
  };
  const echo = "mcp:s/tool/echo";
  /** A server that asks once, then echoes what it was sent. */
  async function asking(ask?: (params: Readonly<Record<string, unknown>>) => unknown) {
    const h = harness();
    const sent: Readonly<Record<string, unknown>>[] = [];
    h.replies["tools/call"] = (params) => {
      sent.push(params);
      if (ask) return ask(params);
      return params.inputResponses === undefined
        ? {
            resultType: "input_required",
            inputRequests: { confirm: FORM },
            requestState: "opaque-1",
          }
        : { content: [{ type: "text", text: "done" }] };
    };
    await h.connect();
    const generation = (await h.discover()).catalogGeneration ?? 0;
    return { h, sent, generation };
  }

  test("an accepted answer is retried with the verbatim state and leaves only a receipt", async () => {
    const { h, sent, generation } = await asking();
    const events: unknown[] = [];
    const asked: unknown[] = [];
    const called = await h.catalog.callTool(echo, generation, { value: "hi" }, h.call(), {
      ask: async (request) => {
        asked.push(request.form.fields.map((field) => field.name));
        return {
          response: { action: "accept", content: { branch: "next" } },
          disposition: "accept",
        };
      },
      observe: (event) => events.push(event),
    });
    expect(asked).toEqual([["branch"]]);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      name: "echo",
      arguments: { value: "hi" },
      inputResponses: { confirm: { action: "accept", content: { branch: "next" } } },
      requestState: "opaque-1",
    });
    expect(called).toMatchObject({
      kind: "completed",
      value: {
        content: [{ type: "text", text: "done" }],
        inputRounds: [{ round: 1, key: "confirm", disposition: "accept" }],
      },
    });
    const digest = called.kind === "completed" ? called.value.inputRounds[0]?.schemaDigest : "";
    expect(digest).toMatch(/^sha256:/u);
    expect(events).toMatchObject([
      { point: "mcp.elicitation", payload: { serverId: "s", schemaDigest: digest } },
      { point: "mcp.elicitation.result", payload: { serverId: "s", disposition: "accept" } },
    ]);
    // Neither the receipts nor the hook payloads carry the answer.
    expect(JSON.stringify([called, events])).not.toContain("next");
  });

  test("without a way to ask, each request is cancelled, never answered", async () => {
    const { h, sent, generation } = await asking();
    const called = await h.catalog.callTool(echo, generation, { value: "hi" }, h.call());
    expect(sent[1]?.inputResponses).toEqual({ confirm: { action: "cancel" } });
    expect(called).toMatchObject({
      kind: "completed",
      value: { inputRounds: [{ disposition: "cancel" }] },
    });
  });

  test("a refusal declines", async () => {
    const { h, sent, generation } = await asking();
    await h.catalog.callTool(echo, generation, { value: "hi" }, h.call(), {
      ask: async () => ({ response: { action: "decline" }, disposition: "decline" }),
    });
    expect(sent[1]?.inputResponses).toEqual({ confirm: { action: "decline" } });
  });

  test("an unsupported request ends the call uncertain without asking or retrying", async () => {
    const { h, sent, generation } = await asking(() => ({
      resultType: "input_required",
      inputRequests: {
        visit: {
          method: "elicitation/create",
          params: { mode: "url", message: "Go", url: "https://x.test", elicitationId: "v" },
        },
      },
    }));
    let asked = 0;
    const called = await h.catalog.callTool(echo, generation, { value: "hi" }, h.call(), {
      ask: async () => {
        asked++;
        return { response: { action: "cancel" }, disposition: "cancel" };
      },
    });
    expect(called).toEqual({
      kind: "failed",
      code: "mcp-input-request-unsupported",
      effect: "uncertain",
    });
    expect([asked, sent.length]).toEqual([0, 1]);
  });

  test("a server that keeps asking is stopped after four answered rounds", async () => {
    let round = 0;
    const { h, sent, generation } = await asking(() => ({
      resultType: "input_required",
      inputRequests: { confirm: FORM },
      requestState: `round-${++round}`,
    }));
    let asked = 0;
    const called = await h.catalog.callTool(echo, generation, { value: "hi" }, h.call(), {
      ask: async () => {
        asked++;
        return {
          response: { action: "accept", content: { branch: "main" } },
          disposition: "accept",
        };
      },
    });
    expect(called).toEqual({
      kind: "failed",
      code: "mcp-input-rounds-exceeded",
      effect: "uncertain",
    });
    expect([asked, sent.length]).toEqual([4, 5]);
    expect(sent.map((params) => params.requestState ?? null)).toEqual([
      null,
      "round-1",
      "round-2",
      "round-3",
      "round-4",
    ]);
  });

  test("a catalog change while the question is open withdraws it and sends nothing stale", async () => {
    const { h, sent, generation } = await asking();
    const called = await h.catalog.callTool(echo, generation, { value: "hi" }, h.call(), {
      ask: (request) =>
        new Promise((resolve) => {
          h.change();
          // The open question is withdrawn as soon as the catalog stops being current.
          request.signal.addEventListener("abort", () =>
            resolve({ response: { action: "cancel" }, disposition: "cancel" }),
          );
        }),
    });
    expect(called).toEqual({ kind: "stale", code: "mcp-catalog-entry-stale", effect: "uncertain" });
    expect(sent).toHaveLength(1);
  });

  test("a disconnect while the question is open withdraws it and sends nothing", async () => {
    const { h, sent, generation } = await asking();
    const called = await h.catalog.callTool(echo, generation, { value: "hi" }, h.call(), {
      ask: (request) =>
        new Promise((resolve) => {
          void h.lifecycle.stop("s");
          request.signal.addEventListener("abort", () =>
            resolve({ response: { action: "cancel" }, disposition: "cancel" }),
          );
        }),
    });
    expect(called).toEqual({ kind: "stale", code: "mcp-catalog-entry-stale", effect: "uncertain" });
    expect(sent).toHaveLength(1);
  });

  test("an abandoned call sends no answer", async () => {
    const { h, sent, generation } = await asking();
    const abort = new AbortController();
    const called = await h.catalog.callTool(
      echo,
      generation,
      { value: "hi" },
      { ...h.call(), signal: abort.signal },
      {
        ask: async () => {
          abort.abort();
          return {
            response: { action: "accept", content: { branch: "main" } },
            disposition: "accept",
          };
        },
      },
    );
    expect(called).toEqual({ kind: "cancelled", code: "mcp-call-cancelled", effect: "uncertain" });
    expect(sent).toHaveLength(1);
  });
  test("a credential rejected while an answer waits ends the call uncertain and resends nothing", async () => {
    const { h, sent, generation } = await asking((params) => {
      if (params.inputResponses === undefined)
        return { resultType: "input_required", inputRequests: { confirm: FORM } };
      // The credential was revoked while the question was open.
      throw new McpRequestFailure("mcp-auth-rejected", true);
    });
    const called = await h.catalog.callTool(echo, generation, { value: "hi" }, h.call(), {
      ask: async () => ({
        response: { action: "accept", content: { branch: "main" } },
        disposition: "accept",
      }),
    });
    // The server saw the call before it asked, so the call's effect stays uncertain.
    expect(called).toEqual({ kind: "denied", code: "mcp-auth-rejected", effect: "uncertain" });
    expect(sent).toHaveLength(2);
    expect(h.lifecycle.inspect()[0]).toMatchObject({ state: "denied", code: "mcp-auth-rejected" });
    // A valid reconnect starts a new generation; the answer is never sent again.
    await h.connect();
    expect(sent).toHaveLength(2);
    expect(await h.catalog.callTool(echo, generation, { value: "hi" }, h.call())).toMatchObject({
      kind: "stale",
      effect: "none",
    });
  });
});
