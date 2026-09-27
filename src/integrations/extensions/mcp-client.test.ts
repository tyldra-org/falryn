import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createSecretResolver } from "../../application/authentication/credential-resolver.ts";
import { createMcpLifecycle } from "../../application/extensions/mcp-lifecycle.ts";
import {
  type McpAdmission,
  type McpConnection,
  type McpSnapshot,
  mcpConnectionSchema,
} from "../../domain/extensions/mcp.ts";
import { createSystemClock } from "../../domain/foundation/index.ts";
import {
  type CredentialStorePort,
  createInMemoryCredentialStore,
} from "../../domain/security/credential.ts";
import { createHostManagedServicePort } from "../process/host-process-sessions/managed-service.ts";
import { createHostMcpClient } from "./mcp-client.ts";
import { mcpFixtureReply } from "./mcp-fixtures.ts";

const posix = process.platform === "win32" ? test.skip : test;
const cleanup: (() => Promise<unknown> | undefined)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const fixture = fileURLToPath(new URL("./mcp-fixtures.ts", import.meta.url));
/** An environment store over a mutable map, so a test can rotate a secret. */
function rotatingStore(secrets: Record<string, string>): CredentialStorePort {
  return {
    storeKind: "environment",
    availability: () => ({ kind: "available" }),
    read: (reference, use, options) =>
      createInMemoryCredentialStore({ storeKind: "environment", secrets }).read(
        reference,
        use,
        options,
      ),
    removeSecret: async () => ({ result: "unsupported", code: null }),
  };
}
function setup(server: McpConnection, ...others: McpConnection[]) {
  let configuration = { generation: 1, servers: [server, ...others] };
  let trusted = true;
  const services = createHostManagedServicePort();
  const events: string[] = [];
  const snapshots: McpSnapshot[] = [];
  const secrets: Record<string, string> = { MCP_TEST_TOKEN: "private-token" };
  const lifecycle = createMcpLifecycle({
    configuration: () => configuration,
    authorize: async () => trusted,
    observe: (snapshot) => {
      events.push(snapshot.state);
      snapshots.push(snapshot);
    },
    jitter: () => 0,
    clients: createHostMcpClient({
      identity: crypto.randomUUID(),
      services: () => services,
      credentials: createSecretResolver({
        stores: [rotatingStore(secrets)],
        clock: createSystemClock(),
      }),
      environmentGeneration: () => "env-1",
    }),
  });
  cleanup.push(lifecycle.close);
  return {
    lifecycle,
    events,
    snapshots,
    secrets,
    replace(next: McpConnection) {
      configuration = {
        generation: configuration.generation + 1,
        servers: configuration.servers.map((server) => (server.id === next.id ? next : server)),
      };
    },
    add(server: McpConnection) {
      configuration = {
        generation: configuration.generation + 1,
        servers: [...configuration.servers, server],
      };
    },
    revoke() {
      trusted = false;
    },
  };
}
function admission(serverId = "fixture", signal = new AbortController().signal): McpAdmission {
  return {
    serverId,
    configurationGeneration: 1,
    origin: "user",
    requestId: crypto.randomUUID(),
    deadline: Date.now() + 2000,
    signal,
  };
}
function stdio(mode = "normal") {
  return mcpConnectionSchema.parse({
    id: "fixture",
    transport: "stdio",
    executable: process.execPath,
    args: [fixture, mode],
  });
}

