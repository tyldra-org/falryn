/**
 * Workspace-set header and overlay facts for the interactive shell (#607).
 *
 * The header projects the primary root’s display name plus a count of extras
 * (`falryn +2`). Path bind and layout persistence stay in application ports;
 * this module only formats what those ports already resolved.
 */

import { type FactValue, known, type WorkspaceHeaderModel } from "../view-model.ts";

export type WorkspaceRootView = {
  readonly rootId: string;
  readonly name: string;
  readonly path: string;
};

export type WorkspaceSetView = {
  readonly roots: readonly WorkspaceRootView[];
};

export const EMPTY_WORKSPACE_SET: WorkspaceSetView = { roots: [] };

/**
 * Compact header text: primary display name, plus ` +N` when more roots exist.
 *
 * An empty set is not a label — callers leave the field unavailable instead.
 */
export function formatWorkspaceHeaderText(set: WorkspaceSetView): string | null {
  const primary = set.roots[0];
  if (primary === undefined) {
    return null;
  }
  const extras = set.roots.length - 1;
  return extras > 0 ? `${primary.name} +${extras}` : primary.name;
}

/** Header workspace field from a resolved set, or the caller’s existing value. */
export function projectWorkspaceHeader(
  header: WorkspaceHeaderModel,
  set: WorkspaceSetView | null,
): WorkspaceHeaderModel {
  if (set === null) {
    return header;
  }
  const text = formatWorkspaceHeaderText(set);
  if (text === null) {
    return header;
  }
  return { ...header, workspace: known(text) };
}

export function workspaceRootFacts(set: WorkspaceSetView): readonly {
  readonly label: string;
  readonly value: FactValue;
}[] {
  return set.roots.map((root, index) => ({
    label: index === 0 ? `${root.name} (primary)` : root.name,
    value: known(root.path),
  }));
}

export const WORKSPACE_PANELS = ["show", "add", "remove", "save", "load"] as const;
export type WorkspacePanel = (typeof WORKSPACE_PANELS)[number];

export const WORKSPACE_PANEL_TITLES: Readonly<Record<WorkspacePanel, string>> = {
  show: "Workspace set",
  add: "Add workspace root",
  remove: "Remove workspace root",
  save: "Save workspace layout",
  load: "Load workspace layout",
};

export function workspaceOverlayRoute(panel: WorkspacePanel): {
  readonly kind: "workspace";
  readonly panel: WorkspacePanel;
  readonly draft: string;
} {
  return { kind: "workspace", panel, draft: "" };
}
