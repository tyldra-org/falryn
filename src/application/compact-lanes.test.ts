/**
 * Compact-model and history checkpoint ports: redaction, cancellation, evidence.
 */

import { describe, expect, test } from "bun:test";

import { ok, workspaceId } from "../domain/index.ts";
import { compactToEvidence, createCompactLanes } from "./compact-lanes.ts";
import { REDACTED } from "./redaction.ts";

describe("createCompactLanes", () => {
  test("redacts secret-shaped compact projections and never claims exact-source", () => {
    const lanes = createCompactLanes({
      compact() {
        return ok({ kind: "lossy", text: "token sk-live-SECRET-MUST-NOT-ESCAPE leaked" });
      },
    });
    const source = `${"keep this narration visible for savings ".repeat(20)}`;
    const reduced = lanes.reduce({ text: source, compactUse: "evaluated" });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      return;
    }
    expect(reduced.value.claimsExact).toBe(false);
    expect(reduced.value.text).toContain(REDACTED);
    expect(reduced.value.text).not.toContain("sk-live-SECRET");

    const admitted = compactToEvidence({
      result: reduced.value,
      id: "ev-compact-secret",
      workspaceId: workspaceId.from("workspace-1"),
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) {
      return;
    }
    expect(admitted.value.fidelity).toBe("deterministic-transform");
    expect(admitted.value.exactSource).toBeNull();
    expect(admitted.value.expansion).not.toBeNull();
    if (admitted.value.payload.kind === "inline") {
      expect(admitted.value.payload.text).not.toContain("sk-live-SECRET");
    }
  });

  test("admits compact-model synthesis as lossy and passthrough as exact-source", () => {
    const lanes = createCompactLanes({
      compact() {
        return ok({ kind: "lossy", text: "short synthesis" });
      },
    });
    const source = `${"keep this narration visible for savings ".repeat(20)}`;
    const synthesized = lanes.reduce({ text: source, compactUse: "evaluated" });
    expect(synthesized.ok).toBe(true);
    if (!synthesized.ok) {
      return;
    }
    const admitted = compactToEvidence({ result: synthesized.value, id: "ev-lossy" });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) {
      return;
    }
    expect(admitted.value.fidelity).toBe("lossy-synthesis");
    expect(admitted.value.lineage).toEqual(["compact.v1", "compact-model"]);

    const off = createCompactLanes(null);
    const passthrough = off.reduce({ text: "short original", compactUse: "off" });
    expect(passthrough.ok).toBe(true);
    if (!passthrough.ok) {
      return;
    }
    const exact = compactToEvidence({ result: passthrough.value, id: "ev-pass" });
    expect(exact.ok).toBe(true);
    if (!exact.ok) {
      return;
    }
    expect(exact.value.fidelity).toBe("exact-source");
    expect(exact.value.lineage).toEqual([]);
  });

  test("cancels before compacting and redacts checkpoint preserved text", () => {
    const lanes = createCompactLanes(null);
    expect(lanes.reduce({ text: "hello world" }, AbortSignal.abort()).ok).toBe(false);
    const checkpoint = lanes.checkpoint({
      checkpointId: "chk-redact",
      items: [
        {
          id: "evt-1",
          kind: "user-commitment",
          text: "rotate sk-live-SECRET-MUST-NOT-ESCAPE",
        },
      ],
    });
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) {
      return;
    }
    expect(checkpoint.value.preserved[0]?.text).toContain(REDACTED);
    expect(checkpoint.value.preserved[0]?.text).not.toContain("sk-live-SECRET");
  });
});