posix("stdio discovery, concurrent correlation, cancellation, and owned shutdown", async () => {
  const { lifecycle, events } = setup(stdio());
  expect(lifecycle.inspect()[0]?.state).toBe("unqueried");
  const ready = await lifecycle.connect(admission());
  expect(ready.kind).toBe("completed");
  if (ready.kind !== "completed") return;
  const results = await Promise.all(
    ["a", "b"].map((value) =>
      lifecycle.request(admission(), ready.snapshot.transportGeneration, "tools/call", {
        name: "echo",
        arguments: { value },
      }),
    ),
  );
  expect(results.map((result) => result.kind)).toEqual(["completed", "completed"]);
  expect(JSON.stringify(results[0])).toContain("a");
  expect(JSON.stringify(results[1])).toContain("b");
  expect((await lifecycle.stop("fixture")).kind).toBe("completed");
  expect(events).toContain("available");
  expect(lifecycle.inspect()[0]?.state).toBe("stopped");
});
posix.each(["malformed", "oversized", "silent"])("bounded startup failure: %s", async (mode) => {
  const { lifecycle } = setup(stdio(mode));
  const result = await lifecycle.connect({ ...admission(), deadline: Date.now() + 150 });
  expect(result.kind).not.toBe("completed");
  expect(lifecycle.inspect()[0]?.state).toBe("failed");
});
posix("cancelled uncertain effect is never resent; a generation remains isolated", async () => {
  const { lifecycle } = setup(stdio("pending"));
  const ready = await lifecycle.connect(admission());
  expect(ready.kind).toBe("completed");
  if (ready.kind !== "completed") return;
  const abort = new AbortController();
  const result = lifecycle.request(
    admission("fixture", abort.signal),
    ready.snapshot.transportGeneration,
    "tools/call",
    { name: "echo" },
  );
  setTimeout(() => abort.abort(), 20);
  expect(await result).toMatchObject({ kind: "cancelled", effect: "uncertain" });
  expect(lifecycle.inspect()[0]?.pending).toBe(0);
});
test("disabled, explicit-only model and revoked trust start no transport", async () => {
  const s = setup({ ...stdio(), explicitOnly: true });
  expect(await s.lifecycle.connect({ ...admission(), origin: "model" })).toMatchObject({
    kind: "denied",
  });
  expect(s.events).toEqual([]);
  s.revoke();
  expect(await s.lifecycle.connect(admission())).toMatchObject({ kind: "denied" });
});
test("HTTP current protocol uses routing headers, rejects redirects and fences changed configuration", async () => {
  const requests: { method: string; headers: Headers }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const message = (await request.json()) as Record<string, unknown>;
      requests.push({ method: String(message.method), headers: request.headers });
      return Response.json(mcpFixtureReply(message));
    },
  });
  cleanup.push(() => server.stop(true));
  const config = mcpConnectionSchema.parse({
    id: "fixture",
    transport: "http",
    url: `http://127.0.0.1:${server.port}/mcp`,
    credentialEnvironment: "MCP_TEST_TOKEN",
  });
  const s = setup(config);
  const ready = await s.lifecycle.connect(admission());
  expect(ready.kind).toBe("completed");
  if (ready.kind !== "completed") return;
  // The fixture closes the list-change subscription unacknowledged: usable, but unobserved.
  expect(ready.snapshot.listChanges).toBe("unobserved");
  expect(
    (await s.lifecycle.request(admission(), ready.snapshot.transportGeneration, "tools/list", {}))
      .kind,
  ).toBe("completed");
  expect(requests.map((request) => request.method)).toEqual([
    "server/discover",
    "subscriptions/listen",
    "tools/list",
  ]);
  expect(requests[2]?.headers.get("mcp-protocol-version")).toBe("2026-07-28");
  expect(requests[2]?.headers.get("mcp-method")).toBe("tools/list");
  expect(requests[2]?.headers.get("mcp-session-id")).toBeNull();
  s.replace({ ...config, enabled: false });
  expect(
    await s.lifecycle.request(admission(), ready.snapshot.transportGeneration, "tools/list", {}),
  ).toMatchObject({ kind: "stale" });
  expect(requests).toHaveLength(3);
});

test("HTTP rejects redirects, malformed success, and oversized bodies before readiness", async () => {
  let redirected = 0;
  const destination = Bun.serve({
    port: 0,
    fetch() {
      redirected += 1;
      return Response.json({});
    },
  });
  cleanup.push(() => destination.stop(true));
  for (const mode of ["redirect", "malformed", "oversized"]) {
    const server = Bun.serve({
      port: 0,
      fetch() {
        if (mode === "redirect")
          return Response.redirect(`http://127.0.0.1:${destination.port}/other`, 307);
        if (mode === "oversized")
          return new Response("x".repeat(1024 * 1024 + 1), {
            headers: { "content-type": "application/json" },
          });
        return Response.json({ ok: true });
      },
    });
    cleanup.push(() => server.stop(true));
    const s = setup(
      mcpConnectionSchema.parse({
        id: "fixture",
        transport: "http",
        url: `http://127.0.0.1:${server.port}/mcp`,
      }),
    );
    expect(
      (await s.lifecycle.connect({ ...admission(), deadline: Date.now() + 150 })).kind,
    ).not.toBe("completed");
  }
  expect(redirected).toBe(0);
});

