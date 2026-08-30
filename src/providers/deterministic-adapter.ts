/**
 * Deterministic in-memory provider adapter for contract tests.
 *
 * This is product-owned test support (like the domain in-memory blob store),
 * not a fixture module: it never reads the network, never holds credentials,
 * and never imports a vendor SDK.
 */

import { modelAttemptId, modelId, providerId } from "../domain/identity.ts";
import type { ProviderFailure, ProviderFailureKind } from "./errors.ts";
import { modelRequestId } from "./identity.ts";
import { MODEL_CAPABILITY_SCHEMA_VERSION } from "./model-capability.ts";
import type { ProviderAdapterPort } from "./port.ts";
import type { ModelRequest } from "./request.ts";
import type { NormalizedProviderEvent, UsageUnits } from "./stream.ts";

export type DeterministicFailureScript = {
  readonly kind: "error";
  readonly failureKind: ProviderFailureKind;
  readonly message: string;
  readonly retryable: boolean;
};

export type DeterministicTextScript = {
  readonly kind: "text";
  readonly textFragments?: readonly string[];
  readonly reasoningFragments?: readonly string[];
  readonly text?: string;
  readonly finishReason?: string;
  readonly usage?: UsageUnits | null;
  /** When true, omit the finished event so normalizers see a missing terminal. */
  readonly omitTerminal?: boolean;
};

export type DeterministicToolScript = {
  readonly kind: "tool";
  readonly toolCallId: string;
  readonly name: string;
  readonly argumentFragments: readonly string[];
  readonly finishReason?: string;
  readonly usage?: UsageUnits | null;
};

/**
 * Emit a short prefix, then honor abort (or hang until aborted) for mid-stream
 * cancellation / timeout classification tests.
 */
export type DeterministicAbortableScript = {
  readonly kind: "abortable";
  readonly prefixText?: string;
  readonly hangUntilAbort?: boolean;
  /** Failure kind when the signal aborts after start (default cancellation). */
  readonly abortFailureKind?: Extract<ProviderFailureKind, "cancellation" | "timeout">;
};

export type DeterministicProviderScript =
  | DeterministicTextScript
  | DeterministicFailureScript
  | DeterministicToolScript
  | DeterministicAbortableScript
  /** @deprecated Prefer `{ kind: "error", failureKind, message, retryable }`. */
  | { readonly kind: "error"; readonly message: string; readonly retryable?: boolean };

export type DeterministicProviderOptions = {
  readonly profileId?: string;
  readonly displayName?: string;
  /** Test-only model identities used to exercise selection and fallback. */
  readonly supportedModels?: readonly string[];
  readonly script?:
    | DeterministicProviderScript
    | ((request: ModelRequest, requestIndex: number) => DeterministicProviderScript);
  readonly onRequest?: (request: ModelRequest, requestIndex: number) => void;
};

function isTypedFailureScript(
  script: DeterministicProviderScript,
): script is DeterministicFailureScript {
  return script.kind === "error" && "failureKind" in script;
}

