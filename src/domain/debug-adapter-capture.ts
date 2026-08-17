/**
 * Debug-adapter confirmation and session artifact capture (#100).
 *
 * Consequential debug actions (mutating evaluate, terminate, disconnect that
 * terminates the debuggee) require focused confirmation. Session facts spill
 * through ArtifactStorePort as bounded JSON artifacts with redacted outputs.
 */

import { type ArtifactId, type ArtifactSensitivity, artifactId } from "./artifact.ts";
import type {
  DebugDisconnectOutcome,
  DebugOutputEvent,
  DebugSessionSnapshot,
  DebugTargetExit,
} from "./debug-adapter-session.ts";
import { err, ok, type Result } from "./result.ts";
import { canonicalizeJson } from "./tool-policy.ts";

export const MAX_DEBUG_SESSION_ARTIFACT_BYTES = 256 * 1_024;
export const DEBUG_CONFIRMATION_KINDS = [
  "evaluate-repl",
  "terminate",
  "disconnect-terminate",
] as const;
export type DebugConfirmationKind = (typeof DEBUG_CONFIRMATION_KINDS)[number];

export type DebugConfirmationRequest = {
  readonly confirmationId: string;
  readonly kind: DebugConfirmationKind;
  readonly title: string;
  readonly normalizedInput: Readonly<Record<string, unknown>>;
  readonly inputFingerprint: string;
};

export type DebugConfirmation =
  | { readonly status: "accepted"; readonly confirmationId: string }
  | { readonly status: "refused"; readonly confirmationId: string };

export type DebugSessionArtifactRef = {
  readonly artifactId: ArtifactId;
  readonly byteLength: number;
  readonly mediaType: "application/json";
  readonly sensitivity: ArtifactSensitivity;
  readonly committed: boolean;
};

export type DebugCaptureError =
  | {
      readonly kind: "debug-adapter";
      readonly code: "confirmation-required";
      readonly confirmation: DebugConfirmationRequest;
    }
  | { readonly kind: "debug-adapter"; readonly code: "confirmation-refused" }
  | { readonly kind: "debug-adapter"; readonly code: "confirmation-mismatch" }
  | { readonly kind: "debug-adapter"; readonly code: "confirmation-stale" }
  | { readonly kind: "debug-adapter"; readonly code: "artifact-unavailable" }
  | { readonly kind: "debug-adapter"; readonly code: "artifact-failed" }
  | { readonly kind: "debug-adapter"; readonly code: "capacity-exceeded" };

export function debugConfirmationFingerprint(
  kind: DebugConfirmationKind,
  normalizedInput: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify(["debug-confirm", kind, canonicalizeJson(normalizedInput)]);
}

export function buildDebugConfirmationRequest(
  kind: DebugConfirmationKind,
  normalizedInput: Readonly<Record<string, unknown>>,
): DebugConfirmationRequest {
  const inputFingerprint = debugConfirmationFingerprint(kind, normalizedInput);
  const title =
    kind === "evaluate-repl"
      ? "Evaluate expression (may mutate target)"
      : kind === "terminate"
        ? "Terminate debug target"
        : "Disconnect and terminate debuggee";
  return {
    confirmationId: JSON.stringify(["debug-confirm", kind, inputFingerprint]),
    kind,
    title,
    normalizedInput,
    inputFingerprint,
  };
}

export function resolveDebugConfirmation(options: {
  readonly request: DebugConfirmationRequest;
  readonly current: DebugConfirmationRequest;
  readonly confirmation: DebugConfirmation | undefined;
}): Result<void, DebugCaptureError> {
  if (options.confirmation === undefined) {
    return err({
      kind: "debug-adapter",
      code: "confirmation-required",
      confirmation: options.request,
    });
  }
  if (options.confirmation.status === "refused") {
    return err({ kind: "debug-adapter", code: "confirmation-refused" });
  }
  if (options.confirmation.confirmationId !== options.request.confirmationId) {
    return err({ kind: "debug-adapter", code: "confirmation-mismatch" });
  }
  if (options.request.inputFingerprint !== options.current.inputFingerprint) {
    return err({ kind: "debug-adapter", code: "confirmation-stale" });
  }
  return ok(undefined);
}

export type DebugSessionArtifactDocument = {
  readonly schemaVersion: 1;
  readonly kind: "debug-session-artifact";
  readonly serviceId: string;
  readonly generation: number;
  readonly adapterState: string;
  readonly session: {
    readonly mode: DebugSessionSnapshot["mode"];
    readonly targetState: DebugSessionSnapshot["targetState"];
    readonly configurationDone: boolean;
    readonly stopped: DebugSessionSnapshot["stopped"];
    readonly threads: DebugSessionSnapshot["threads"];
    readonly recentOutputs: readonly DebugOutputEvent[];
    readonly targetExit: DebugTargetExit | null;
    readonly lastDisconnect: DebugDisconnectOutcome | null;
  };
  readonly capturedAt: string;
};

export function buildDebugSessionArtifactDocument(input: {
  readonly serviceId: string;
  readonly generation: number;
  readonly adapterState: string;
  readonly session: DebugSessionSnapshot;
  readonly capturedAt: string;
}): DebugSessionArtifactDocument {
  return {
    schemaVersion: 1,
    kind: "debug-session-artifact",
    serviceId: input.serviceId,
    generation: input.generation,
    adapterState: input.adapterState,
    session: {
      mode: input.session.mode,
      targetState: input.session.targetState,
      configurationDone: input.session.configurationDone,
      stopped: input.session.stopped,
      threads: input.session.threads,
      recentOutputs: input.session.recentOutputs,
      targetExit: input.session.targetExit,
      lastDisconnect: input.session.lastDisconnect,
    },
    capturedAt: input.capturedAt,
  };
}

export function encodeDebugSessionArtifact(
  document: DebugSessionArtifactDocument,
): Result<
  { readonly bytes: Uint8Array; readonly sensitivity: ArtifactSensitivity },
  DebugCaptureError
> {
  const text = `${JSON.stringify(document)}\n`;
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_DEBUG_SESSION_ARTIFACT_BYTES) {
    return err({ kind: "debug-adapter", code: "capacity-exceeded" });
  }
  const sensitivity: ArtifactSensitivity = document.session.recentOutputs.some(
    (event) => event.sensitive || event.redacted,
  )
    ? "sensitive"
    : "user-content";
  return ok({ bytes, sensitivity });
}

export function debugSessionArtifactId(
  serviceId: string,
  generation: number,
  sequence: number,
): ArtifactId {
  const safeService = serviceId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "d") || "dap";
  const raw = `dap.${safeService}.g${generation}.n${sequence}`;
  return artifactId.from(raw.slice(0, 128));
}

export async function* bytesAsChunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}