test("HTTP paginates with a bounded SDK walk and retries a transient read once", async () => {
  let reads = 0;
  const cursors: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const message = (await request.json()) as Record<string, unknown>;
      if (message.method === "tools/list") {
        reads += 1;
        if (reads === 1) return new Response("retry", { status: 503 });
        const params = message.params as Record<string, unknown>;
        cursors.push(params.cursor ?? null);
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            resultType: "complete",
            ttlMs: 0,
            cacheScope: "private",
            tools: [
              {
                name: params.cursor ? "second" : "first",
                inputSchema: { type: "object", properties: {} },
              },
            ],
            ...(params.cursor ? {} : { nextCursor: "next" }),
          },
        });
      }
      return Response.json(mcpFixtureReply(message));
    },
  });
  cleanup.push(() => server.stop(true));
  const s = setup(
    mcpConnectionSchema.parse({
      id: "fixture",
      transport: "http",
      url: `http://127.0.0.1:${server.port}/mcp`,
    }),
  );
  const ready = await s.lifecycle.connect(admission());
  expect(ready.kind).toBe("completed");
  if (ready.kind !== "completed") return;
  const result = await s.lifecycle.request(
    admission(),
    ready.snapshot.transportGeneration,
    "tools/list",
    {},
  );
  expect(result.kind, JSON.stringify(result)).toBe("completed");
  expect(cursors).toEqual([null, "next"]);
  expect(JSON.stringify(result)).toContain("second");
});

