/**
 * Bounded, generation-bound capability discovery for one provider attempt (#947).
 *
 * Disclosure sends the model a small eager tool set. This operation lets a
 * later step find a capability the eager set omitted, read its separate
 * readiness facts with the reason it is or is not executable, and have an
 * executable native tool added to the next provider request. The call itself
 * and every discovered tool still run through the product tool gateway; this
 * module never prepares, installs, starts or executes anything it reports.
 */
import { z } from "zod";

import type {
  CapabilityHealthEntry,
  CapabilityRegistry,
  CapabilityRegistryEntry,
} from "../../domain/capabilities/index.ts";
import {
  CAPABILITY_CONTRIBUTION_KINDS,
  inspectCapabilityHealth,
} from "../../domain/capabilities/index.ts";
import type { ClockPort, ConfigurationGeneration } from "../../domain/foundation/index.ts";
import type { EffectiveExecutionPolicy } from "../../domain/sessions/index.ts";
import {
  createToolRegistry,
  createToolRegistryEntry,
  defaultConcurrencyContract,
  defaultProjectionContract,
  defaultToolLimits,
  type ToolInvocationOutcome,
  type ToolRegistry,
} from "../../domain/tools/index.ts";
import type { ModelToolDefinition } from "../../providers/index.ts";
import type { ToolRunnerPort, ToolRunnerRequest } from "../runtime/tool-call-loop.ts";
import {
  isClosedProductToolSchema,
  jsonSchemaFor,
  measureProductToolSchema,
  policyOmissionReason,
  RAW_PROTOCOL_ESCAPES,
} from "./product-tool-schema.ts";
import type { ProductToolSourceBundle } from "./product-tools-merge.ts";

export const PRODUCT_DISCOVERY_TOOL_NAME = "discover_capabilities";

/** Per-attempt bounds. Discovery is a lookup, not a loop the model can spin in. */
export const CAPABILITY_DISCOVERY_LIMITS = Object.freeze({
  callsPerAttempt: 6,
  defaultPageSize: 8,
  maxPageSize: 16,
  queryCharacters: 200,
  summaryCharacters: 240,
  maxReasons: 4,
  loadedToolsPerAttempt: 8,
  loadedSchemaTokensPerAttempt: 6_000,
});

/** The handle a disclosure names; discovery refuses any other generation. */
export function capabilityCatalogHandle(generation: ConfigurationGeneration): string {
  return `capability-catalog:${generation}`;
}

export const CAPABILITY_DISCOVERY_STATUSES = [
  "callable",
  "callable-next-step",
  "not-loaded",
  "needs-preparation",
  "instruction-content",
  "not-an-operation",
  "unavailable",
] as const;

export type CapabilityDiscoveryStatus = (typeof CAPABILITY_DISCOVERY_STATUSES)[number];

/** Recoverable refusals answered as results, so the model can correct course. */
export const CAPABILITY_DISCOVERY_REFUSALS = [
  "stale-catalog-generation",
  "discovery-exhausted",
] as const;

const discoveryInput = z
  .object({
    catalog: z.string().min(1).max(256),
    query: z.string().max(CAPABILITY_DISCOVERY_LIMITS.queryCharacters).default(""),
    kinds: z.array(z.enum(CAPABILITY_CONTRIBUTION_KINDS)).max(8).optional(),
    cursor: z.int().min(0).max(10_000).default(0),
    limit: z
      .int()
      .min(1)
      .max(CAPABILITY_DISCOVERY_LIMITS.maxPageSize)
      .default(CAPABILITY_DISCOVERY_LIMITS.defaultPageSize),
  })
  .strict() as z.ZodType<Readonly<Record<string, unknown>>>;

const readinessSchema = z
  .object({
    registered: z.literal(true),
    enabled: z.boolean(),
    preparable: z.boolean(),
    prepared: z.boolean(),
    disclosed: z.boolean(),
    executable: z.boolean(),
  })
  .strict();

const discoveryEntrySchema = z
  .object({
    capabilityId: z.string(),
    name: z.string(),
    kind: z.enum(CAPABILITY_CONTRIBUTION_KINDS),
    title: z.string(),
    summary: z.string(),
    effect: z.string(),
    source: z.string(),
    readiness: readinessSchema,
    status: z.enum(CAPABILITY_DISCOVERY_STATUSES),
    tool: z.string().nullable(),
    reasons: z.array(z.string()).max(CAPABILITY_DISCOVERY_LIMITS.maxReasons),
    recovery: z.array(z.string()).max(CAPABILITY_DISCOVERY_LIMITS.maxReasons),
  })
  .strict();

