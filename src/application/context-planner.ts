/**
 * Live-turn context planner (#715).
 *
 * Admits already-resolved evidence candidates, packs them through
 * {@link composeContextPack}, and maps the pack onto prompt `evidence`
 * sections for {@link createPromptComposer}. Never claims exact-source for
 * narrowed or reduced items. Index builders and memory admission remain
 * sibling owners under #701.
 */

import {
  type ComposedContextPack,
  type ComposedPromptRequest,
  type ComposePromptError,
  type ComposePromptInput,
  type ConfigurationGeneration,
  type ContextComposeError,
  type ContextComposeInput,
  composeContextPack,
  composePromptRequest,
  type EvidenceCandidate,
  ok,
  type PromptSectionInput,
  type PromptToolInput,
  type Result,
  type SessionId,
  type TurnId,
  type WorkspaceId,
} from "../domain/index.ts";
import type {
  DigestedPromptRequest,
  PromptComposer,
  PromptComposerError,
} from "./prompt-composer.ts";

export const CONTEXT_PLANNER_OWNER = "#715";

export type ContextPlannerPlan = {
  readonly pack: ComposedContextPack;
  readonly sections: readonly PromptSectionInput[];
};

export type ContextPlannerError = ContextComposeError | ComposePromptError | PromptComposerError;

export type ContextPlannerComposeInput = {
  readonly turnId: TurnId;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly configurationGeneration: ConfigurationGeneration;
  readonly task: string;
  readonly candidates?: readonly EvidenceCandidate[];
  readonly otherSections?: readonly PromptSectionInput[];
  readonly tools?: readonly PromptToolInput[];
  readonly compose?: ContextComposeInput;
};

export type ContextPlannerComposeResult = {
  readonly plan: ContextPlannerPlan;
  readonly prompt: DigestedPromptRequest | ComposedPromptRequest;
};

export type ContextPlanner = {
  plan(
    candidates: readonly EvidenceCandidate[],
    compose?: ContextComposeInput,
  ): Result<ContextPlannerPlan, ContextComposeError>;
  composeTurn(
    input: ContextPlannerComposeInput,
    promptComposer?: PromptComposer,
  ): Result<ContextPlannerComposeResult, ContextPlannerError>;
};

function formatUncertainty(pack: ComposedContextPack, itemIndex: number): string {
  const item = pack.items[itemIndex];
  if (item === undefined) {
    return "";
  }
  const flags = [
    ...item.uncertainty,
    ...(item.narrowed ? (["narrowed"] as const) : []),
    ...(item.claimsExact ? [] : (["not-exact-source"] as const)),
  ];
  return flags.length === 0 ? "" : ` [${flags.join(",")}]`;
}

function evidenceSection(pack: ComposedContextPack, itemIndex: number): PromptSectionInput | null {
  const item = pack.items[itemIndex];
  if (item === undefined) {
    return null;
  }
  const body =
    item.excerpt !== null && item.excerpt.length > 0
      ? item.excerpt
      : item.candidate.payload.kind === "inline"
        ? item.candidate.payload.text
        : `(artifact evidence ${item.candidate.origin}; expand via handle)`;
  const header = `citation:${item.citation.id} origin:${item.citation.origin} role:${item.role}${formatUncertainty(pack, itemIndex)}`;
  return {
    id: `evidence:${item.citation.id}`,
    role: "evidence",
    source: `context-planner:${item.citation.origin}`,
    content: `${header}\n${body}`,
    required: false,
    available: true,
    estimatedTokens: item.estimatedTokens,
  };
}

/**
 * Build the product context planner for live turns and prompt composition.
 */
export function createContextPlanner(): ContextPlanner {
  return {
    plan(candidates, compose = {}) {
      const packed = composeContextPack(candidates, compose);
      if (!packed.ok) {
        return packed;
      }
      const sections: PromptSectionInput[] = [];
      for (let index = 0; index < packed.value.items.length; index += 1) {
        const section = evidenceSection(packed.value, index);
        if (section !== null) {
          sections.push(section);
        }
      }
      return ok({ pack: packed.value, sections });
    },

    composeTurn(input, promptComposer) {
      const planned = this.plan(input.candidates ?? [], input.compose ?? {});
      if (!planned.ok) {
        return planned;
      }

      const productInvariant: PromptSectionInput = {
        id: "product-invariant",
        role: "product-invariant",
        source: `product:${CONTEXT_PLANNER_OWNER}`,
        content:
          "Falryn product invariants: never invent exact-source claims for reduced or narrowed evidence.",
        required: true,
        available: true,
      };

      const taskSection: PromptSectionInput = {
        id: "task",
        role: "task",
        source: "user",
        content: input.task,
        required: true,
        available: true,
      };

      const composeInput: ComposePromptInput = {
        turnId: input.turnId,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        configurationGeneration: input.configurationGeneration,
        sections: [
          productInvariant,
          ...(input.otherSections ?? []),
          taskSection,
          ...planned.value.sections,
        ],
        tools: input.tools ?? [],
      };

      if (promptComposer !== undefined) {
        const digested = promptComposer.composeForTurn(input.turnId, composeInput);
        if (!digested.ok) {
          return digested;
        }
        return ok({ plan: planned.value, prompt: digested.value });
      }

      const composed = composePromptRequest(composeInput);
      if (!composed.ok) {
        return composed;
      }
      return ok({ plan: planned.value, prompt: composed.value });
    },
  };
}