posix("stop settles pending effects, and cancelled startup never publishes readiness", async () => {
  const s = setup(stdio("pending"));
  const ready = await s.lifecycle.connect(admission());
  expect(ready.kind).toBe("completed");
  if (ready.kind !== "completed") return;
  const pending = s.lifecycle.request(
    admission(),
    ready.snapshot.transportGeneration,
    "tools/call",
    { name: "echo" },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stopped = await s.lifecycle.stop("fixture");
  expect(stopped).toMatchObject({ kind: "completed", snapshot: { pending: 0, state: "stopped" } });
  expect(await pending).toMatchObject({ effect: "uncertain" });
  const slow = setup(stdio("silent"));
  const opening = slow.lifecycle.connect(admission());
  await slow.lifecycle.stop("fixture");
  expect((await opening).kind).not.toBe("completed");
  expect(slow.events).not.toContain("available");
});

posix(
  "stdio bounds pending requests and closes an owned process after partial frames and stderr flood",
  async () => {
    const active = setup(stdio("pending"));
    const ready = await active.lifecycle.connect(admission());
    expect(ready.kind).toBe("completed");
    if (ready.kind !== "completed") return;
    const requests = Array.from({ length: 32 }, () =>
      active.lifecycle.request(admission(), ready.snapshot.transportGeneration, "tools/call", {
        name: "echo",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(active.lifecycle.inspect()[0]?.pending).toBe(32);
    expect(
      await active.lifecycle.request(
        admission(),
        ready.snapshot.transportGeneration,
        "tools/call",
        {
          name: "echo",
        },
      ),
    ).toMatchObject({ kind: "unavailable", code: "mcp-request-capacity" });
    await active.lifecycle.stop("fixture");
    expect((await Promise.all(requests)).every((result) => result.kind !== "completed")).toBe(true);
    for (const mode of ["partial", "stderr"]) {
      const peer = setup(stdio(mode));
      const connected = await peer.lifecycle.connect(admission());
      expect(connected.kind).toBe("completed");
      if (connected.kind !== "completed") continue;
      const result = await peer.lifecycle.request(
        admission(),
        connected.snapshot.transportGeneration,
        "tools/call",
        { name: "pid" },
      );
      expect(result.kind).toBe("completed");
      if (result.kind !== "completed") continue;
      const pid = Number((result.value as { content: { text: string }[] }).content[0]?.text);
      expect(Number.isSafeInteger(pid)).toBe(true);
      await peer.lifecycle.stop("fixture");
      expect(() => process.kill(pid, 0)).toThrow();
    }
  },
);

test("a missing executable is unavailable without publishing a usable binding", async () => {
  const s = setup(
    mcpConnectionSchema.parse({ ...stdio(), executable: "/nonexistent/falryn-mcp-fixture" }),
  );
  expect((await s.lifecycle.connect(admission())).kind).not.toBe("completed");
  expect(s.events).not.toContain("available");
});

posix("changed command fences the old reply while another server remains usable", async () => {
  const s = setup(stdio("delayed"));
  s.add({ ...stdio(), id: "other" });
  const ready = await s.lifecycle.connect({ ...admission(), configurationGeneration: 2 });
  const other = await s.lifecycle.connect({ ...admission("other"), configurationGeneration: 2 });
  expect(ready.kind).toBe("completed");
  expect(other.kind).toBe("completed");
  if (ready.kind !== "completed" || other.kind !== "completed") return;
  const pending = s.lifecycle.request(
    { ...admission(), configurationGeneration: 2 },
    ready.snapshot.transportGeneration,
    "tools/call",
    { name: "echo" },
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  s.replace(stdio());
  expect(await pending).toMatchObject({ kind: "stale", effect: "uncertain" });
  expect(
    (
      await s.lifecycle.request(
        { ...admission("other"), configurationGeneration: 2 },
        other.snapshot.transportGeneration,
        "tools/list",
        {},
      )
    ).kind,
  ).toBe("completed");
  const replacement = await s.lifecycle.connect({ ...admission(), configurationGeneration: 3 });
  expect(replacement.kind).toBe("completed");
  if (replacement.kind === "completed")
    expect(replacement.snapshot.transportGeneration).toBeGreaterThan(
      ready.snapshot.transportGeneration,
    );
});

test("legacy negotiation is explicit and a failed HTTP effect is never retried", async () => {
  if (process.platform !== "win32") {
    const legacy = setup({ ...stdio(), protocol: "legacy" });
    expect((await legacy.lifecycle.connect(admission())).kind).toBe("completed");
  }
  let effects = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const message = (await request.json()) as Record<string, unknown>;
      if (message.method === "tools/call") {
        effects += 1;
        return new Response("lost response", { status: 503 });
      }
      return Response.json(mcpFixtureReply(message));
    },
  });
  cleanup.push(() => server.stop(true));
  const s = setup(
    mcpConnectionSchema.parse({
      id: "fixture",
      transport: "http",
      url: `http://127.0.0.1:${server.port}/mcp`,
    }),
  );
  const ready = await s.lifecycle.connect(admission());
  expect(ready.kind).toBe("completed");
  if (ready.kind !== "completed") return;
  expect(
    await s.lifecycle.request(admission(), ready.snapshot.transportGeneration, "tools/call", {
      name: "echo",
    }),
  ).toMatchObject({ kind: "failed", effect: "uncertain" });
  expect(effects).toBe(1);
});

(process.platform === "win32" ? test : test.skip)(
  "stdio refuses platforms without owned process-tree termination",
  async () => {
    const s = setup(stdio());
    expect(await s.lifecycle.connect(admission())).toMatchObject({
      kind: "unavailable",
      code: "mcp-stdio-platform-unavailable",
    });
    expect(s.events).not.toContain("available");
  },
);

posix(
  "notifications do not create work and unsupported server requests receive a refusal",
  async () => {
    const s = setup({ ...stdio("unsolicited"), protocol: "legacy" });
    const ready = await s.lifecycle.connect(admission());
    expect(ready.kind).toBe("completed");
    if (ready.kind !== "completed") return;
    expect(
      (await s.lifecycle.request(admission(), ready.snapshot.transportGeneration, "ping", {})).kind,
    ).toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const result = await s.lifecycle.request(
      admission(),
      ready.snapshot.transportGeneration,
      "tools/call",
      { name: "status" },
    );
    expect(result).toMatchObject({
      kind: "completed",
      value: { content: [{ type: "text", text: "true" }] },
    });
  },
);

test("current connections offer form input and hand input rounds back; legacy offers none", async () => {
  const messages: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const message = (await request.json()) as Record<string, unknown>;
      messages.push(message);
      if (message.method === "prompts/get")
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          result: { resultType: "input_required", inputRequests: {}, requestState: "prompt-1" },
        });
      return Response.json(mcpFixtureReply(message));
    },
  });
  cleanup.push(() => server.stop(true));
  const url = `http://127.0.0.1:${server.port}/mcp`;
  const s = setup(mcpConnectionSchema.parse({ id: "fixture", transport: "http", url }));
  const ready = await s.lifecycle.connect(admission());
  expect(ready.kind).toBe("completed");
  if (ready.kind !== "completed") return;
  const capabilities = (message: Record<string, unknown> | undefined) =>
    (message?.params as { _meta?: Record<string, unknown> } | undefined)?._meta?.[
      "io.modelcontextprotocol/clientCapabilities"
    ];
  expect(capabilities(messages.find((m) => m.method === "server/discover"))).toEqual({
    elicitation: { form: {} },
  });
  const asked = await s.lifecycle.request(
    admission(),
    ready.snapshot.transportGeneration,
    "tools/call",
    {
      name: "ask",
      arguments: {},
    },
  );
  expect(asked).toMatchObject({
    kind: "completed",
    value: { resultType: "input_required", requestState: "ask-1", inputRequests: { confirm: {} } },
  });
  const inputResponses = { confirm: { action: "accept", content: { branch: "next" } } };
  const answered = await s.lifecycle.request(
    admission(),
    ready.snapshot.transportGeneration,
    "tools/call",
    { name: "ask", arguments: {}, inputResponses, requestState: "ask-1" },
  );
  expect(answered).toMatchObject({
    kind: "completed",
    value: {
      content: [
        {
          type: "text",
          text: JSON.stringify({ requestState: "ask-1", responses: inputResponses }),
        },
      ],
    },
  });
  const calls = messages.filter((m) => m.method === "tools/call");
  expect(calls).toHaveLength(2);
  expect(calls[0]?.id).not.toBe(calls[1]?.id);
  expect(calls[1]?.params).toMatchObject({ inputResponses, requestState: "ask-1" });
  // Only tool calls take input rounds; prompts and reads still refuse them.
  expect(
    await s.lifecycle.request(admission(), ready.snapshot.transportGeneration, "prompts/get", {
      name: "review",
      arguments: { topic: "x" },
    }),
  ).toMatchObject({ kind: "failed", code: "mcp-input-required-unavailable" });

  messages.length = 0;
  const legacy = setup(
    mcpConnectionSchema.parse({ id: "fixture", transport: "http", url, protocol: "legacy" }),
  );
  expect((await legacy.lifecycle.connect(admission())).kind).toBe("completed");
  const initialize = messages.find((m) => m.method === "initialize")?.params as
    | { capabilities?: unknown }
    | undefined;
  // Exact: a legacy client offers no elicitation at all.
  expect(initialize?.capabilities).toEqual({});
});

