import { expect, test } from "bun:test";
import {
  type McpConnection,
  type McpSnapshot,
  mcpConnectionSchema,
} from "../../domain/extensions/mcp.ts";
import {
  MCP_PREPARATION_LIMITS,
  mcpConnectionSummary,
  mcpServerRelevant,
} from "../../domain/extensions/mcp-preparation.ts";
import type { McpCatalogSummary } from "./mcp-catalog.ts";
import { type McpPreparationPorts, prepareMcpServers } from "./mcp-preparation.ts";

const stdio = (id: string, extra: Record<string, unknown> = {}): McpConnection =>
  mcpConnectionSchema.parse({ id, transport: "stdio", executable: "node", args: [], ...extra });

/** In-memory lifecycle and catalog that count every connect and discovery. */
function harness(
  servers: readonly McpConnection[],
  options: {
    readonly current?: readonly string[];
    readonly connectFails?: Readonly<Record<string, string>>;
    readonly discoverFails?: Readonly<Record<string, string>>;
  } = {},
) {
  const snapshots = new Map<string, McpSnapshot>(
    servers.map((server) => [
      server.id,
      {
        serverId: server.id,
        state: options.current?.includes(server.id) ? "available" : "unqueried",
        configurationGeneration: 1,
        transportGeneration: options.current?.includes(server.id) ? 1 : 0,
        environmentGeneration: null,
        pending: 0,
        code: null,
        features: ["tools"],
        catalogRevision: 0,
        listChanges: "observed",
      } as McpSnapshot,
    ]),
  );
  const generations = new Map<string, number>(
    (options.current ?? []).map((id, index) => [id, index + 1]),
  );
  const connects: { serverId: string; origin: string }[] = [];
  const discoveries: string[] = [];
  const summary = (serverId: string): McpCatalogSummary => ({
    serverId,
    state: generations.has(serverId) ? "current" : "unknown",
    code: null,
    catalogGeneration: generations.get(serverId) ?? null,
    listChanges: "observed",
    entries: { tool: 0, resource: 0, "resource-template": 0, prompt: 0 },
    counts: { malformed: 0, duplicates: 0, omitted: 0 },
  });
  const ports: McpPreparationPorts = {
    configuration: () => ({ servers, generation: 1 }),
    lifecycle: {
      inspect: () => [...snapshots.values()],
      async connect(admission) {
        connects.push({ serverId: admission.serverId, origin: admission.origin });
        const code = options.connectFails?.[admission.serverId];
        if (code) return { kind: "failed", code, effect: "none", snapshot: null };
        const previous = snapshots.get(admission.serverId);
        if (!previous) throw new Error("unknown server");
        const next = {
          ...previous,
          state: "available" as const,
          transportGeneration: previous.transportGeneration + 1,
        };
        snapshots.set(admission.serverId, next);
        return { kind: "completed", value: null, snapshot: next };
      },
    },
    catalog: {
      summaries: () => servers.map((server) => summary(server.id)),
      async discover(serverId) {
        discoveries.push(serverId);
        const code = options.discoverFails?.[serverId];
        if (code) return { kind: "unavailable", code, effect: "none", requests: 1 };
        generations.set(serverId, 10 + discoveries.length);
        return { kind: "completed", value: summary(serverId), requests: 3 };
      },
    },
  };
  return { ports, connects, discoveries };
}

const prepare = (
  ports: McpPreparationPorts,
  task: string,
  selectedServers: readonly string[] = [],
  signal = new AbortController().signal,
) => prepareMcpServers(ports, { task, selectedServers, requestId: "turn-1", signal });

test("a connection summary uses its id, host labels and executable names, never server data", () => {
  expect(
    mcpConnectionSummary(
      mcpConnectionSchema.parse({
        id: "tracker",
        transport: "http",
        url: "https://issues.example.com/mcp",
      }),
    ),
  ).toEqual(["tracker", "issues", "example"]);
  expect(
    mcpConnectionSummary(
      stdio("gh", { executable: "/usr/bin/npx", args: ["@acme/server-github", "--stdio"] }),
    ),
  ).toEqual(["github", "stdio"]);
  expect(mcpServerRelevant(stdio("fixture"), "Use the MCP server tools")).toBe(false);
  expect(mcpServerRelevant(stdio("fixture"), "echo through the fixture")).toBe(true);
});

