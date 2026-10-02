/** Provider-neutral model input derived from one composed prompt (#786). */

import type { BriefProjection, BriefRequest } from "../../domain/compression/index.ts";
import type { ComposedPromptRequest, RenderedPromptSection } from "../../domain/context/index.ts";
import type { EffectiveExecutionPolicy } from "../../domain/sessions/index.ts";
import { callableName } from "../../domain/tools/index.ts";
import type { ModelMessage, OutputContract } from "../../providers/index.ts";
import { promptCacheStablePrefixDigest } from "../providers/provider-prompt-cache.ts";
import type { AttemptModelInput } from "../runtime/turn-attempt-policy.ts";
import { PRODUCT_DISCOVERY_TOOL_NAME } from "../tools/product-capability-discovery.ts";
import type { ProductToolDisclosure } from "../tools/product-tool-disclosure.ts";

const STABLE_SYSTEM_ROLES = new Set([
  "product-invariant",
  "user-instruction",
  "project-instruction",
  "skill-workflow",
]);

function renderSections(sections: readonly RenderedPromptSection[]): string {
  return sections
    .map((section) => `[${section.role} source=${section.source}]\n${section.content}`)
    .join("\n\n");
}

function message(role: "system" | "user", text: string): ModelMessage | null {
  return text.length === 0 ? null : { role, parts: [{ kind: "text", text }] };
}

function capabilityBrief(disclosure: ProductToolDisclosure): string {
  const plan = disclosure.receipt.opportunityPlan;
  // Grouped members are named as the profile call the model can make (#946).
  const callable = (name: string): string => callableName(disclosure.receipt.profiles, name);
  const fallbackSummary = plan.fallbacks
    .slice(0, 5)
    .map((entry) => `${entry.name}(${entry.reasons.join("+")})`)
    .join(", ");
  const rejectedSummary = plan.rejected
    .slice(0, 5)
    .map((entry) => `${entry.name}:${entry.decision}(${entry.reasons.join("+")})`)
    .join(", ");
  const shownRejected = Math.min(5, plan.rejected.length);
  const hiddenRejected = plan.rejected.length - shownRejected + plan.omittedRejected;
  const decisionById = new Map(
    [...plan.selected, ...plan.rejected].map((decision) => [decision.capabilityId, decision]),
  );
  const degradationSummary = plan.degradation.transitions
    .slice(0, 5)
    .map((transition) => {
      const from = callable(decisionById.get(transition.fromCapabilityId)?.name ?? "unknown");
      const to = callable(decisionById.get(transition.toCapabilityId)?.name ?? "unknown");
      return `${from}->${to}(${transition.effectChange};model-continuation)`;
    })
    .join(", ");
  const families = disclosure.receipt.families
    .map((entry) =>
      entry.available
        ? `${entry.family}=available`
        : `${entry.family}=unavailable(${entry.reason ?? "unavailable"})`,
    )
    .join(", ");
  // What the model can call: eager definitions, a profile named with its operations (#946).
  const profileOperations = new Map(
    disclosure.receipt.profiles.map((profile) => [
      profile.name,
      profile.operations.map((operation) => operation.operation).join("|"),
    ]),
  );
  const tools = disclosure.modelTools
    .filter((tool) => tool.deferred !== true)
    .map((tool) => {
      const operations = profileOperations.get(tool.name);
      return operations === undefined ? tool.name : `${tool.name}(${operations})`;
    })
    .join(", ");
  const deferredTools = disclosure.receipt.deferred.map((tool) => tool.name).join(", ");
  const otherCapabilities = disclosure.receipt.capabilityCards
    .filter((entry) => entry.kind !== "tool" && entry.kind !== "mcp-tool")
    .map((entry) => `${entry.kind}:${entry.title}`)
    .join(", ");
  const routingFacts = disclosure.receipt.capabilityCards
    .map((entry) => {
      const health = disclosure.receipt.health.entries.find(
        (candidate) => candidate.capabilityId === entry.capabilityId,
      );
      const reasons = health?.diagnostics.map((diagnostic) => diagnostic.code).join("+") ?? "none";
      return `${entry.title}[effect=${entry.effect};health=${health?.health ?? "unknown"};selectable=${health?.selectable ?? false};reasons=${reasons};cost=${entry.costClass};latency=${entry.latencyClass}]`;
    })
    .join(", ");
  return [
    `[capability-disclosure source=${disclosure.receipt.discoveryHandle} plan=${plan.planId}]`,
    `Preferred path: ${plan.primaryFamily}; fallbacks: ${plan.fallbackFamilies.join(", ") || "none"}.`,
    `Deterministically selected: ${plan.selected.map((entry) => callable(entry.name)).join(", ") || "none"}.`,
    `Candidate fallbacks: ${fallbackSummary || "none"}.`,
    `Rejected or unavailable: ${rejectedSummary || "none"}; ${shownRejected} shown, ${hiddenRejected} omitted.`,
    `Automation opportunities: ${plan.opportunities.map((entry) => `${entry.kind}=${entry.decision}`).join(", ")}.`,
    `Routing-model assistance: ${plan.modelAssistance.decision} (${plan.modelAssistance.reason}).`,
    `Explicit degradation: ${degradationSummary || "none"}; ${plan.degradation.terminalOutcomes.length} terminal unavailable outcomes; at most ${plan.degradation.maxRuntimeTransitions} runtime transitions.`,
    `Schema budget: ${plan.schemaTokensEstimated}/${plan.schemaTokenBudget} estimated tokens across ${plan.selected.length}/${plan.selectionLimit} selected slots.`,
    `Families: ${families}`,
    `Executable tools for this attempt: ${tools || "none"}`,
    `Deferred tool definitions (loadable through the provider's tool search where supported): ${deferredTools || "none"}`,
    `Other disclosed capabilities: ${otherCapabilities || "none"}`,
    `Capability routing facts: ${routingFacts || "none"}`,
    `Registry inventory: ${disclosure.receipt.registryTotal} validated contributions in this generation.`,
    disclosure.receipt.disclosed.some((tool) => tool.name === PRODUCT_DISCOVERY_TOOL_NAME)
      ? `Use the tools above directly. When none fits, call ${PRODUCT_DISCOVERY_TOOL_NAME} with catalog ${disclosure.receipt.discoveryHandle} and a few task words; an executable tool it reports as callable-next-step can be called by name in your next step. Other registered tools are not executable in this attempt.`
      : "Registered tools omitted here are not executable in this attempt.",
  ].join("\n");
}