/** A local HTTP MCP peer; the handler may answer a message itself or defer to the fixture. */
function peer(
  handle: (message: Record<string, unknown>, request: Request) => Response | null,
): string {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const message = (await request.json()) as Record<string, unknown>;
      return handle(message, request) ?? Response.json(mcpFixtureReply(message));
    },
  });
  cleanup.push(() => server.stop(true));
  return "http://127.0.0.1:" + server.port + "/mcp";
}
function http(url: string, extra: Record<string, unknown> = {}, id = "fixture") {
  return mcpConnectionSchema.parse({ id, transport: "http", url, ...extra });
}

test("HTTP credentials resolve through the shared store, scoped to their server, and rotate once", async () => {
  const seen: string[] = [];
  let valid = "private-token";
  let calls = 0;
  const url = peer((message, request) => {
    const authorization = request.headers.get("authorization") ?? "";
    seen.push(authorization);
    if (authorization !== "Bearer " + valid) return new Response("no", { status: 401 });
    if (message.method === "tools/call") calls += 1;
    return null;
  });
  const others: string[] = [];
  const otherUrl = peer((_message, request) => {
    others.push(request.headers.get("authorization") ?? "");
    return null;
  });
  const s = setup(
    http(url, { credential: { storeKind: "environment", locator: "MCP_TEST_TOKEN" } }),
    http(otherUrl, { credentialEnvironment: "MCP_OTHER_TOKEN" }, "other"),
  );
  s.secrets.MCP_OTHER_TOKEN = "other-token";
  const ready = await s.lifecycle.connect(admission());
  expect(ready.kind).toBe("completed");
  if (ready.kind !== "completed") return;
  expect((await s.lifecycle.connect(admission("other"))).kind).toBe("completed");
  // Each server sends only its own credential.
  expect(new Set(seen)).toEqual(new Set(["Bearer private-token"]));
  expect(new Set(others)).toEqual(new Set(["Bearer other-token"]));

  // Rotated in the store: one rejection resolves it again and the SDK retries once.
  valid = "rotated-token";
  s.secrets.MCP_TEST_TOKEN = "rotated-token";
  seen.length = 0;
  const rotated = await s.lifecycle.request(
    admission(),
    ready.snapshot.transportGeneration,
    "tools/list",
    {},
  );
  expect(rotated.kind, JSON.stringify(rotated)).toBe("completed");
  expect(seen).toEqual(["Bearer private-token", "Bearer rotated-token"]);

  // Expired with nothing new in the store: rejected, denied, and a call had no effect.
  valid = "only-the-server-knows";
  const rejected = await s.lifecycle.request(
    admission(),
    ready.snapshot.transportGeneration,
    "tools/call",
    { name: "echo", arguments: { value: "x" } },
  );
  expect(rejected).toMatchObject({ kind: "denied", code: "mcp-auth-rejected", effect: "none" });
  expect(calls).toBe(0);
  expect(s.lifecycle.inspect()[0]).toMatchObject({ state: "denied", code: "mcp-auth-rejected" });
  expect(JSON.stringify(s.snapshots)).not.toContain("rotated-token");

  const missing = setup(http(url, { credentialEnvironment: "MCP_ABSENT" }));
  seen.length = 0;
  expect(await missing.lifecycle.connect(admission())).toMatchObject({
    kind: "denied",
    code: "mcp-credential-missing",
    effect: "none",
  });
  expect(seen).toEqual([]);
  expect(missing.lifecycle.inspect()[0]).toMatchObject({
    state: "denied",
    code: "mcp-credential-missing",
  });
});

