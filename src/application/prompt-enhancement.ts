/**
 * Prompt enhancement port (#279).
 *
 * Local normalization is in-process. A model path is a typed refusal until a
 * provider exists (#33). Neither path submits, executes tools, or replaces a
 * draft; the composer applies a proposal only on an explicit accept.
 */

import {
  type EnhancementOutcome,
  type EnhancementRequest,
  explainNormalization,
  normalizePromptDraft,
} from "../domain/index.ts";

export const ENHANCEMENT_MODEL_OWNER = "#33";

export function enhancePrompt(request: EnhancementRequest): EnhancementOutcome {
  switch (request.path) {
    case "model":
      return {
        kind: "unavailable",
        reason: "no provider is configured, so nothing can rewrite a prompt yet",
        owner: ENHANCEMENT_MODEL_OWNER,
      };
    case "local":
      return enhanceLocal(request);
    default: {
      const exhaustive: never = request.path;
      return exhaustive;
    }
  }
}

function enhanceLocal(request: EnhancementRequest): EnhancementOutcome {
  const { proposed, changes } = normalizePromptDraft(request.text);
  if (proposed.length === 0) {
    return { kind: "empty" };
  }
  if (proposed === request.text) {
    return { kind: "unchanged", revision: request.revision };
  }
  return {
    kind: "proposal",
    original: request.text,
    proposed,
    explanation: explainNormalization(changes),
    revision: request.revision,
  };
}