const discoveryOutput = z
  .object({
    catalog: z.string(),
    query: z.string(),
    total: z.int().min(0),
    cursor: z.int().min(0),
    nextCursor: z.int().min(0).nullable(),
    remainingCalls: z.int().min(0),
    refusal: z.enum(CAPABILITY_DISCOVERY_REFUSALS).nullable(),
    entries: z.array(discoveryEntrySchema),
  })
  .strict();

export type CapabilityDiscoveryEntry = z.infer<typeof discoveryEntrySchema>;
export type CapabilityDiscoveryResult = z.infer<typeof discoveryOutput>;

const DISCOVERY_DESCRIPTION =
  "Find capabilities this attempt was not shown: tools, MCP tools, skills, workflows and other registered contributions. Pass the catalog handle from the capability disclosure and a few task words. Each result reports registered, enabled, preparable, prepared, disclosed and executable separately, with reasons. An executable tool marked callable-next-step can be called by its exact tool name in your next step; nothing reported here is prepared, installed or run by this call";

/**
 * The registered operation. Outside a live attempt it has no catalog to read,
 * so it reports that instead of guessing; the attempt runner binds it.
 */
export function composeProductDiscoveryTool(
  generation: ConfigurationGeneration,
): ProductToolSourceBundle {
  const entry = createToolRegistryEntry(
    {
      namespace: "capabilities",
      name: PRODUCT_DISCOVERY_TOOL_NAME,
      version: 1,
      source: "builtin",
      title: "Discover capabilities",
      description: DISCOVERY_DESCRIPTION,
      effect: "observation",
      capabilityKind: "other",
      platforms: [],
      limits: defaultToolLimits({ maxInputBytes: 2_048, maxOutputBytes: 65_536 }),
      concurrency: defaultConcurrencyContract({ maxPerWorkspace: 4 }),
      resultProjection: defaultProjectionContract({ modelMaxBytes: 65_536 }),
    },
    { inputSchema: discoveryInput, outputSchema: discoveryOutput },
  );
  if (!entry.ok) throw new Error(`discovery-tool-${entry.error.code}`);
  const registry = createToolRegistry(generation, [entry.value]);
  if (!registry.ok) throw new Error(`discovery-registry-${registry.error.code}`);
  const id = entry.value.manifest.capabilityId;
  return {
    registry: registry.value,
    catalog: registry.value.catalog,
    toolNames: [PRODUCT_DISCOVERY_TOOL_NAME],
    runner: {
      hasBinding: (candidate) => candidate === id,
      async execute(request) {
        if (request.signal.aborted) return { status: "cancelled", effect: "none" };
        return { status: "unavailable", reason: "discovery-requires-attempt", effect: "none" };
      },
    },
  };
}

function words(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .toLocaleLowerCase()
        .split(/[^a-z0-9]+/u)
        .filter((part) => part.length >= 2),
    ),
  ];
}