test("HTTP 403 denies the connection without retrying", async () => {
  let hits = 0;
  const url = peer(() => {
    hits += 1;
    return new Response("forbidden", { status: 403 });
  });
  const s = setup(http(url));
  expect(await s.lifecycle.connect(admission())).toMatchObject({
    kind: "denied",
    code: "mcp-auth-forbidden",
    effect: "none",
  });
  expect(hits).toBe(1);
});

test("safe reads retry refusals within the deadline, honoring Retry-After; calls never retry", async () => {
  const answers: Response[] = [];
  let reads = 0;
  let calls = 0;
  const url = peer((message) => {
    if (message.method === "tools/list") {
      reads += 1;
      return answers.shift() ?? null;
    }
    if (message.method === "tools/call") {
      calls += 1;
      return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
    }
    return null;
  });
  const s = setup(http(url));
  const ready = await s.lifecycle.connect({ ...admission(), deadline: Date.now() + 10_000 });
  expect(ready.kind).toBe("completed");
  if (ready.kind !== "completed") return;
  const list = (deadline = 10_000) =>
    s.lifecycle.request(
      { ...admission(), deadline: Date.now() + deadline },
      ready.snapshot.transportGeneration,
      "tools/list",
      {},
    );

  answers.push(
    new Response("limit", { status: 429, headers: { "retry-after": "0" } }),
    new Response("gateway", { status: 503 }),
  );
  expect((await list()).kind).toBe("completed");
  expect(reads).toBe(3);

  reads = 0;
  answers.push(...[1, 2, 3].map(() => new Response("gateway", { status: 502 })));
  expect(await list()).toMatchObject({
    kind: "unavailable",
    code: "mcp-server-unavailable",
    effect: "none",
  });
  expect(reads).toBe(3);

  // A hint that outlasts the deadline is not waited for.
  reads = 0;
  answers.push(new Response("later", { status: 429, headers: { "retry-after": "5" } }));
  const started = Date.now();
  expect(await list(2_000)).toMatchObject({ kind: "unavailable", code: "mcp-rate-limited" });
  expect(reads).toBe(1);
  expect(Date.now() - started).toBeLessThan(1_000);

  // The server refused the call before accepting it: no effect, and no second attempt.
  expect(
    await s.lifecycle.request(admission(), ready.snapshot.transportGeneration, "tools/call", {
      name: "echo",
    }),
  ).toMatchObject({ kind: "unavailable", code: "mcp-rate-limited", effect: "none" });
  expect(calls).toBe(1);
});

