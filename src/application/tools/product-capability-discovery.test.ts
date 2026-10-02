import { describe, expect, test } from "bun:test";
import { z } from "zod";

import {
  type CapabilityRegistryEntry,
  type CapabilityRuntimeState,
  createCapabilityRegistry,
  createCapabilityRegistryEntry,
  defaultCapabilityOperationalState,
} from "../../domain/capabilities/index.ts";
import { configurationGeneration } from "../../domain/foundation/index.ts";
import { resolveExecutionProfile } from "../../domain/sessions/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  type ToolInvocationOutcome,
  type ToolRegistryEntry,
} from "../../domain/tools/index.ts";
import { capabilityEntryFromTool } from "../capabilities/product-capability-registry.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import {
  CAPABILITY_DISCOVERY_LIMITS,
  type CapabilityDiscoveryResult,
  capabilityCatalogHandle,
  composeProductDiscoveryTool,
  createCapabilityDiscoverySession,
  PRODUCT_DISCOVERY_TOOL_NAME,
} from "./product-capability-discovery.ts";

const generation = configurationGeneration.from(3);

function tool(
  name: string,
  description: string,
  capabilityKind: "filesystem" | "browser" | "other" = "other",
): ToolRegistryEntry {
  const created = createToolRegistryEntry(
    {
      namespace: "fixture",
      name,
      version: 1,
      source: "builtin",
      title: name,
      description,
      effect: "observation",
      capabilityKind,
      platforms: [],
      limits: defaultToolLimits(),
      concurrency: defaultConcurrencyContract({}),
      resultProjection: defaultProjectionContract({}),
    },
    {
      inputSchema: z.object({ target: z.string() }).strict() as z.ZodType<
        Readonly<Record<string, unknown>>
      >,
      outputSchema: z.record(z.string(), z.unknown()),
    },
  );
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

/** Republish a capability with a different runtime state, as an owner would. */
function withState(
  entry: CapabilityRegistryEntry,
  state: Partial<CapabilityRuntimeState>,
  document: { readonly summary?: string; readonly kind?: CapabilityRegistryEntry["kind"] } = {},
): CapabilityRegistryEntry {
  const created = createCapabilityRegistryEntry(
    {
      namespace: entry.namespace,
      name: entry.name,
      version: entry.version,
      source: entry.source,
      kind: document.kind ?? entry.kind,
      title: entry.title,
      summary: document.summary ?? entry.summary,
      family: entry.family,
      effect: entry.effect,
      provenance: entry.provenance,
      compatibility: entry.compatibility,
      limits: entry.limits,
      routing: entry.routing,
      state: { ...entry.state, ...state },
      schemas: entry.schemas,
    },
    { capabilityId: entry.capabilityId },
  );
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

function skill(name: string, summary: string): CapabilityRegistryEntry {
  const created = createCapabilityRegistryEntry({
    namespace: "skills",
    name,
    version: 1,
    source: "workspace",
    kind: "skill",
    title: name,
    summary,
    family: null,
    effect: "observation",
    provenance: { sourceId: "workspace:skills", sourceVersion: "1" },
    compatibility: { os: [], arch: [], dependencies: [] },
    limits: {
      maxInputBytes: null,
      maxOutputBytes: null,
      defaultTimeoutMs: null,
      maxConcurrency: null,
    },
    routing: { costClass: "unknown", latencyClass: "unknown" },
    state: {
      availability: "available",
      availabilityReason: null,
      health: "healthy",
      healthReason: null,
      executable: false,
      executionReason: null,
      operational: defaultCapabilityOperationalState(),
    },
    schemas: { inputDigest: null, outputDigest: null },
  });
  if (!created.ok) throw new Error(created.error.code);
  return created.value;
}

function fixture() {
  const discovery = composeProductDiscoveryTool(generation);
  const [discoverTool] = discovery.registry.entries;
  if (discoverTool === undefined) throw new Error("discovery tool missing");
  const deploy = tool("deploy_preview", "Publish a preview deployment of the current branch");
  const notes = tool("read_notes", "Read the release notes", "filesystem");
  const browser = tool(
    "browser_snapshot",
    "Always available: capture the page in the browser",
    "browser",
  );
  const lazy = tool("issue_search", "Search issues on the tracker server");
  const retired = tool("retired_deploy", "Old deploy helper from a disabled package");
  const registry = createToolRegistry(generation, [
    discoverTool,
    deploy,
    notes,
    browser,
    lazy,
    retired,
  ]);
  if (!registry.ok) throw new Error(registry.error.code);
  const capabilities = createCapabilityRegistry(generation, [
    capabilityEntryFromTool(discoverTool, true),
    capabilityEntryFromTool(deploy, true),
    capabilityEntryFromTool(notes, true),
    // Metadata claims availability; the runtime state is what discovery reports.
    withState(capabilityEntryFromTool(browser, true), {
      availability: "unavailable",
      availabilityReason: "browser host is not connected",
      health: "unavailable",
      healthReason: "browser host is not connected",
      executable: false,
      executionReason: "browser host is not connected",
    }),
    withState(capabilityEntryFromTool(lazy, true), {
      availability: "unknown",
      availabilityReason: "server not started",
      health: "unknown",
      healthReason: "server not started",
      executable: false,
      preparable: true,
      executionReason: "server not started",
    }),
    withState(capabilityEntryFromTool(retired, true), {
      operational: defaultCapabilityOperationalState({ allowed: false }),
    }),
    skill("release-checklist", "Checklist for preparing a deploy and release"),
    // A connector tool whose server is disconnected publishes no executable binding.
    withState(
      skill("tracker-create-issue", "Create an issue in the connected tracker"),
      {
        availability: "unavailable",
        availabilityReason: "connector disconnected",
        health: "unavailable",
        healthReason: "connector disconnected",
      },
      { kind: "mcp-tool" },
    ),
  ]);
  if (!capabilities.ok) throw new Error(capabilities.error.code);
  const disclosed = new Set([PRODUCT_DISCOVERY_TOOL_NAME, "read_notes"]);
  const executed: string[] = [];
  const base: ToolRunnerPort = {
    hasBinding: () => true,
    async execute(request): Promise<ToolInvocationOutcome> {
      executed.push(request.toolName);
      return { status: "completed", output: {}, effect: "completed" };
    },
  };
  const session = createCapabilityDiscoverySession({
    tools: registry.value,
    capabilities: capabilities.value,
    policy: resolveExecutionProfile("agent", generation),
    disclosed,
  });
  const runner = session.wrap(base);
  let calls = 0;
  const discover = (
    input: Readonly<Record<string, unknown>>,
    signal: AbortSignal = new AbortController().signal,
  ) => {
    calls += 1;
    const request = {
      invocationId: `invocation-${calls}`,
      toolCallId: `call-${calls}`,
      toolName: PRODUCT_DISCOVERY_TOOL_NAME,
      capabilityId: discoverTool.manifest.capabilityId,
      version: 1,
      effect: "observation",
      input: { query: "", cursor: 0, limit: 8, ...input },
      signal,
    } as unknown as ToolRunnerRequest;
    return runner.execute(request);
  };
  return { session, disclosed, executed, discover, registry: registry.value };
}

function result(outcome: ToolInvocationOutcome): CapabilityDiscoveryResult {
  if (outcome.status !== "completed") throw new Error(`not completed: ${outcome.status}`);
  return outcome.output as CapabilityDiscoveryResult;
}

const catalog = capabilityCatalogHandle(generation);

describe("capability discovery", () => {
  test("finds an omitted executable tool and admits it at the next step boundary", async () => {
    const { discover, session, disclosed } = fixture();
    const found = result(await discover({ catalog, query: "preview deployment" }));
    const deploy = found.entries.find((entry) => entry.tool === "deploy_preview");
    expect(found.entries[0]?.tool).toBe("deploy_preview");
    expect(deploy).toMatchObject({
      status: "callable-next-step",
      readiness: {
        registered: true,
        enabled: true,
        prepared: true,
        disclosed: false,
        executable: true,
      },
    });
    // Not callable within the step that found it.
    expect(disclosed.has("deploy_preview")).toBe(false);
    expect(session.admitPending().map((definition) => definition.name)).toEqual(["deploy_preview"]);
    expect(disclosed.has("deploy_preview")).toBe(true);
    expect(session.admitPending()).toEqual([]);
    const again = result(await discover({ catalog, query: "preview deployment" }));
    expect(again.entries.find((entry) => entry.tool === "deploy_preview")).toMatchObject({
      status: "callable",
      readiness: { disclosed: true },
    });
    expect(session.admitted().map((definition) => definition.name)).toEqual(["deploy_preview"]);
  });

  test("reports readiness facts and reasons truthfully for every kind of contribution", async () => {
    const { discover } = fixture();
    const found = result(await discover({ catalog, limit: 16 }));
    const byName = new Map(found.entries.map((entry) => [entry.name, entry]));
    expect(byName.has(PRODUCT_DISCOVERY_TOOL_NAME)).toBe(false);
    expect(byName.get("read_notes")).toMatchObject({ status: "callable" });
    expect(byName.get("browser_snapshot")).toMatchObject({
      status: "unavailable",
      readiness: { prepared: false, executable: false },
    });
    expect(byName.get("browser_snapshot")?.reasons).toContain("browser host is not connected");
    expect(byName.get("issue_search")).toMatchObject({
      status: "needs-preparation",
      readiness: { preparable: true, prepared: false, executable: false },
    });
    expect(byName.get("retired_deploy")).toMatchObject({
      status: "unavailable",
      readiness: { enabled: false, executable: false },
    });
    expect(byName.get("release-checklist")).toMatchObject({
      kind: "skill",
      status: "instruction-content",
      tool: null,
      readiness: { executable: false },
    });
    expect(byName.get("tracker-create-issue")).toMatchObject({
      kind: "mcp-tool",
      status: "unavailable",
      tool: null,
      readiness: { prepared: false, executable: false },
    });
    expect(byName.get("tracker-create-issue")?.reasons).toContain("connector disconnected");
    // Only the executable tool was admitted; nothing unavailable leaked in.
    expect(
      found.entries
        .filter((entry) => entry.status === "callable-next-step")
        .map((entry) => entry.tool),
    ).toEqual(["deploy_preview"]);
  });

  test("refuses a stale catalog handle without reading the registry", async () => {
    const { discover, session } = fixture();
    const refused = result(
      await discover({
        catalog: capabilityCatalogHandle(configurationGeneration.from(2)),
        query: "preview",
      }),
    );
    expect(refused).toMatchObject({
      catalog,
      refusal: "stale-catalog-generation",
      total: 0,
      entries: [],
      remainingCalls: CAPABILITY_DISCOVERY_LIMITS.callsPerAttempt,
    });
    expect(session.admitPending()).toEqual([]);
  });

  test("pages a bounded result set", async () => {
    const { discover } = fixture();
    const first = result(await discover({ catalog, limit: 2 }));
    expect(first.entries).toHaveLength(2);
    expect(first.total).toBe(7);
    expect(first.nextCursor).toBe(2);
    const last = result(await discover({ catalog, limit: 4, cursor: 4 }));
    expect(last.entries).toHaveLength(3);
    expect(last.nextCursor).toBeNull();
  });

  test("stops answering once the attempt's discovery calls are spent", async () => {
    const { discover } = fixture();
    for (let index = 0; index < CAPABILITY_DISCOVERY_LIMITS.callsPerAttempt; index += 1) {
      expect(result(await discover({ catalog, query: "notes" })).refusal).toBeNull();
    }
    expect(result(await discover({ catalog, query: "notes" }))).toMatchObject({
      refusal: "discovery-exhausted",
      remainingCalls: 0,
      entries: [],
    });
  });

  test("honours cancellation before reading", async () => {
    const { discover, session } = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(await discover({ catalog, query: "preview" }, controller.signal)).toEqual({
      status: "cancelled",
      effect: "none",
    });
    expect(session.admitPending()).toEqual([]);
  });

  test("passes every other tool to the wrapped runner unchanged", async () => {
    const { session, executed, registry } = fixture();
    const notes = registry.resolveByName("read_notes");
    if (notes === null) throw new Error("fixture");
    const outcome = await session
      .wrap({
        hasBinding: () => true,
        async execute(request) {
          executed.push(request.toolName);
          return { status: "completed", output: { ok: true }, effect: "completed" };
        },
      })
      .execute({
        invocationId: "invocation-x",
        toolCallId: "call-x",
        toolName: "read_notes",
        capabilityId: notes.manifest.capabilityId,
        version: 1,
        effect: "observation",
        input: { target: "notes" },
        signal: new AbortController().signal,
      } as unknown as ToolRunnerRequest);
    expect(outcome.status).toBe("completed");
    expect(executed).toEqual(["read_notes"]);
  });

  test("outside a live attempt the registered operation reports that it has no catalog", async () => {
    const bundle = composeProductDiscoveryTool(generation);
    const [entry] = bundle.registry.entries;
    expect(bundle.runner.hasBinding?.(entry?.manifest.capabilityId as never)).toBe(true);
    expect(
      await bundle.runner.execute({
        toolName: PRODUCT_DISCOVERY_TOOL_NAME,
        input: { catalog },
        signal: new AbortController().signal,
      } as unknown as ToolRunnerRequest),
    ).toEqual({ status: "unavailable", reason: "discovery-requires-attempt", effect: "none" });
  });
});
