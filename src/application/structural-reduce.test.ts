/**
 * Structural reducer port: redaction, cancellation, and evidence admission.
 */

import { describe, expect, test } from "bun:test";

import { workspaceId } from "../domain/index.ts";
import { REDACTED } from "./redaction.ts";
import { createStructuralReducer, structuralToEvidence } from "./structural-reduce.ts";

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

describe("createStructuralReducer", () => {
  test("redacts secret-shaped projections and never claims exact-source", () => {
    const reducer = createStructuralReducer();
    const text = prettyJson({
      token: "sk-live-SECRET-MUST-NOT-ESCAPE",
      keep: "visible-value-that-is-long-enough-to-shrink",
    });
    const reduced = reducer.reduce({ family: "file", text, keys: ["token", "keep"] });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      return;
    }
    expect(reduced.value.claimsExact).toBe(false);
    expect(reduced.value.fidelity).toBe("raw-fallback");
    expect(reduced.value.text).toContain(REDACTED);
    expect(reduced.value.text).not.toContain("sk-live-SECRET");

    const admitted = structuralToEvidence({
      result: reduced.value,
      id: "ev-structural-secret",
      workspaceId: workspaceId.from("workspace-1"),
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) {
      return;
    }
    expect(admitted.value.fidelity).toBe("deterministic-transform");
    expect(admitted.value.exactSource).toBeNull();
    expect(admitted.value.expansion).not.toBeNull();
    expect(admitted.value.lineage).toEqual(["structural.v1", "file"]);
    expect(admitted.value.workspaceId).toBe(workspaceId.from("workspace-1"));
    if (admitted.value.payload.kind === "inline") {
      expect(admitted.value.payload.text).not.toContain("sk-live-SECRET");
    }
  });

  test("admits compact passthrough as exact-source and JSON reduction as a transform", () => {
    const reducer = createStructuralReducer();
    const exact = reducer.reduce({ family: "file", text: '{"ok":true}' });
    expect(exact.ok).toBe(true);
    if (!exact.ok) {
      return;
    }
    const admitted = structuralToEvidence({ result: exact.value, id: "ev-passthrough" });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) {
      return;
    }
    expect(admitted.value.sourceKind).toBe("file");
    expect(admitted.value.fidelity).toBe("exact-source");
    expect(admitted.value.lineage).toEqual([]);
    expect(admitted.value.exactSource).not.toBeNull();
    expect(admitted.value.expansion).toBeNull();

    const projected = reducer.reduce({
      family: "file",
      text: prettyJson({
        keep: "visible",
        drop: "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      }),
      keys: ["keep"],
    });
    expect(projected.ok).toBe(true);
    if (!projected.ok) {
      return;
    }
    const transformed = structuralToEvidence({ result: projected.value, id: "ev-json" });
    expect(transformed.ok).toBe(true);
    if (!transformed.ok) {
      return;
    }
    expect(transformed.value.fidelity).toBe("deterministic-transform");
    expect(transformed.value.exactSource).toBeNull();
    expect(transformed.value.lineage).toEqual(["structural.v1", "file"]);
    expect(transformed.value.expansion).not.toBeNull();
  });

  test("cancels before reduction when the signal is aborted", () => {
    const reducer = createStructuralReducer();
    const signal = AbortSignal.abort();
    const cancelled = reducer.reduce({ family: "file", text: '{"ok":true}' }, signal);
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) {
      return;
    }
    expect(cancelled.error).toEqual({
      kind: "structural-port",
      code: "cancelled",
      field: "signal",
    });
  });
});
