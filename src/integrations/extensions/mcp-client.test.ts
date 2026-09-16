import { afterEach, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createMcpLifecycle } from "../../application/extensions/mcp-lifecycle.ts";
import {
  type McpAdmission,
  type McpConnection,
  mcpConnectionSchema,
} from "../../domain/extensions/mcp.ts";
import { createStaticEnvironment } from "../../domain/foundation/index.ts";
import { createHostManagedServicePort } from "../process/host-process-sessions/managed-service.ts";
import { createHostMcpClient } from "./mcp-client.ts";
import { mcpFixtureReply } from "./mcp-fixtures.ts";

const posix = process.platform === "win32" ? test.skip : test;
const cleanup: (() => Promise<unknown> | undefined)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const fixture = fileURLToPath(new URL("./mcp-fixtures.ts", import.meta.url));
function setup(server: McpConnection) {
  let configuration = { generation: 1, servers: [server] };
  let trusted = true;
  const services = createHostManagedServicePort();
  const events: string[] = [];
  const lifecycle = createMcpLifecycle({
    configuration: () => configuration,
    authorize: async () => trusted,
    observe: (snapshot) => events.push(snapshot.state),
    clients: createHostMcpClient({
      identity: crypto.randomUUID(),
      services: () => services,
      environment: createStaticEnvironment({ MCP_TEST_TOKEN: "private-token" }),
      environmentGeneration: () => "env-1",
    }),
  });
  cleanup.push(lifecycle.close);
  return {
    lifecycle,
    events,
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
  expect(
    (await s.lifecycle.request(admission(), ready.snapshot.transportGeneration, "tools/list", {}))
      .kind,
  ).toBe("completed");
  expect(requests.map((request) => request.method)).toEqual(["server/discover", "tools/list"]);
  expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2026-07-28");
  expect(requests[1]?.headers.get("mcp-method")).toBe("tools/list");
  expect(requests[1]?.headers.get("mcp-session-id")).toBeNull();
  s.replace({ ...config, enabled: false });
  expect(
    await s.lifecycle.request(admission(), ready.snapshot.transportGeneration, "tools/list", {}),
  ).toMatchObject({ kind: "stale" });
  expect(requests).toHaveLength(2);
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
