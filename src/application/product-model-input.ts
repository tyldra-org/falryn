/** Provider-neutral model input derived from one composed prompt (#786). */

import type {
  BriefProjection,
  BriefRequest,
  ComposedPromptRequest,
  EffectiveExecutionPolicy,
  RenderedPromptSection,
} from "../domain/index.ts";
import type { ModelMessage } from "../providers/index.ts";
import type { ProductToolDisclosure } from "./product-tool-disclosure.ts";
import { promptCacheStablePrefixDigest } from "./provider-prompt-cache.ts";
import type { AttemptModelInput } from "./turn-attempt-policy.ts";

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
  const families = disclosure.receipt.families
    .map((entry) =>
      entry.available
        ? `${entry.family}=available`
        : `${entry.family}=unavailable(${entry.reason ?? "unavailable"})`,
    )
    .join(", ");
  const tools = disclosure.receipt.disclosed.map((tool) => tool.name).join(", ");
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
    `[capability-disclosure source=${disclosure.receipt.discoveryHandle}]`,
    `Families: ${families}`,
    `Executable tools for this attempt: ${tools || "none"}`,
    `Other disclosed capabilities: ${otherCapabilities || "none"}`,
    `Capability routing facts: ${routingFacts || "none"}`,
    `Registry inventory: ${disclosure.receipt.registryTotal} validated contributions in this generation.`,
    `Additional capabilities are discoverable through ${disclosure.receipt.discoveryHandle}; registered tools omitted here are not executable in this attempt.`,
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
    readonly brief?: { readonly request: BriefRequest; readonly projection: BriefProjection };
    readonly maxOutputTokens?: number;
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
    message("user", renderSections(user)),
  ].filter((entry): entry is ModelMessage => entry !== null);
  return {
    messages,
    promptCache: {
      stableMessageCount: stableMessages.length,
      stablePrefixDigest: promptCacheStablePrefixDigest(stableMessages, disclosure.modelTools),
      toolCatalogGeneration: Number(disclosure.receipt.catalogGeneration),
    },
    tools: disclosure.modelTools,
    output: { kind: "text" },
    budgets: {
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
      toolNames: disclosure.receipt.disclosed.map((tool) => tool.name),
      discoveryHandle: disclosure.receipt.discoveryHandle,
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
      omitted: disclosure.receipt.omitted,
      schemaBytes: disclosure.receipt.schemaBytes,
      schemaTokensEstimated: disclosure.receipt.schemaTokensEstimated,
    },
  };
}
