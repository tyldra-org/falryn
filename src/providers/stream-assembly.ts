/**
 * Assembles and validates a provider stream attempt.
 *
 * Adapters may emit fragmented deltas. This module enforces sequence integrity,
 * assembles text/reasoning for model-facing continuation, builds tool proposals
 * from argument fragments, aggregates usage without inventing zeros, and
 * terminates on duplicate terminals, size overflow, or malformed tool JSON.
 *
 * Diagnostics report structure only — never delta text, argument fragments, or
 * secrets.
 */

import { assertNever } from "../domain/result.ts";
import type { ProviderFailure } from "./errors.ts";
import {
  MAX_ASSEMBLED_TEXT_LENGTH,
  MAX_IN_FLIGHT_TOOL_CALLS,
  MAX_TOOL_ARGUMENT_FRAGMENT_LENGTH,
  MAX_TOOL_NAME_LENGTH,
} from "./limits.ts";
import type { NormalizedProviderEvent, UsageUnits } from "./stream.ts";
import { redactProviderDiagnosticText } from "./validate.ts";

export type StreamAssemblyDiagnostic = {
  /** Stable structural code such as `sequence-gap` or `duplicate-terminal`. */
  readonly code: string;
  /** Dotted path into assembly state; never carries user/provider payload. */
  readonly path: string;
};

export type AssembledToolProposal = {
  readonly toolCallId: string;
  readonly name: string;
  /** Validated JSON object text (minified only by parse round-trip). */
  readonly argumentsJson: string;
  readonly arguments: Readonly<Record<string, unknown>>;
};

export type StreamAssemblySnapshot = {
  readonly text: string;
  readonly reasoning: string;
  readonly toolProposals: readonly AssembledToolProposal[];
  /**
   * Last usage observation, or `null` when none arrived. Missing usage is
   * unknown — callers must not treat `null` as zero tokens.
   */
  readonly usage: UsageUnits | null;
  readonly finishReason: string | null;
  /** Secret-safe adapter receipts; opaque continuation payloads never enter here. */
  readonly providerMetadata: Readonly<Record<string, string>>;
  readonly diagnostics: readonly StreamAssemblyDiagnostic[];
};

export type StreamAssemblyTerminal =
  | {
      readonly kind: "finished";
      readonly snapshot: StreamAssemblySnapshot;
      readonly finishReason: string;
    }
  | {
      readonly kind: "failed";
      readonly snapshot: StreamAssemblySnapshot;
      readonly failure: ProviderFailure;
    };

export type StreamAssemblyStep =
  | {
      readonly kind: "emit";
      readonly event: NormalizedProviderEvent;
      readonly snapshot: StreamAssemblySnapshot;
    }
  | {
      readonly kind: "terminal";
      readonly event: NormalizedProviderEvent;
      readonly terminal: StreamAssemblyTerminal;
    };

type InFlightTool = {
  name: string | null;
  arguments: string;
};

function failure(
  kind: ProviderFailure["kind"],
  message: string,
  retryable = false,
): ProviderFailure {
  return {
    kind,
    retryable,
    message: redactProviderDiagnosticText(message),
  };
}

function parseToolArguments(argumentsJson: string):
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      readonly code: string;
    } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson) as unknown;
  } catch {
    return { ok: false, code: "tool-arguments-invalid-json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, code: "tool-arguments-not-object" };
  }
  return { ok: true, value: parsed as Readonly<Record<string, unknown>> };
}

/**
 * Stateful assembler for one model attempt's provider events.
 *
 * Call {@link ProviderStreamAssembler.push} for each event in order. After a
 * terminal step the assembler rejects further pushes.
 */
export class ProviderStreamAssembler {
  private expectedSequence = 1;
  private started = false;
  private closed = false;
  private text = "";
  private reasoning = "";
  private usage: UsageUnits | null = null;
  private finishReason: string | null = null;
  private readonly providerMetadata: Record<string, string> = {};
  private readonly toolProposals: AssembledToolProposal[] = [];
  private readonly inFlight = new Map<string, InFlightTool>();
  private readonly diagnostics: StreamAssemblyDiagnostic[] = [];
  private requestId: string | null = null;
  private modelAttemptId: string | null = null;

  snapshot(): StreamAssemblySnapshot {
    return {
      text: this.text,
      reasoning: this.reasoning,
      toolProposals: [...this.toolProposals],
      usage: this.usage,
      finishReason: this.finishReason,
      providerMetadata: { ...this.providerMetadata },
      diagnostics: [...this.diagnostics],
    };
  }