/**
 * Keep authority classes separate at the provider boundary while preserving
 * the prompt composer's deterministic section order within each class.
 */
export function attemptModelInputFromPrompt(
  prompt: ComposedPromptRequest,
  disclosure: ProductToolDisclosure,
  executionPolicy: EffectiveExecutionPolicy,
  options: {
    readonly history?: import("../sessions/conversation-history.ts").ConversationHistorySnapshot;
    readonly brief?: { readonly request: BriefRequest; readonly projection: BriefProjection };
    readonly maxOutputTokens?: number;
    readonly maxInputTokens?: number;
    readonly output?: OutputContract;
  } = {},
): AttemptModelInput {
  const stableSystem = prompt.sections.filter((section) => STABLE_SYSTEM_ROLES.has(section.role));
  const brief = prompt.sections.filter((section) => section.role === "brief");
  const user = prompt.sections.filter(
    (section) => !STABLE_SYSTEM_ROLES.has(section.role) && section.role !== "brief",
  );
  const stableMessages = [
    message("system", renderSections(stableSystem)),
    message("system", capabilityBrief(disclosure)),
  ].filter((entry): entry is ModelMessage => entry !== null);
  const messages = [
    ...stableMessages,
    message("system", renderSections(brief)),
    ...(options.history?.messages ?? []),
    message("user", renderSections(user)),
  ].filter((entry): entry is ModelMessage => entry !== null);
  return {
    ...(options.history ? { history: options.history } : {}),
    messages,
    promptCache: {
      stableMessageCount: stableMessages.length,
      stablePrefixDigest: promptCacheStablePrefixDigest(stableMessages, disclosure.modelTools),
      toolCatalogGeneration: Number(disclosure.receipt.catalogGeneration),
    },
    tools: disclosure.modelTools,
    output: options.output ?? { kind: "text" },
    budgets: {
      ...(options.maxInputTokens === undefined ? {} : { maxInputTokens: options.maxInputTokens }),
      ...(options.brief === undefined && options.maxOutputTokens === undefined
        ? {}
        : {
            maxOutputTokens: Math.min(
              options.brief?.projection.receipt.outputTokenBudget ?? Number.POSITIVE_INFINITY,
              options.maxOutputTokens ?? Number.POSITIVE_INFINITY,
            ),
          }),
    },
    executionPolicy,
    ...(options.brief === undefined
      ? {}
      : {
          brief: {
            request: options.brief.request,
            receipt: options.brief.projection.receipt,
            sectionSource: `brief:${options.brief.projection.receipt.policySource}`,
            fallbackGuidance: options.brief.projection.guidance,
            semanticGuidance: options.brief.projection.semanticGuidance,
            ...(options.maxOutputTokens === undefined
              ? {}
              : { maxOutputTokensCeiling: options.maxOutputTokens }),
          },
        }),
    disclosure: {
      catalogGeneration: disclosure.receipt.catalogGeneration,
      toolNames: [
        ...disclosure.receipt.disclosed.map((tool) => tool.name),
        ...disclosure.receipt.deferred.map((tool) => tool.name),
      ],
      discoveryHandle: disclosure.receipt.discoveryHandle,
      opportunityPlan: disclosure.receipt.opportunityPlan,
      capabilityCatalog: {
        total: disclosure.receipt.registryTotal,
        counts: disclosure.receipt.registryCounts,
        cards: disclosure.receipt.capabilityCards.map((card) => ({
          capabilityId: card.capabilityId,
          kind: card.kind,
          family: card.family,
          source: card.source,
          version: card.version,
          costClass: card.costClass,
          latencyClass: card.latencyClass,
          available: card.lifecycle.available,
          executable: card.lifecycle.executable,
          disclosed: card.lifecycle.disclosed,
          health:
            disclosure.receipt.health.entries.find(
              (entry) => entry.capabilityId === card.capabilityId,
            )?.health ?? "unknown",
          selected:
            disclosure.receipt.health.entries.find(
              (entry) => entry.capabilityId === card.capabilityId,
            )?.selected ?? false,
          projected:
            disclosure.receipt.health.entries.find(
              (entry) => entry.capabilityId === card.capabilityId,
            )?.projected ?? false,
          diagnosticCodes:
            disclosure.receipt.health.entries
              .find((entry) => entry.capabilityId === card.capabilityId)
              ?.diagnostics.map((diagnostic) => diagnostic.code) ?? [],
        })),
      },
      families: disclosure.receipt.families,
      tools: disclosure.receipt.disclosed.map((tool) => ({
        name: tool.name,
        capabilityId: tool.capabilityId,
        version: tool.version,
        schemaDigest: tool.schemaDigest,
        schemaBytes: tool.schemaBytes,
        schemaTokensEstimated: tool.schemaTokensEstimated,
      })),
      profiles: disclosure.receipt.profiles.map((profile) => ({
        name: profile.name,
        profileId: profile.profileId,
        version: profile.version,
        operations: profile.operations.map(({ operation, toolName }) => ({ operation, toolName })),
        schemaDigest: profile.schemaDigest,
        schemaBytes: profile.schemaBytes,
        schemaTokensEstimated: profile.schemaTokensEstimated,
      })),
      deferred: disclosure.receipt.deferred.map((tool) => ({
        name: tool.name,
        capabilityId: tool.capabilityId,
        version: tool.version,
        schemaDigest: tool.schemaDigest,
        schemaBytes: tool.schemaBytes,
        schemaTokensEstimated: tool.schemaTokensEstimated,
      })),
      omitted: disclosure.receipt.omitted,
      schemaBytes: disclosure.receipt.schemaBytes,
      schemaTokensEstimated: disclosure.receipt.schemaTokensEstimated,
    },
  };
}
