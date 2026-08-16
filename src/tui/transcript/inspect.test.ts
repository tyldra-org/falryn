/**
 * Inspection of the four block families #254 names.
 */

import { describe, expect, test } from "bun:test";
import { blockKey } from "../../presentation/index.ts";
import { everyBlockKind } from "../../presentation/transcript/fixtures.ts";
import {
  describeTerminalOutcome,
  hasDiagnostics,
  INSPECTABLE_KINDS,
  inspectBlock,
  inspectionFor,
  sliceInspection,
} from "./inspect.ts";

function ofKind(kind: (typeof INSPECTABLE_KINDS)[number]) {
  const block = everyBlockKind().find((candidate) => candidate.kind === kind);
  if (block === undefined) {
    throw new Error(`the block corpus has no ${kind} block`);
  }
  return block;
}

describe("inspectBlock", () => {
  test("covers every inspectable kind and refuses the rest", () => {
    const inspectable = new Set<string>(INSPECTABLE_KINDS);
    for (const block of everyBlockKind()) {
      const inspection = inspectBlock(block);
      expect({ kind: block.kind, inspectable: inspection !== null }).toEqual({
        kind: block.kind,
        inspectable: inspectable.has(block.kind),
      });
    }
  });

  test("does not infer success from a failed process that printed a build line", () => {
    const inspection = inspectBlock(ofKind("process-exit"));
    expect(inspection?.family).toBe("process");
    expect(inspection?.facts.some((fact) => fact.label === "exit" && fact.value === "1")).toBe(
      true,
    );
    expect(
      inspection?.facts.some(
        (fact) => fact.label === "outcome" && fact.value === "failed (partial effect)",
      ),
    ).toBe(true);
    expect(inspection?.outcome).toEqual({ kind: "failed", effect: "partial" });
  });

  test("keeps a secret tool payload withheld", () => {
    const inspection = inspectBlock(ofKind("tool-request"));
    expect(inspection?.withheld).toBe(true);
    expect(inspection?.summary).toContain("Running a provider check");
    const input = inspection?.facts.find((fact) => fact.label === "input");
    expect(input?.value).toContain("Withheld");
    expect(input?.value).not.toContain("credential");
  });

  test("names a completed tool result as completed rather than from its output", () => {
    const inspection = inspectBlock(ofKind("tool-result"));
    expect(inspection?.family).toBe("tool");
    expect(
      inspection?.facts.some((fact) => fact.label === "outcome" && fact.value === "completed"),
    ).toBe(true);
    expect(hasDiagnostics(ofKind("tool-result"))).toBe(false);
  });

  test("reveals reasoning as an explicit inspection, not as the answer", () => {
    const inspection = inspectBlock(ofKind("model-reasoning"));
    expect(inspection?.family).toBe("reasoning");
    expect(inspection?.title).toBe("Model reasoning");
    expect(inspection?.facts.some((fact) => fact.label === "reasoning")).toBe(true);
  });

  test("treats a diagnostic as error inspection with an uncertain outcome", () => {
    const inspection = inspectBlock(ofKind("diagnostic"));
    expect(inspection?.family).toBe("error");
    expect(hasDiagnostics(ofKind("diagnostic"))).toBe(true);
    expect(
      inspection?.facts.some(
        (fact) => fact.label === "outcome" && fact.value.includes("uncertain"),
      ),
    ).toBe(true);
  });
});

describe("inspectionFor", () => {
  test("looks up the selected key and ignores a missing one", () => {
    const blocks = everyBlockKind();
    const processExit = ofKind("process-exit");
    expect(inspectionFor(blocks, blockKey(processExit.anchor))?.family).toBe("process");
    expect(inspectionFor(blocks, "missing")).toBeNull();
    expect(inspectionFor(blocks, null)).toBeNull();
  });
});

describe("sliceInspection", () => {
  test("keeps the summary and reports facts the overlay cannot draw", () => {
    const inspection = inspectBlock(ofKind("process-exit"));
    if (inspection === null) {
      throw new Error("process-exit must be inspectable");
    }
    expect(sliceInspection(inspection, 0)).toEqual({
      showSummary: false,
      facts: [],
      hidden: inspection.facts.length,
    });
    expect(sliceInspection(inspection, 1)).toEqual({
      showSummary: true,
      facts: [],
      hidden: inspection.facts.length,
    });
    const fitted = sliceInspection(inspection, 3);
    expect(fitted.showSummary).toBe(true);
    expect(fitted.facts.length).toBe(1);
    expect(fitted.hidden).toBe(inspection.facts.length - 1);
  });
});

describe("describeTerminalOutcome", () => {
  test("names every outcome without collapsing uncertain into failed", () => {
    expect(describeTerminalOutcome({ kind: "completed" })).toBe("completed");
    expect(describeTerminalOutcome({ kind: "failed", effect: "none" })).toBe(
      "failed (none effect)",
    );
    expect(describeTerminalOutcome({ kind: "uncertain", effect: "uncertain" })).toBe(
      "uncertain (inspect before retry)",
    );
  });
});