  push(event: NormalizedProviderEvent): StreamAssemblyStep {
    if (this.closed) {
      return this.terminate(
        {
          ...event,
          kind: "error",
          failure: failure("adapter-defect", "event after terminal", false),
          sequence: event.sequence,
        },
        failure("adapter-defect", "event received after stream terminal", false),
        { code: "event-after-terminal", path: "sequence" },
      );
    }

    if (this.requestId === null) {
      this.requestId = event.requestId;
      this.modelAttemptId = event.modelAttemptId;
    } else if (event.requestId !== this.requestId || event.modelAttemptId !== this.modelAttemptId) {
      return this.failEvent(
        event,
        failure("malformed-stream", "request or attempt identity changed", false),
        { code: "identity-mismatch", path: "requestId" },
      );
    }

    if (event.sequence !== this.expectedSequence) {
      return this.failEvent(
        event,
        failure("malformed-stream", "provider event sequence gap or reorder", false),
        { code: "sequence-gap", path: "sequence" },
      );
    }
    this.expectedSequence += 1;

    switch (event.kind) {
      case "request-started":
        if (this.started) {
          return this.failEvent(
            event,
            failure("adapter-defect", "duplicate request-started", false),
            { code: "duplicate-start", path: "kind" },
          );
        }
        this.started = true;
        return { kind: "emit", event, snapshot: this.snapshot() };

      case "text-delta":
        return this.appendText("text", event);

      case "reasoning-delta":
        return this.appendText("reasoning", event);

      case "tool-call-delta":
        return this.appendToolDelta(event);

      case "tool-proposal":
        return this.acceptToolProposal(event);

      case "usage":
        this.usage = event.usage;
        return { kind: "emit", event, snapshot: this.snapshot() };

      case "provider-metadata":
        Object.assign(this.providerMetadata, event.entries);
        return { kind: "emit", event, snapshot: this.snapshot() };

      case "finished":
        return this.closeFinished(event);

      case "error":
        return this.closeError(event);

      default:
        return assertNever(event, "unhandled provider event");
    }
  }

  private appendText(
    field: "text" | "reasoning",
    event: Extract<NormalizedProviderEvent, { kind: "text-delta" | "reasoning-delta" }>,
  ): StreamAssemblyStep {
    if (!this.started) {
      return this.failEvent(
        event,
        failure("malformed-stream", "delta before request-started", false),
        { code: "delta-before-start", path: field },
      );
    }
    const current = field === "text" ? this.text : this.reasoning;
    if (current.length + event.text.length > MAX_ASSEMBLED_TEXT_LENGTH) {
      return this.failEvent(
        event,
        failure("malformed-stream", "assembled text exceeds bound", false),
        { code: "assembled-text-overflow", path: field },
      );
    }
    if (field === "text") {
      this.text = current + event.text;
    } else {
      this.reasoning = current + event.text;
    }
    return { kind: "emit", event, snapshot: this.snapshot() };
  }

  private appendToolDelta(
    event: Extract<NormalizedProviderEvent, { kind: "tool-call-delta" }>,
  ): StreamAssemblyStep {
    if (!this.started) {
      return this.failEvent(
        event,
        failure("malformed-stream", "tool delta before request-started", false),
        { code: "delta-before-start", path: "toolCallId" },
      );
    }
    let entry = this.inFlight.get(event.toolCallId);
    if (entry === undefined) {
      if (this.inFlight.size >= MAX_IN_FLIGHT_TOOL_CALLS) {
        return this.failEvent(
          event,
          failure("malformed-stream", "too many in-flight tool calls", false),
          { code: "tool-call-limit", path: "toolCallId" },
        );
      }
      entry = { name: null, arguments: "" };
      this.inFlight.set(event.toolCallId, entry);
    }
    if (event.name !== undefined) {
      if (event.name.length > MAX_TOOL_NAME_LENGTH) {
        return this.failEvent(
          event,
          failure("malformed-stream", "tool name exceeds bound", false),
          { code: "tool-name-overflow", path: "name" },
        );
      }
      entry.name = event.name;
    }
    if (
      entry.arguments.length + event.argumentsFragment.length >
      MAX_TOOL_ARGUMENT_FRAGMENT_LENGTH
    ) {
      return this.failEvent(
        event,
        failure("malformed-stream", "tool arguments exceed bound", false),
        { code: "tool-arguments-overflow", path: "argumentsFragment" },
      );
    }
    entry.arguments += event.argumentsFragment;
    return { kind: "emit", event, snapshot: this.snapshot() };
  }