test("cancelling during a backoff makes no further attempt", async () => {
  let reads = 0;
  let discovers = 0;
  let refuseStart = false;
  const url = peer((message) => {
    if (message.method === "server/discover" && refuseStart) {
      discovers += 1;
      return new Response("later", { status: 429, headers: { "retry-after": "1" } });
    }
    if (message.method !== "tools/list") return null;
    reads += 1;
    return new Response("later", { status: 429, headers: { "retry-after": "1" } });
  });
  const s = setup(http(url));
  const ready = await s.lifecycle.connect({ ...admission(), deadline: Date.now() + 10_000 });
  expect(ready.kind).toBe("completed");
  if (ready.kind !== "completed") return;
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 50);
  const request = await s.lifecycle.request(
    { ...admission("fixture", abort.signal), deadline: Date.now() + 10_000 },
    ready.snapshot.transportGeneration,
    "tools/list",
    {},
  );
  expect(request).toMatchObject({
    kind: "cancelled",
    code: "mcp-request-cancelled",
    effect: "none",
  });

  refuseStart = true;
  await s.lifecycle.stop("fixture");
  const startAbort = new AbortController();
  setTimeout(() => startAbort.abort(), 50);
  expect(
    await s.lifecycle.connect({
      ...admission("fixture", startAbort.signal),
      deadline: Date.now() + 10_000,
    }),
  ).toMatchObject({ kind: "cancelled", code: "mcp-startup-cancelled" });
  expect(s.snapshots.some((snapshot) => snapshot.code === "mcp-retry-wait")).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  expect({ reads, discovers }).toEqual({ reads: 1, discovers: 1 });
});

test("a refused start is retried with backoff until the server is ready", async () => {
  let discovers = 0;
  const url = peer((message) => {
    if (message.method !== "server/discover") return null;
    discovers += 1;
    return discovers < 3 ? new Response("starting", { status: 503 }) : null;
  });
  const s = setup(http(url));
  const ready = await s.lifecycle.connect({ ...admission(), deadline: Date.now() + 10_000 });
  expect(ready.kind, JSON.stringify(ready)).toBe("completed");
  expect(discovers).toBe(3);
  expect(s.snapshots.filter((snapshot) => snapshot.code === "mcp-retry-wait")).toHaveLength(2);
});

posix(
  "a stdio crash after acceptance stays uncertain; an explicit reconnect starts fresh",
  async () => {
    const s = setup(stdio("disconnect"));
    const ready = await s.lifecycle.connect(admission());
    expect(ready.kind).toBe("completed");
    if (ready.kind !== "completed") return;
    const lost = await s.lifecycle.request(
      admission(),
      ready.snapshot.transportGeneration,
      "tools/call",
      { name: "echo", arguments: { value: "x" } },
    );
    expect(lost).toMatchObject({ effect: "uncertain" });
    expect(lost.kind).not.toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(s.lifecycle.inspect()[0]?.state).toBe("degraded");
    // Nothing reconnects or resends by itself.
    expect(
      await s.lifecycle.request(admission(), ready.snapshot.transportGeneration, "tools/list", {}),
    ).toMatchObject({ kind: "unavailable", code: "mcp-not-ready" });
    const again = await s.lifecycle.connect(admission());
    expect(again.kind).toBe("completed");
    if (again.kind !== "completed") return;
    expect(again.snapshot.transportGeneration).toBeGreaterThan(ready.snapshot.transportGeneration);
    expect(
      await s.lifecycle.request(admission(), ready.snapshot.transportGeneration, "tools/list", {}),
    ).toMatchObject({ kind: "stale" });
  },
);