function bounded(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function healthReasons(health: CapabilityHealthEntry | undefined): readonly string[] {
  if (health === undefined) return ["capability health is unavailable"];
  return health.diagnostics.map((item) => `${item.code}: ${item.message}`);
}

function healthRecovery(health: CapabilityHealthEntry | undefined): readonly string[] {
  return (
    health?.diagnostics.flatMap((item) => (item.recovery === null ? [] : [item.recovery.handle])) ??
    []
  );
}

export type CapabilityDiscoveryOptions = {
  readonly tools: ToolRegistry;
  readonly capabilities: CapabilityRegistry | undefined;
  readonly policy: EffectiveExecutionPolicy;
  /** Live set the gateway admits; discovery adds names to it only at a step boundary. */
  readonly disclosed: Set<string>;
  readonly clock?: ClockPort;
};

export type CapabilityDiscoverySession = {
  /** Wraps the native runner so the discovery call executes inside the gateway. */
  wrap(runner: ToolRunnerPort): ToolRunnerPort;
  /**
   * Definitions found since the last step, now admitted for the next provider
   * request. Called once per continuation, before the request is built.
   */
  admitPending(): readonly ModelToolDefinition[];
  /** Every definition admitted so far, in admission order. */
  admitted(): readonly ModelToolDefinition[];
};

type Candidate = {
  readonly entry: CapabilityRegistryEntry;
  readonly score: number;
  readonly order: number;
};

/**
 * One attempt's discovery state. The bounds hold across every call in the
 * attempt, so repeated discovery cannot widen the provider tool set without limit.
 */
export function createCapabilityDiscoverySession(
  options: CapabilityDiscoveryOptions,
): CapabilityDiscoverySession {
  const pending: ModelToolDefinition[] = [];
  const admitted: ModelToolDefinition[] = [];
  let calls = 0;
  let loadedTokens = 0;
  const handle = capabilityCatalogHandle(options.tools.generation);

  const describe = (
    entry: CapabilityRegistryEntry,
    health: CapabilityHealthEntry | undefined,
  ): CapabilityDiscoveryEntry => {
    const operational = entry.state.operational;
    const nativeTool =
      entry.kind === "tool" || entry.kind === "mcp-tool"
        ? options.tools.resolveByCapabilityId(entry.capabilityId)
        : null;
    const policyReason =
      nativeTool === null ? null : policyOmissionReason(nativeTool, options.policy);
    const enabled =
      operational.allowed &&
      !operational.denied &&
      !operational.quarantined &&
      !operational.incompatible &&
      policyReason === null;
    const prepared =
      entry.state.availability === "available" || entry.state.availability === "degraded";
    const preparable = entry.state.preparable === true;
    const toolName = nativeTool?.manifest.name ?? null;
    const alreadyDisclosed =
      toolName !== null &&
      (options.disclosed.has(toolName) || pending.some((item) => item.name === toolName));
    const schemaOpen =
      nativeTool !== null &&
      !RAW_PROTOCOL_ESCAPES.has(nativeTool.manifest.name) &&
      !isClosedProductToolSchema(jsonSchemaFor(nativeTool.manifest.inputSchema));
    const executable =
      nativeTool !== null &&
      enabled &&
      entry.state.executable &&
      health?.selectable === true &&
      !schemaOpen;
    const reasons: string[] = [];
    let status: CapabilityDiscoveryStatus;
    if (entry.kind === "skill") {
      status = "instruction-content";
      reasons.push("a skill is instruction content, not an executable operation");
    } else if (entry.kind !== "tool" && entry.kind !== "mcp-tool") {
      status = "not-an-operation";
      reasons.push(`a ${entry.kind} contribution is not a model-callable operation`);
    } else if (nativeTool === null) {
      status = "unavailable";
      reasons.push("no executable binding is registered in this catalog generation");
    } else if (policyReason !== null) {
      status = "unavailable";
      reasons.push(policyReason);
    } else if (schemaOpen) {
      status = "unavailable";
      reasons.push("permissive model-boundary schema");
    } else if (!executable) {
      status = preparable && !prepared ? "needs-preparation" : "unavailable";
      if (status === "needs-preparation")
        reasons.push("not prepared; discovery does not prepare or start it");
    } else if (alreadyDisclosed) {
      status = "callable";
    } else {
      status = "not-loaded";
    }
    if (status !== "callable" && status !== "not-loaded") {
      for (const reason of [
        entry.state.availabilityReason,
        entry.state.executionReason,
        ...healthReasons(health),
      ])
        if (reason !== null && !reasons.includes(reason)) reasons.push(reason);
    }
    return {
      capabilityId: String(entry.capabilityId),
      name: toolName ?? entry.name,
      kind: entry.kind,
      title: bounded(entry.title, 120),
      summary: bounded(entry.summary, CAPABILITY_DISCOVERY_LIMITS.summaryCharacters),
      effect: entry.effect,
      source: entry.source,
      readiness: {
        registered: true,
        enabled,
        preparable,
        prepared,
        disclosed: alreadyDisclosed,
        executable,
      },
      status,
      tool: toolName,
      reasons: reasons.slice(0, CAPABILITY_DISCOVERY_LIMITS.maxReasons),
      recovery: healthRecovery(health).slice(0, CAPABILITY_DISCOVERY_LIMITS.maxReasons),
    };
  };

  /** Admit one executable, undisclosed native tool within the per-attempt bounds. */
  const load = (described: CapabilityDiscoveryEntry): CapabilityDiscoveryEntry => {
    if (described.status !== "not-loaded" || described.tool === null) return described;
    const native = options.tools.resolveByName(described.tool);
    if (native === null) return described;
    const parameters = jsonSchemaFor(native.manifest.inputSchema);
    const tokens = measureProductToolSchema(parameters).tokensEstimated;
    if (admitted.length + pending.length >= CAPABILITY_DISCOVERY_LIMITS.loadedToolsPerAttempt)
      return { ...described, reasons: ["discovered-tool limit for this attempt is reached"] };
    if (loadedTokens + tokens > CAPABILITY_DISCOVERY_LIMITS.loadedSchemaTokensPerAttempt)
      return { ...described, reasons: ["discovered-tool schema budget for this attempt is spent"] };
    pending.push({
      name: native.manifest.name,
      description: native.manifest.description,
      parameters,
    });
    loadedTokens += tokens;
    return { ...described, status: "callable-next-step" };
  };

  const discover = (request: ToolRunnerRequest): ToolInvocationOutcome => {
    if (request.signal.aborted) return { status: "cancelled", effect: "none" };
    const capabilities = options.capabilities;
    if (capabilities === undefined)
      return { status: "unavailable", reason: "capability-registry-unavailable", effect: "none" };
    const query = String(request.input.query ?? "");
    const cursor = Number(request.input.cursor ?? 0);
    const refused = (
      refusal: (typeof CAPABILITY_DISCOVERY_REFUSALS)[number],
    ): ToolInvocationOutcome => {
      const output: CapabilityDiscoveryResult = {
        catalog: handle,
        query,
        total: 0,
        cursor,
        nextCursor: null,
        remainingCalls: CAPABILITY_DISCOVERY_LIMITS.callsPerAttempt - calls,
        refusal,
        entries: [],
      };
      return { status: "completed", output, effect: "completed" };
    };
    if (capabilities.generation !== options.tools.generation)
      return { status: "unavailable", reason: "stale-tool-catalog", effect: "none" };
    // A handle from an earlier generation reads nothing; the result names the current one.
    if (String(request.input.catalog) !== handle) return refused("stale-catalog-generation");
    if (calls >= CAPABILITY_DISCOVERY_LIMITS.callsPerAttempt) return refused("discovery-exhausted");
    calls += 1;
    const terms = words(query);
    const kinds = Array.isArray(request.input.kinds)
      ? new Set(request.input.kinds.map(String))
      : null;
    const health = inspectCapabilityHealth(capabilities, "native-model", {
      ...(options.clock === undefined ? {} : { now: options.clock.now() }),
      deniedEffects: options.policy.deniedEffects,
      deniedNames: options.policy.deniedToolNames,
      runtime: { attemptRunner: "available", provider: "available", workspace: "available" },
    });
    const healthById = new Map(health.entries.map((entry) => [entry.capabilityId, entry]));
    const matches: Candidate[] = [];
    for (const [order, entry] of capabilities.entries.entries()) {
      if (entry.name === PRODUCT_DISCOVERY_TOOL_NAME && entry.source === "builtin") continue;
      if (kinds !== null && !kinds.has(entry.kind)) continue;
      const text = words(
        [entry.title, entry.summary, entry.namespace, entry.name, entry.kind].join(" "),
      );
      const score = terms.filter((term) => text.some((word) => word.includes(term))).length;
      if (terms.length > 0 && score === 0) continue;
      matches.push({ entry, score, order });
    }
    matches.sort((left, right) => right.score - left.score || left.order - right.order);
    const limit = Number(request.input.limit ?? CAPABILITY_DISCOVERY_LIMITS.defaultPageSize);
    const page = matches.slice(cursor, cursor + limit);
    const entries = page.map(({ entry }) =>
      load(describe(entry, healthById.get(entry.capabilityId))),
    );
    if (request.signal.aborted) return { status: "cancelled", effect: "none" };
    const output: CapabilityDiscoveryResult = {
      catalog: handle,
      query,
      total: matches.length,
      cursor,
      nextCursor: cursor + page.length < matches.length ? cursor + page.length : null,
      remainingCalls: CAPABILITY_DISCOVERY_LIMITS.callsPerAttempt - calls,
      refusal: null,
      entries,
    };
    return { status: "completed", output, effect: "completed" };
  };

  return {
    wrap(runner) {
      return {
        ...(runner.hasBinding === undefined ? {} : { hasBinding: runner.hasBinding.bind(runner) }),
        async execute(request) {
          const entry = options.tools.resolveByName(request.toolName);
          if (
            request.toolName === PRODUCT_DISCOVERY_TOOL_NAME &&
            entry?.manifest.source === "builtin" &&
            entry.manifest.capabilityId === request.capabilityId
          )
            return discover(request);
          return runner.execute(request);
        },
      };
    },
    admitPending() {
      const next = pending.splice(0, pending.length);
      for (const definition of next) {
        options.disclosed.add(definition.name);
        admitted.push(definition);
      }
      return next;
    },
    admitted: () => [...admitted],
  };
}