function failureFromScript(script: DeterministicProviderScript): ProviderFailure {
  if (isTypedFailureScript(script)) {
    return {
      kind: script.failureKind,
      retryable: script.retryable,
      message: script.message,
    };
  }
  if (script.kind === "error") {
    return {
      kind: "server-failure",
      retryable: script.retryable ?? false,
      message: script.message,
    };
  }
  return {
    kind: "adapter-defect",
    retryable: false,
    message: "deterministic adapter script is not an error script",
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function createDeterministicProviderAdapter(
  options: DeterministicProviderOptions = {},
): ProviderAdapterPort {
  const identity = {
    providerId: providerId.from("falryn-deterministic"),
    profileId: options.profileId ?? "deterministic",
    adapterKind: "deterministic" as const,
    endpoint: null,
    destinationId: "falryn:deterministic:default",
    displayName: options.displayName ?? "Deterministic fixture provider",
  };
  const models = (options.supportedModels ?? ["deterministic-echo"]).map(modelId.from);
  const defaultScript: DeterministicProviderScript = {
    kind: "text",
    text: "ok",
    finishReason: "stop",
  };
  let requestIndex = 0;

  return {
    identity,
    supportedModels: models,
    requestInputModalities: ["text"],
    requestResponseDensityControls: ["low", "medium", "high"],
    modelCapabilities: models.map((model) => ({
      schemaVersion: MODEL_CAPABILITY_SCHEMA_VERSION,
      modelId: model,
      displayName: "Deterministic echo",
      inputModalities: ["text"],
      outputModalities: ["text"],
      tools: "supported",
      structuredOutput: "supported",
      streaming: "supported",
      reasoning: "supported",
      reasoningControls: ["minimal", "balanced", "deep"],
      responseDensityControls: ["low", "medium", "high"],
      contextTokens: 128_000,
      outputTokens: 16_384,
      completeness: "complete",
      availability: "available",
      provenance: ["provider-manifest"],
    })),
    async *stream(request: ModelRequest, streamOptions): AsyncIterable<NormalizedProviderEvent> {
      const currentRequestIndex = requestIndex;
      requestIndex += 1;
      options.onRequest?.(request, currentRequestIndex);
      const script =
        typeof options.script === "function"
          ? options.script(request, currentRequestIndex)
          : (options.script ?? defaultScript);
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
          failure: failureFromScript(script),
        };
        return;
      }

      if (script.kind === "abortable") {
        if (script.prefixText !== undefined && script.prefixText.length > 0) {
          yield {
            kind: "text-delta",
            requestId: request.requestId,
            modelAttemptId: attempt,
            sequence: sequence++,
            text: script.prefixText,
          };
        }
        if (script.hangUntilAbort) {
          await waitForAbort(streamOptions.signal);
        }
        if (streamOptions.signal.aborted) {
          const abortKind = script.abortFailureKind ?? "cancellation";
          yield {
            kind: "error",
            requestId: request.requestId,
            modelAttemptId: attempt,
            sequence: sequence++,
            failure: {
              kind: abortKind,
              retryable: abortKind === "timeout",
              message:
                abortKind === "timeout"
                  ? "request timed out during generation"
                  : "request cancelled during generation",
            },
          };
        }
        return;
      }

      if (script.kind === "tool") {
        for (const [index, fragment] of script.argumentFragments.entries()) {
          yield {
            kind: "tool-call-delta",
            requestId: request.requestId,
            modelAttemptId: attempt,
            sequence: sequence++,
            toolCallId: script.toolCallId,
            name: index === 0 ? script.name : undefined,
            argumentsFragment: fragment,
          };
        }
        yield {
          kind: "tool-proposal",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: sequence++,
          toolCallId: script.toolCallId,
          name: script.name,
          // Assembler prefers assembled fragments; placeholder must be valid JSON object.
          argumentsJson: "{}",
        };
        if (script.usage !== undefined && script.usage !== null) {
          yield {
            kind: "usage",
            requestId: request.requestId,
            modelAttemptId: attempt,
            sequence: sequence++,
            usage: script.usage,
          };
        }
        yield {
          kind: "finished",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: sequence++,
          finishReason: script.finishReason ?? "tool-calls",
        };
        return;
      }

      // text script
      const textParts =
        script.textFragments ?? (script.text !== undefined ? [script.text] : ["ok"]);
      for (const part of textParts) {
        yield {
          kind: "text-delta",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: sequence++,
          text: part,
        };
      }
      for (const part of script.reasoningFragments ?? []) {
        yield {
          kind: "reasoning-delta",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: sequence++,
          text: part,
        };
      }
      if (script.usage !== undefined && script.usage !== null) {
        yield {
          kind: "usage",
          requestId: request.requestId,
          modelAttemptId: attempt,
          sequence: sequence++,
          usage: script.usage,
        };
      } else if (script.usage === undefined) {
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
      }
      // usage === null intentionally skips usage (null ≠ zero provenance proof)
      if (script.omitTerminal) {
        return;
      }
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
