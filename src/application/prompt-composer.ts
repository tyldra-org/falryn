/**
 * Application boundary for deterministic turn prompt composition.
 *
 * Wraps the pure domain composer and attaches a content digest over the
 * canonical form so cache keys and inspection share one identity. The hasher
 * is injected — this layer depends only on `src/domain`, never on host crypto
 * adapters. Does not progress the turn state machine, call providers, or
 * persist events.
 */

import {
  type ComposedPromptRequest,
  type ComposePromptError,
  type ComposePromptInput,
  type ContentDigest,
  type ContentHasherPort,
  composePromptRequest,
  err,
  ok,
  type Result,
  type TurnId,
} from "../domain/index.ts";

export type DigestedPromptRequest = ComposedPromptRequest & {
  readonly compositionDigest: ContentDigest;
};

export type PromptComposerError =
  | ComposePromptError
  | { readonly code: "turn-mismatch"; readonly expected: TurnId; readonly actual: TurnId };

export type PromptComposerResult = Result<DigestedPromptRequest, PromptComposerError>;

export type PromptComposerOptions = {
  readonly hasher: ContentHasherPort;
};

export type PromptComposer = {
  compose(input: ComposePromptInput): PromptComposerResult;
  /**
   * Same as {@link compose}, but refuses when the input turn does not match the
   * turn identity the caller is assembling context for.
   */
  composeForTurn(turnId: TurnId, input: ComposePromptInput): PromptComposerResult;
};

export function createPromptComposer(options: PromptComposerOptions): PromptComposer {
  const { hasher } = options;

  const digestCanonical = (canonicalForm: string): ContentDigest => {
    const hash = hasher.create();
    hash.update(new TextEncoder().encode(canonicalForm));
    return hash.digest();
  };

  const compose = (input: ComposePromptInput): PromptComposerResult => {
    const composed = composePromptRequest(input);
    if (!composed.ok) {
      return err(composed.error);
    }
    return ok({
      ...composed.value,
      compositionDigest: digestCanonical(composed.value.canonicalForm),
    });
  };

  return {
    compose,
    composeForTurn(turnId, input) {
      if (input.turnId !== turnId) {
        return err({
          code: "turn-mismatch",
          expected: turnId,
          actual: input.turnId,
        });
      }
      return compose(input);
    },
  };
}
