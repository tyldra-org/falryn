/**
 * Deterministic in-memory provider adapter for contract tests.
 *
 * This is product-owned test support (like the domain in-memory blob store),
 * not a fixture module: it never reads the network, never holds credentials,
 * and never imports a vendor SDK.
 */

import { modelAttemptId, modelId, providerId } from "../domain/identity.ts";
import { modelRequestId } from "./identity.ts";
import type { ProviderAdapterPort } from "./port.ts";
import type { ModelRequest } from "./request.ts";
import type { NormalizedProviderEvent } from "./stream.ts";

export type DeterministicProviderScript =
  | { readonly kind: "text"; readonly text: string; readonly finishReason?: string }
  | { readonly kind: "error"; readonly message: string; readonly retryable?: boolean };

export type DeterministicProviderOptions = {
  readonly profileId?: string;
  readonly displayName?: string;
  readonly script?: DeterministicProviderScript;
};

export function createDeterministicProviderAdapter(
  options: DeterministicProviderOptions = {},
): ProviderAdapterPort {
  const identity = {
    providerId: providerId.from("falryn-deterministic"),
    profileId: options.profileId ?? "deterministic",
    displayName: options.displayName ?? "Deterministic fixture provider",
  };
  const models = [modelId.from("deterministic-echo")] as const;
  const script: DeterministicProviderScript = options.script ?? {
    kind: "text",
    text: "ok",
    finishReason: "stop",
  };

  return {
    identity,
    supportedModels: models,
    async *stream(request: ModelRequest, streamOptions): AsyncIterable<NormalizedProviderEvent> {
      const attempt = modelAttemptId.from(`attempt-${request.requestId}`);
      let sequence = 1;
      yield {
        kind: "request-started",
        requestId: request.requestId,
        modelAttemptId: attempt,
        sequence: sequence++,
      };

      if (streamOptions.signal.aborted) {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: sequence++,
          failure: {
            kind: "cancellation",
            retryable: false,
            message: "request cancelled before generation",
          },
        };
        return;
      }

      if (script.kind === "error") {
        yield {
          kind: "error",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: sequence++,
          failure: {
            kind: "server-failure",
            retryable: script.retryable ?? false,
            message: script.message,
          },
        };
        return;
      }

      yield {
        kind: "text-delta",
        requestId: request.requestId,
        modelAttemptId: attempt,
        sequence: sequence++,
        text: script.text,
      };
      yield {
        kind: "usage",
        requestId: request.requestId,
        modelAttemptId: attempt,
        sequence: sequence++,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          provenance: "estimate",
        },
      };
      yield {
        kind: "finished",
        requestId: request.requestId,
        modelAttemptId: attempt,
        sequence: sequence++,
        finishReason: script.finishReason ?? "stop",
      };
    },
  };
}

/** Builds a minimal valid request for the deterministic adapter. */
export function deterministicEchoRequest(text = "hello"): ModelRequest {
  return {
    requestId: modelRequestId.from("req-deterministic-1"),
    providerId: providerId.from("falryn-deterministic"),
    modelId: modelId.from("deterministic-echo"),
    messages: [{ role: "user", parts: [{ kind: "text", text }] }],
    tools: [],
    output: { kind: "text" },
    budgets: {},
    metadata: { role: "default" },
  };
}
