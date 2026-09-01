/** Human projections for saved and active workspace layouts. */

import type {
  WorkspaceListPayload,
  WorkspaceSavePayload,
  WorkspaceSetPayload,
} from "../commands.ts";
import type { RenderedPayload } from "./payload.ts";
import { paint, type Session } from "./session.ts";
import { safe } from "./text.ts";

export function renderWorkspaceList(
  session: Session,
  payload: WorkspaceListPayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No workspace layouts are available."], diagnostics: [] };
  }
  if (payload.layouts.length === 0) {
    return { lines: ["No saved workspace layouts."], diagnostics: [] };
  }
  return {
    lines: [
      paint(session, "plain", "Workspace layouts"),
      ...payload.layouts.map((entry) => `  ${safe(entry.name)}  roots=${entry.rootCount}`),
    ],
    diagnostics: [],
  };
}

export function renderWorkspaceSet(
  session: Session,
  payload: WorkspaceSetPayload | null,
  command: "workspace.show" | "workspace.load",
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No workspace set is available."], diagnostics: [] };
  }
  const title = command === "workspace.load" ? "Workspace loaded" : "Workspace set";
  const source =
    payload.layoutName === null ? payload.source : `${payload.source}:${payload.layoutName}`;
  return {
    lines: [
      paint(session, "plain", title),
      `  Source       ${safe(source)}`,
      ...payload.roots.map(
        (root) => `  ${safe(root.rootId)}  ${safe(root.name)}  ${safe(root.path)}`,
      ),
    ],
    diagnostics: [],
  };
}

export function renderWorkspaceSave(
  session: Session,
  payload: WorkspaceSavePayload | null,
): RenderedPayload {
  if (payload === null) {
    return { lines: ["No workspace layout was saved."], diagnostics: [] };
  }
  return {
    lines: [
      paint(session, "plain", "Workspace layout saved"),
      `  Name         ${safe(payload.name)}`,
      ...payload.roots.map(
        (root) => `  ${safe(root.rootId)}  ${safe(root.name)}  ${safe(root.path)}`,
      ),
    ],
    diagnostics: [],
  };
}
