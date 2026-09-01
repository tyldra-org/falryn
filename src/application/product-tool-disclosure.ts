/**
 * Bounded product-tool disclosure for one provider attempt (#786).
 *
 * Registration and model visibility are deliberately separate. The provider
 * receives a small, deterministic subset of closed schemas plus the two
 * explicitly bounded process escape hatches. Everything else remains visible
 * in the receipt as omitted; it is never silently executable.
 */

import { z } from "zod";

import type {
  CapabilityCard,
  CapabilityConsumer,
  CapabilityHealthEntry,
  CapabilityHealthEvidence,
  CapabilityHealthSummary,
  CapabilityId,
  CapabilityLifecycle,
  CapabilityRegistry,
  ConfigurationGeneration,
  EffectClass,
  EffectiveExecutionPolicy,
  ModelCapabilityBrief,
  PromptToolInput,
  ToolCapabilityKind,
  ToolRegistry,
} from "../domain/index.ts";
import {
  CAPABILITY_CONTRIBUTION_KINDS,
  CAPABILITY_FAMILIES,
  capabilityCard,
  capabilityLifecycle,
  inspectCapabilityHealth,
  resolveExecutionProfile,
} from "../domain/index.ts";
import type { ModelToolDefinition, WorkIntent } from "../providers/index.ts";
import { createProductOpportunityPlan } from "./product-opportunity-plan.ts";
import { isClosedProductToolSchema, measureProductToolSchema } from "./product-tool-schema.ts";

export { measureProductToolSchema } from "./product-tool-schema.ts";

export const PRODUCT_TOOL_DISCLOSURE_SCHEMA_VERSION = 1;
/** Hard schema-count guard; profile ordering, not a per-mode quota, selects below it. */
export const MAX_DISCLOSED_PRODUCT_TOOLS = 24;

export const MODEL_CAPABILITY_FAMILIES = CAPABILITY_FAMILIES;

export type ModelCapabilityFamily = (typeof MODEL_CAPABILITY_FAMILIES)[number];

export type CapabilityFamilyAvailability = {
  readonly family: ModelCapabilityFamily;
  readonly available: boolean;
  readonly reason: string | null;
};

export type DisclosedProductTool = {
  readonly name: string;
  readonly capabilityId: CapabilityId;
  readonly version: number;
  readonly effect: EffectClass;
  readonly capabilityKind: ToolCapabilityKind;
  readonly schemaDigest: string;
  readonly schemaBytes: number;
  readonly schemaTokensEstimated: number;
  readonly lifecycle: CapabilityLifecycle;
};

export type CapabilityDisclosureReceipt = {
  readonly schemaVersion: typeof PRODUCT_TOOL_DISCLOSURE_SCHEMA_VERSION;
  readonly catalogGeneration: ConfigurationGeneration;
  readonly families: readonly CapabilityFamilyAvailability[];
  readonly capabilityCards: readonly CapabilityCard[];
  readonly health: {
    readonly consumer: CapabilityConsumer;
    readonly observedAt: CapabilityHealthEntry["diagnostics"][number]["observedAt"];
    readonly summary: CapabilityHealthSummary;
    readonly entries: readonly CapabilityHealthEntry[];
  };
  readonly opportunityPlan: ModelCapabilityBrief;
  readonly registryTotal: number;
  readonly registryCounts: Readonly<Record<string, number>>;
  readonly disclosed: readonly DisclosedProductTool[];
  readonly omitted: readonly { readonly name: string; readonly reason: string }[];
  readonly schemaBytes: number;
  readonly schemaTokensEstimated: number;
  readonly discoveryHandle: string;
};

export type ProductToolDisclosure = {
  readonly promptTools: readonly PromptToolInput[];
  readonly modelTools: readonly ModelToolDefinition[];
  readonly receipt: CapabilityDisclosureReceipt;
};

export type ProductToolDisclosureOptions = {
  readonly maximum?: number;
  readonly executionPolicy?: EffectiveExecutionPolicy;
  readonly consumer?: CapabilityConsumer;
  readonly healthEvidence?: CapabilityHealthEvidence;
  readonly task?: string;
  readonly intent?: WorkIntent;
  readonly preferredCapabilityIds?: readonly CapabilityId[];
  readonly schemaTokenBudget?: number;
};

const RAW_PROTOCOL_ESCAPES = new Set(["run_process", "run_shell"]);

function jsonSchemaFor(
  schema: z.ZodType<Readonly<Record<string, unknown>>>,
): Readonly<Record<string, unknown>> {
  return z.toJSONSchema(schema) as Readonly<Record<string, unknown>>;
}

