import { describe, expect, test } from "bun:test";
import { known, unavailable, type WorkspaceHeaderModel } from "../view-model.ts";
import {
  type ControlCatalog,
  EMPTY_CONTROL_CATALOG,
  emptyReason,
  factsFor,
  optionsFor,
  overlayForPanel,
  projectHeader,
  sliceControlFacts,
} from "./catalog.ts";

const HEADER: WorkspaceHeaderModel = {
  workspace: known("/work/falryn"),
  branch: unavailable("no Git yet"),
  session: unavailable("no session yet"),
  model: unavailable("no provider yet"),
};

const CATALOG: ControlCatalog = {
  sessions: [{ id: "s1", title: "coding", detail: "workspace falryn" }],
  models: [{ id: "m1", title: "local-small", detail: "8k context" }],
  context: [
    { label: "tokens", value: known("1200 / 8000") },
    { label: "bytes", value: known("48 KiB") },
    { label: "items", value: known("12") },
  ],
  resources: [
    { label: "scopes", value: known("2 live") },
    { label: "memory", value: unavailable("no resource probe yet") },
  ],
};

describe("projectHeader", () => {
  test("leaves unavailable fields when nothing is selected", () => {
    expect(projectHeader(HEADER, CATALOG, { sessionId: null, modelId: null })).toEqual(HEADER);
  });

  test("projects a selected id as a known untrusted label", () => {
    const header = projectHeader(HEADER, CATALOG, { sessionId: "s1", modelId: "m1" });
    expect(header.session).toEqual(known("coding"));
    expect(header.model).toEqual(known("local-small"));
  });

  test("names a vanished id instead of reusing the last label", () => {
    const header = projectHeader(HEADER, CATALOG, { sessionId: "gone", modelId: "missing" });
    expect(header.session).toEqual({ kind: "error", reason: "session is gone" });
    expect(header.model).toEqual({ kind: "error", reason: "model is gone" });
  });
});

describe("sliceControlFacts", () => {
  test("draws nothing into a zero-row panel", () => {
    expect(sliceControlFacts(CATALOG.context, 0)).toEqual({
      facts: [],
      hidden: 3,
    });
  });

  test("counts overflow instead of drawing over the budget", () => {
    const sliced = sliceControlFacts(CATALOG.context, 2);
    expect(sliced.facts.map((fact) => fact.label)).toEqual(["tokens"]);
    expect(sliced.hidden).toBe(2);
  });

  test("fits the full list when the budget is enough", () => {
    expect(sliceControlFacts(CATALOG.context, 3).hidden).toBe(0);
  });
});

describe("panel catalogs", () => {
  test("open a named overlay route", () => {
    expect(overlayForPanel("session")).toEqual({ kind: "controls", panel: "session" });
  });

  test("lists options only on session and model panels", () => {
    expect(optionsFor(CATALOG, "session")).toEqual(CATALOG.sessions);
    expect(optionsFor(CATALOG, "context")).toEqual([]);
    expect(factsFor(CATALOG, "resource")).toEqual(CATALOG.resources);
    expect(factsFor(EMPTY_CONTROL_CATALOG, "session")).toEqual([]);
  });

  test("names an empty list instead of showing a dash", () => {
    expect(emptyReason("session")).toBe("No sessions yet.");
    expect(emptyReason("model")).toBe("No models yet.");
  });
});