test("a cold relevant server is connected and discovered with the host discovery origin", async () => {
  const h = harness([stdio("fixture")]);
  const [row] = await prepare(h.ports, "echo hello through the fixture");
  expect(row).toEqual({
    serverId: "fixture",
    decision: "prepared",
    reason: null,
    origin: "discovery",
    discoveryRequests: 3,
    transportStarts: 1,
    processStarts: 1,
    catalogGeneration: 11,
  });
  expect(h.connects).toEqual([{ serverId: "fixture", origin: "discovery" }]);
});

test("a current catalog is reused without any server work", async () => {
  const h = harness([stdio("fixture")], { current: ["fixture"] });
  const [row] = await prepare(h.ports, "echo through the fixture");
  expect(row).toMatchObject({
    decision: "reused",
    discoveryRequests: 0,
    processStarts: 0,
    catalogGeneration: 1,
  });
  expect(h.connects).toHaveLength(0);
  expect(h.discoveries).toHaveLength(0);
});

test("irrelevant, disabled and unselected explicit-only servers start nothing", async () => {
  const h = harness([
    stdio("notes"),
    stdio("fixture", { enabled: false }),
    stdio("private", { explicitOnly: true }),
  ]);
  const rows = await prepare(h.ports, "use the fixture and private tools");
  expect(rows.map((row) => [row.serverId, row.decision, row.reason])).toEqual([
    ["notes", "skipped", "not-relevant"],
    ["fixture", "skipped", "disabled"],
    ["private", "skipped", "explicit-only"],
  ]);
  expect(h.connects).toHaveLength(0);
  expect(h.discoveries).toHaveLength(0);
});

test("a user-selected explicit-only server is prepared with the user origin", async () => {
  const h = harness([stdio("private", { explicitOnly: true })]);
  const [row] = await prepare(h.ports, "anything at all", ["private"]);
  expect(row).toMatchObject({ decision: "prepared", origin: "user" });
  expect(h.connects).toEqual([{ serverId: "private", origin: "user" }]);
});

test("preparation is bounded per turn and stops on cancellation", async () => {
  const servers = ["alpha", "bravo", "charlie"].map((id) => stdio(id));
  const bounded = harness(servers);
  const rows = await prepare(bounded.ports, "alpha bravo charlie");
  expect(rows.filter((row) => row.decision === "prepared")).toHaveLength(
    MCP_PREPARATION_LIMITS.serversPerTurn,
  );
  expect(rows.at(-1)).toMatchObject({ decision: "skipped", reason: "preparation-limit" });
  const cancelled = harness(servers);
  const controller = new AbortController();
  controller.abort();
  const none = await prepare(cancelled.ports, "alpha", [], controller.signal);
  expect(none[0]).toMatchObject({ decision: "skipped", reason: "cancelled" });
  expect(cancelled.connects).toHaveLength(0);
});

test("missing credentials and a failed refresh are typed failures; the turn keeps going", async () => {
  const h = harness([stdio("tracker"), stdio("fixture")], {
    connectFails: { tracker: "mcp-credential-missing" },
    discoverFails: { fixture: "mcp-catalog-refresh-mcp-server-unavailable" },
  });
  const rows = await prepare(h.ports, "tracker and fixture");
  expect(rows.map((row) => [row.decision, row.reason, row.discoveryRequests])).toEqual([
    ["failed", "mcp-credential-missing", 0],
    ["failed", "mcp-catalog-refresh-mcp-server-unavailable", 1],
  ]);
  // A refused connect never reaches discovery.
  expect(h.discoveries).toEqual(["fixture"]);
});
