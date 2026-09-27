import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type McpConfiguration,
  McpLimitExceeded,
  type McpListChanges,
  type McpMethod,
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
    "tools/list": () => ({ tools: [{ name: "echo" }] }),
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
    entries: { tool: 1, resource: 2, "resource-template": 1, prompt: 1 },
  });
  expect(h.calls).toEqual([
    "tools/list",
    "resources/list",
    "resources/templates/list",
    "prompts/list",
  ]);
  const page = h.catalog.page({ limit: 2 });
  if (page.kind !== "completed") throw new Error(page.code);
  expect(page.value.entries.map((entry) => [entry.kind, entry.availability])).toEqual([
    ["tool", "available"],
    ["resource", "available"],
  ]);
  expect(page.value.entries[1]?.readHandle).toBe(
    mcpReadHandle("s", "docs://a", first.catalogGeneration ?? 0),
  );
  const cursor = page.value.nextCursor ?? "";
  const next = h.catalog.page({ limit: 2, cursor });
  expect(next.kind === "completed" && next.value.entries.map((entry) => entry.name)).toEqual([
    "b",
    "doc",
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
    throw new McpLimitExceeded("mcp-result-too-large");
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
