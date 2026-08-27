/** Provider-neutral model input derived from one composed prompt (#786). */

import type { ComposedPromptRequest, RenderedPromptSection } from "../domain/index.ts";
import type { ModelMessage } from "../providers/index.ts";
import type { ProductToolDisclosure } from "./product-tool-disclosure.ts";
import type { AttemptModelInput } from "./turn-attempt-policy.ts";

const SYSTEM_ROLES = new Set([
  "product-invariant",
  "user-instruction",
  "project-instruction",
  "skill-workflow",
  "brief",
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
  return [
    `[capability-disclosure source=${disclosure.receipt.discoveryHandle}]`,
    `Families: ${families}`,
    `Executable tools for this attempt: ${tools || "none"}`,
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
): AttemptModelInput {
  const system = prompt.sections.filter((section) => SYSTEM_ROLES.has(section.role));
  const user = prompt.sections.filter((section) => !SYSTEM_ROLES.has(section.role));
  const messages = [
    message("system", renderSections(system)),
    message("system", capabilityBrief(disclosure)),
    message("user", renderSections(user)),
  ].filter((entry): entry is ModelMessage => entry !== null);
  return {
    messages,
    tools: disclosure.modelTools,
    output: { kind: "text" },
    budgets: {},
    disclosure: {
      catalogGeneration: disclosure.receipt.catalogGeneration,
      toolNames: disclosure.receipt.disclosed.map((tool) => tool.name),
      discoveryHandle: disclosure.receipt.discoveryHandle,
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
