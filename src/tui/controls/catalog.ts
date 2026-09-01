/**
 * Session, model, context, and resource control facts.
 *
 * A view over catalogs the application port supplies. It does not create
 * durable sessions, call a provider, or invent a dashboard. Empty lists and
 * unavailable facts are the truth in a build with no producer, not placeholders.
 */

import { type FactValue, known, type WorkspaceHeaderModel } from "../view-model.ts";

export const CONTROL_PANELS = ["session", "model", "profile", "context", "resource"] as const;
export type ControlPanel = (typeof CONTROL_PANELS)[number];

export const CONTROL_PANEL_TITLES: Readonly<Record<ControlPanel, string>> = {
  session: "Sessions",
  model: "Models",
  profile: "Execution modes",
  context: "Context",
  resource: "Resources",
};

export type ControlOption = {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
};

export type ControlFact = {
  readonly label: string;
  readonly value: FactValue;
};

export type ControlCatalog = {
  readonly sessions: readonly ControlOption[];
  readonly models: readonly ControlOption[];
  readonly profiles: readonly ControlOption[];
  readonly context: readonly ControlFact[];
  readonly resources: readonly ControlFact[];
};

export type ControlSelection = {
  readonly sessionId: string | null;
  readonly modelKey: string | null;
};

export const EMPTY_CONTROL_SELECTION: ControlSelection = {
  sessionId: null,
  modelKey: null,
};

function unavailableFact(reason: string): FactValue {
  return { kind: "unavailable", reason };
}

/** What a real run with no producer can honestly show. */
export const EMPTY_CONTROL_CATALOG: ControlCatalog = {
  sessions: [],
  models: [],
  profiles: [],
  context: [
    { label: "tokens", value: unavailableFact("no context pack yet") },
    { label: "bytes", value: unavailableFact("no context pack yet") },
    { label: "items", value: unavailableFact("no context pack yet") },
  ],
  resources: [
    { label: "scopes", value: unavailableFact("no runtime attached") },
    { label: "memory", value: unavailableFact("no resource probe yet") },
    { label: "tokens", value: unavailableFact("no usage yet") },
  ],
};

export function overlayForPanel(panel: ControlPanel): {
  readonly kind: "controls";
  readonly panel: ControlPanel;
} {
  return { kind: "controls", panel };
}

/**
 * Header session/model fields from a UI cursor over the supplied lists.
 *
 * A missing cursor leaves the field as the caller already had it. An id that
 * is no longer in the list is an error, not a reused label.
 */
export function projectHeader(
  header: WorkspaceHeaderModel,
  catalog: ControlCatalog,
  selection: ControlSelection,
): WorkspaceHeaderModel {
  return {
    ...header,
    session: fieldFromOptions(header.session, catalog.sessions, selection.sessionId, "session"),
    model: fieldFromOptions(header.model, catalog.models, selection.modelKey, "model"),
  };
}

function fieldFromOptions(
  fallback: FactValue,
  options: readonly ControlOption[],
  selectedId: string | null,
  noun: "session" | "model",
): FactValue {
  if (selectedId === null) {
    return fallback;
  }
  const match = options.find((item) => item.id === selectedId);
  if (match === undefined) {
    return { kind: "error", reason: `${noun} is gone` };
  }
  return known(match.title);
}

/**
 * Facts that fit the overlay's row budget.
 *
 * Overflow is counted, never drawn over. A one-row panel keeps the first fact
 * and reports the rest; a zero-row panel draws nothing.
 */
export function sliceControlFacts(
  facts: readonly ControlFact[],
  rows: number,
): {
  readonly facts: readonly ControlFact[];
  readonly hidden: number;
} {
  if (rows < 1) {
    return { facts: [], hidden: facts.length };
  }
  const needsNotice = facts.length > rows;
  const budget = needsNotice && rows >= 2 ? rows - 1 : rows;
  const shown = facts.slice(0, Math.max(0, budget));
  return { facts: shown, hidden: facts.length - shown.length };
}

export function optionsFor(catalog: ControlCatalog, panel: ControlPanel): readonly ControlOption[] {
  switch (panel) {
    case "session":
      return catalog.sessions;
    case "model":
      return catalog.models;
    case "profile":
      return catalog.profiles;
    case "context":
    case "resource":
      return [];
    default: {
      const exhaustive: never = panel;
      return exhaustive;
    }
  }
}

export function factsFor(catalog: ControlCatalog, panel: ControlPanel): readonly ControlFact[] {
  switch (panel) {
    case "context":
      return catalog.context;
    case "resource":
      return catalog.resources;
    case "session":
    case "model":
    case "profile":
      return [];
    default: {
      const exhaustive: never = panel;
      return exhaustive;
    }
  }
}

export function emptyReason(panel: ControlPanel): string {
  switch (panel) {
    case "session":
      return "No sessions yet.";
    case "model":
      return "No models yet.";
    case "profile":
      return "No execution modes yet.";
    case "context":
      return "No context facts yet.";
    case "resource":
      return "No resource facts yet.";
    default: {
      const exhaustive: never = panel;
      return exhaustive;
    }
  }
}
