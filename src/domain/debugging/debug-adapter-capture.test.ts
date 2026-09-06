import { describe, expect, test } from "bun:test";
import {
  buildDebugConfirmationRequest,
  buildDebugSessionArtifactDocument,
  encodeDebugSessionArtifact,
  MAX_DEBUG_SESSION_ARTIFACT_BYTES,
  resolveDebugConfirmation,
} from "./debug-adapter-capture.ts";
import { emptyDebugSessionSnapshot } from "./debug-adapter-session.ts";

describe("debug-adapter capture and confirmation", () => {
  test("requires and resolves focused confirmation", () => {
    const request = buildDebugConfirmationRequest("terminate", { restart: false });
    expect(request.title).toContain("Terminate");
    expect(
      resolveDebugConfirmation({
        request,
        current: request,
        confirmation: undefined,
      }).ok,
    ).toBe(false);
    expect(
      resolveDebugConfirmation({
        request,
        current: request,
        confirmation: { status: "accepted", confirmationId: request.confirmationId },
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(
      resolveDebugConfirmation({
        request,
        current: request,
        confirmation: { status: "refused", confirmationId: request.confirmationId },
      }).ok,
    ).toBe(false);
    expect(
      resolveDebugConfirmation({
        request,
        current: request,
        confirmation: { status: "accepted", confirmationId: "other" },
      }).ok,
    ).toBe(false);
    const stale = buildDebugConfirmationRequest("terminate", { restart: true });
    expect(
      resolveDebugConfirmation({
        request,
        current: stale,
        confirmation: { status: "accepted", confirmationId: request.confirmationId },
      }).ok,
    ).toBe(false);
  });

  test("encodes a bounded redacted session artifact", () => {
    const session = {
      ...emptyDebugSessionSnapshot(),
      recentOutputs: [
        {
          category: "stdout" as const,
          output: "[redacted]",
          sensitive: true,
          redacted: true,
        },
      ],
    };
    const document = buildDebugSessionArtifactDocument({
      serviceId: "dap:fixture",
      generation: 1,
      adapterState: "ready",
      session,
      capturedAt: "2026-08-17T00:00:00.000Z",
    });
    const encoded = encodeDebugSessionArtifact(document);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) {
      return;
    }
    expect(encoded.value.sensitivity).toBe("sensitive");
    expect(encoded.value.bytes.byteLength).toBeLessThanOrEqual(MAX_DEBUG_SESSION_ARTIFACT_BYTES);
    expect(new TextDecoder().decode(encoded.value.bytes)).not.toContain("hunter2");
  });
});
