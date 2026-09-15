/** Live-session admission captured from the real composed request, never a helper prompt. */

import type { CheckpointAuthority } from "../../domain/compression/history-projection.ts";
import { HARD_CONTEXT_MAX_TOTAL_TOKENS } from "../../domain/context/context-budget.ts";
import type { ModelCapability, ProviderModelIdentity } from "../../providers/index.ts";
import { providerModelIdentityKey } from "../../providers/index.ts";
import type { attemptModelInputFromPrompt } from "../context/product-model-input.ts";
import { createRuntimeProjectionRedactor } from "../diagnostics/redaction.ts";
import type { ProductTaskResources } from "../orchestration/product-resources.ts";
import { historyDigest } from "../sessions/session-history.ts";
import {
  type CheckpointOutcome,
  type CheckpointRequest,
  createProductCheckpointAction,
} from "./product-checkpoint.ts";

export function createLiveCheckpoint(
  options: Omit<Parameters<typeof createProductCheckpointAction>[0], "authority" | "settled"> & {
    readonly current: () => {
      readonly model: ProviderModelIdentity | null;
      readonly generation: number;
      readonly profile: string;
      readonly policy: unknown;
    };
  },
) {
  let active = 0;
  let compacting = false;
  let captured: { readonly key: string; readonly authority: CheckpointAuthority } | null = null;
  const key = () => historyDigest(JSON.stringify(options.current()));
  const action = createProductCheckpointAction({
    ...options,
    settled: () => active === 0,
    authority: () => (captured?.key === key() ? captured.authority : null),
  });
  return {
    begin() {
      active += 1;
      captured = null;
      return () => {
        active -= 1;
      };
    },
    isCompacting: () => compacting,
    capture(
      input: ReturnType<typeof attemptModelInputFromPrompt>,
      model: ModelCapability | undefined,
      contextGeneration: string,
    ) {
      const current = options.current();
      const { history: _history, ...request } = input;
      const text = JSON.stringify(request);
      if (
        !model?.contextTokens ||
        !model.outputTokens ||
        !current.model ||
        createRuntimeProjectionRedactor().redactText(text, 4 * 1024 * 1024) !== text ||
        input.messages.some((message) => message.parts.some((part) => part.kind !== "text"))
      )
        return;
      const output = Math.min(
        input.budgets?.maxOutputTokens ?? model.outputTokens,
        model.outputTokens,
      );
      captured = {
        key: key(),
        authority: {
          model: providerModelIdentityKey(current.model),
          configurationGeneration: current.generation,
          policyGeneration: current.generation,
          instructionDigest: historyDigest(text),
          protectedRequest: text,
          contextGeneration,
          contextWindowTokens: Math.min(model.contextTokens, HARD_CONTEXT_MAX_TOTAL_TOKENS),
          systemAndSkillsTokens: Math.ceil(Buffer.byteLength(text) / 4),
          freshToolsTokens: 0,
          freshResultsTokens: 0,
          modalityTokens: 0,
          reservedOutputTokens: output,
          reservedContinuationTokens: output,
        },
      };
    },
    async run(
      request: CheckpointRequest,
      resources: ProductTaskResources,
      signal: AbortSignal,
    ): Promise<CheckpointOutcome> {
      if (active || compacting) return { kind: "refused", reason: "busy", effect: "none" };
      compacting = true;
      try {
        return await action.run(request, resources, signal);
      } finally {
        compacting = false;
      }
    },
  };
}

/** Hold the same live-session exclusion from the first await through terminal settlement. */
export function guardCheckpointTurn<Input, Output>(
  checkpoint: ReturnType<typeof createLiveCheckpoint> | null,
  busy: () => Output,
  run: (input: Input) => Promise<Output>,
): (input: Input) => Promise<Output> {
  return async (input) => {
    if (checkpoint?.isCompacting()) return busy();
    const finish = checkpoint?.begin();
    try {
      return await run(input);
    } finally {
      finish?.();
    }
  };
}