  private acceptToolProposal(
    event: Extract<NormalizedProviderEvent, { kind: "tool-proposal" }>,
  ): StreamAssemblyStep {
    if (!this.started) {
      return this.failEvent(
        event,
        failure("malformed-stream", "tool proposal before request-started", false),
        { code: "proposal-before-start", path: "toolCallId" },
      );
    }
    const inFlight = this.inFlight.get(event.toolCallId);
    const argumentsJson =
      inFlight !== undefined ? inFlight.arguments || event.argumentsJson : event.argumentsJson;
    const name = inFlight?.name ?? event.name;
    if (name.length === 0) {
      return this.failEvent(
        event,
        failure("malformed-stream", "tool proposal missing name", false),
        { code: "tool-name-missing", path: "name" },
      );
    }
    const parsed = parseToolArguments(argumentsJson);
    if (!parsed.ok) {
      return this.failEvent(
        event,
        failure("malformed-stream", "tool arguments are not valid JSON object", false),
        { code: parsed.code, path: "argumentsJson" },
      );
    }
    this.inFlight.delete(event.toolCallId);
    this.toolProposals.push({
      toolCallId: event.toolCallId,
      name,
      argumentsJson,
      arguments: parsed.value,
    });
    const normalized: NormalizedProviderEvent = {
      ...event,
      name,
      argumentsJson,
    };
    return { kind: "emit", event: normalized, snapshot: this.snapshot() };
  }

  private closeFinished(
    event: Extract<NormalizedProviderEvent, { kind: "finished" }>,
  ): StreamAssemblyStep {
    if (!this.started) {
      return this.failEvent(
        event,
        failure("malformed-stream", "finished before request-started", false),
        { code: "finished-before-start", path: "kind" },
      );
    }
    if (this.inFlight.size > 0) {
      return this.failEvent(
        event,
        failure("malformed-stream", "finished with incomplete tool calls", false),
        { code: "incomplete-tool-calls", path: "toolCallId" },
      );
    }
    this.finishReason = event.finishReason;
    this.closed = true;
    const snapshot = this.snapshot();
    return {
      kind: "terminal",
      event,
      terminal: { kind: "finished", snapshot, finishReason: event.finishReason },
    };
  }

  private closeError(
    event: Extract<NormalizedProviderEvent, { kind: "error" }>,
  ): StreamAssemblyStep {
    this.closed = true;
    const snapshot = this.snapshot();
    return {
      kind: "terminal",
      event,
      terminal: { kind: "failed", snapshot, failure: event.failure },
    };
  }

  private failEvent(
    event: NormalizedProviderEvent,
    providerFailure: ProviderFailure,
    diagnostic: StreamAssemblyDiagnostic,
  ): StreamAssemblyStep {
    this.diagnostics.push(diagnostic);
    const errorEvent: NormalizedProviderEvent = {
      requestId: event.requestId,
      modelAttemptId: event.modelAttemptId,
      sequence: event.sequence,
      kind: "error",
      failure: providerFailure,
    };
    return this.terminate(errorEvent, providerFailure, diagnostic);
  }

  private terminate(
    event: NormalizedProviderEvent,
    providerFailure: ProviderFailure,
    diagnostic: StreamAssemblyDiagnostic,
  ): StreamAssemblyStep {
    if (!this.diagnostics.includes(diagnostic)) {
      this.diagnostics.push(diagnostic);
    }
    this.closed = true;
    const snapshot = this.snapshot();
    return {
      kind: "terminal",
      event,
      terminal: { kind: "failed", snapshot, failure: providerFailure },
    };
  }
}

/**
 * Consumes a provider event stream, yielding accepted events and stopping on
 * the first terminal assembly step (including injected assembly failures).
 */
export async function* normalizeProviderStream(
  events: AsyncIterable<NormalizedProviderEvent>,
): AsyncGenerator<
  { readonly event: NormalizedProviderEvent; readonly snapshot: StreamAssemblySnapshot },
  StreamAssemblyTerminal
> {
  const assembler = new ProviderStreamAssembler();
  for await (const event of events) {
    const step = assembler.push(event);
    switch (step.kind) {
      case "emit":
        yield { event: step.event, snapshot: step.snapshot };
        break;
      case "terminal":
        yield { event: step.event, snapshot: step.terminal.snapshot };
        return step.terminal;
      default:
        return assertNever(step, "unhandled assembly step");
    }
  }

  const snapshot = assembler.snapshot();
  return {
    kind: "failed",
    snapshot: {
      ...snapshot,
      diagnostics: [...snapshot.diagnostics, { code: "missing-terminal", path: "stream" }],
    },
    failure: failure("adapter-defect", "stream ended without terminal event", false),
  };
}