function familyAvailability(
  health: readonly CapabilityHealthEntry[],
  policy: EffectiveExecutionPolicy | undefined,
): readonly CapabilityFamilyAvailability[] {
  const available = (family: ModelCapabilityFamily): boolean => {
    if (family === "capability") return true;
    return health.some((entry) => entry.family === family && entry.selectable);
  };
  return MODEL_CAPABILITY_FAMILIES.map((family) => ({
    family,
    available: available(family),
    reason: available(family)
      ? null
      : policy === undefined
        ? "no available descriptor in this catalog generation"
        : `no ${policy.profileId}-eligible descriptor available in this catalog generation`,
  }));
}

function policyOmissionReason(
  entry: ToolRegistry["entries"][number],
  policy: EffectiveExecutionPolicy | undefined,
): string | null {
  if (policy === undefined) {
    return null;
  }
  if (policy.deniedToolNames.includes(entry.manifest.name)) {
    return `denied by ${policy.profileId} profile tool policy`;
  }
  if (policy.deniedEffects.includes(entry.manifest.effect)) {
    return `effect ${entry.manifest.effect} denied by ${policy.profileId} profile`;
  }
  return null;
}

/** Select one task-aware, generation-bound schema set for a provider attempt. */
export function discloseProductTools(
  capabilityRegistry: CapabilityRegistry,
  registry: ToolRegistry,
  options: ProductToolDisclosureOptions = {},
): ProductToolDisclosure {
  if (capabilityRegistry.generation !== registry.generation) {
    throw new Error("capability and tool registry generations do not match");
  }
  const requestedMaximum = options.maximum ?? MAX_DISCLOSED_PRODUCT_TOOLS;
  const maximum = Math.min(
    MAX_DISCLOSED_PRODUCT_TOOLS,
    Math.max(
      1,
      Number.isFinite(requestedMaximum)
        ? Math.trunc(requestedMaximum)
        : MAX_DISCLOSED_PRODUCT_TOOLS,
    ),
  );
  const executionPolicy =
    options.executionPolicy ?? resolveExecutionProfile("agent", registry.generation);
  const consumer = options.consumer ?? "native-model";
  const healthEvidence: CapabilityHealthEvidence = {
    ...(options.healthEvidence ?? {}),
    ...(executionPolicy === undefined
      ? {}
      : {
          deniedEffects: executionPolicy.deniedEffects,
          deniedNames: executionPolicy.deniedToolNames,
        }),
  };
  const initialHealth = inspectCapabilityHealth(capabilityRegistry, consumer, healthEvidence);
  const healthById = new Map(initialHealth.entries.map((entry) => [entry.capabilityId, entry]));
  const opportunityPlan = createProductOpportunityPlan(
    capabilityRegistry,
    registry,
    initialHealth,
    executionPolicy,
    {
      ...(options.task === undefined ? {} : { task: options.task }),
      intent: options.intent ?? executionPolicy.workIntent,
      ...(options.preferredCapabilityIds === undefined
        ? {}
        : { preferredCapabilityIds: options.preferredCapabilityIds }),
      selectionLimit: maximum,
      ...(options.schemaTokenBudget === undefined
        ? {}
        : { schemaTokenBudget: options.schemaTokenBudget }),
    },
  );
  const selected = [];
  const omitted: { name: string; reason: string }[] = [];
  const omittedNames = new Set<string>();
  for (const planned of opportunityPlan.selected) {
    if (selected.length >= maximum) {
      break;
    }
    if (planned.kind !== "tool" && planned.kind !== "mcp-tool") continue;
    const entry = registry.resolveByCapabilityId(planned.capabilityId);
    if (entry === null) {
      continue;
    }
    const name = entry.manifest.name;
    const policyReason = policyOmissionReason(entry, executionPolicy);
    if (policyReason !== null) {
      omitted.push({ name, reason: policyReason });
      omittedNames.add(name);
      continue;
    }
    const capabilityHealth = healthById.get(entry.manifest.capabilityId);
    if (capabilityHealth === undefined || !capabilityHealth.selectable) {
      omitted.push({
        name,
        reason:
          capabilityHealth?.diagnostics[0] === undefined
            ? "capability health is unavailable"
            : `${capabilityHealth.diagnostics[0].code}: ${capabilityHealth.diagnostics[0].message}`,
      });
      omittedNames.add(name);
      continue;
    }
    const parameters = jsonSchemaFor(entry.manifest.inputSchema);
    if (!isClosedProductToolSchema(parameters) && !RAW_PROTOCOL_ESCAPES.has(name)) {
      omitted.push({ name, reason: "permissive model-boundary schema" });
      omittedNames.add(name);
      continue;
    }
    selected.push({ entry, parameters });
  }

  for (const entry of registry.entries) {
    const name = entry.manifest.name;
    if (
      selected.some((candidate) => candidate.entry.manifest.name === name) ||
      omittedNames.has(name)
    ) {
      continue;
    }
    const policyReason = policyOmissionReason(entry, executionPolicy);
    const planned = [...opportunityPlan.fallbacks, ...opportunityPlan.rejected].find(
      (candidate) => candidate.capabilityId === entry.manifest.capabilityId,
    );
    const capabilityHealth = healthById.get(entry.manifest.capabilityId);
    const reason =
      policyReason ??
      (capabilityHealth !== undefined && !capabilityHealth.selectable
        ? capabilityHealth.diagnostics[0] === undefined
          ? "capability health is unavailable"
          : `${capabilityHealth.diagnostics[0].code}: ${capabilityHealth.diagnostics[0].message}`
        : planned?.reasons.includes("schema-unavailable") === true
          ? "permissive model-boundary schema"
          : planned === undefined
            ? "bounded opportunity plan"
            : `${planned.decision}: ${planned.reasons.join(", ") || "not selected"}`);
    omitted.push({ name, reason });
    omittedNames.add(name);
  }

  const promptTools: PromptToolInput[] = selected.map(({ entry, parameters }) => ({
    name: entry.manifest.name,
    description: entry.manifest.description,
    parameters,
    required: false,
    available: true,
  }));
  const modelTools: ModelToolDefinition[] = selected.map(({ entry, parameters }) => ({
    name: entry.manifest.name,
    description: entry.manifest.description,
    parameters,
  }));
  const disclosed = selected.map(({ entry, parameters }) => {
    const measured = measureProductToolSchema(parameters);
    const capability = capabilityRegistry.resolveById(entry.manifest.capabilityId);
    if (capability === null) {
      throw new Error(`tool missing from capability registry: ${entry.manifest.name}`);
    }
    return {
      name: entry.manifest.name,
      capabilityId: entry.manifest.capabilityId,
      version: entry.manifest.version,
      effect: entry.manifest.effect,
      capabilityKind: entry.manifest.capabilityKind,
      schemaDigest: measured.digest,
      schemaBytes: measured.bytes,
      schemaTokensEstimated: measured.tokensEstimated,
      lifecycle: capabilityLifecycle(capability, { disclosed: true }),
    };
  });
  const disclosedIds = new Set(disclosed.map((entry) => entry.capabilityId));
  const plannedCardIds = new Set([
    ...opportunityPlan.selected.map((entry) => entry.capabilityId),
    ...opportunityPlan.fallbacks.map((entry) => entry.capabilityId),
    ...opportunityPlan.rejected
      .filter((entry) => entry.kind !== "tool" && entry.kind !== "mcp-tool")
      .filter((entry) =>
        entry.reasons.some((reason) =>
          [
            "explicit-capability",
            "user-preference",
            "task-term-match",
            "required-skill-match",
            "workflow-match",
          ].includes(reason),
        ),
      )
      .map((entry) => entry.capabilityId),
  ]);
  const capabilityCards = [
    ...disclosed.map((tool) => {
      const entry = capabilityRegistry.resolveById(tool.capabilityId);
      if (entry === null) throw new Error(`disclosed capability missing: ${tool.name}`);
      return capabilityCard(entry, { disclosed: true });
    }),
    ...capabilityRegistry.entries
      .filter((entry) => entry.kind !== "tool" && entry.kind !== "mcp-tool")
      .filter((entry) => !disclosedIds.has(entry.capabilityId))
      .filter((entry) => plannedCardIds.has(entry.capabilityId))
      .slice(0, Math.max(0, maximum - disclosed.length))
      .map((entry) => capabilityCard(entry, { disclosed: true })),
  ];
  const finalHealth = inspectCapabilityHealth(capabilityRegistry, consumer, {
    ...healthEvidence,
    disclosed: capabilityCards.map((card) => card.capabilityId),
    selected: opportunityPlan.selected.map((entry) => entry.capabilityId),
  });
  const registryCounts = Object.fromEntries(
    CAPABILITY_CONTRIBUTION_KINDS.map((kind) => [
      kind,
      capabilityRegistry.entries.filter((entry) => entry.kind === kind).length,
    ]),
  );
  return {
    promptTools,
    modelTools,
    receipt: {
      schemaVersion: PRODUCT_TOOL_DISCLOSURE_SCHEMA_VERSION,
      catalogGeneration: registry.generation,
      families: familyAvailability(finalHealth.entries, executionPolicy),
      capabilityCards,
      health: {
        consumer: finalHealth.consumer,
        observedAt: finalHealth.observedAt,
        summary: finalHealth.summary,
        entries: capabilityCards
          .map((card) =>
            finalHealth.entries.find((entry) => entry.capabilityId === card.capabilityId),
          )
          .filter((entry): entry is CapabilityHealthEntry => entry !== undefined),
      },
      opportunityPlan,
      registryTotal: capabilityRegistry.entries.length,
      registryCounts,
      disclosed,
      omitted,
      schemaBytes: disclosed.reduce((total, tool) => total + tool.schemaBytes, 0),
      schemaTokensEstimated: disclosed.reduce(
        (total, tool) => total + tool.schemaTokensEstimated,
        0,
      ),
      discoveryHandle: `capability-catalog:${capabilityRegistry.generation}`,
    },
  };
}
