import { blockKey, type TranscriptBlock } from "../../presentation/index.ts";
import {
  artifactPresentationFor,
  blockOffersOpenArtifact,
  primaryArtifactId,
} from "../../presentation/transcript/artifact-open.ts";
import type { ShellCommand } from "../commands.ts";
import { sessionNavOverlayRoute } from "../session-nav/index.ts";
import { taskIntelligenceOverlayRoute } from "../task-intelligence/index.ts";
import {
  anchorAt,
  anchorRevealing,
  LATEST,
  neighbourKey,
  scrolledBy,
  type TranscriptSurfaceAction,
  type TranscriptSurfaceState,
} from "../transcript/index.ts";
import type { TranscriptGeometry } from "../transcript-model.ts";
import { artifactOverlayRoute, changesOverlayRoute } from "../view-model.ts";
import { workspaceOverlayRoute } from "../workspace/index.ts";
import type { ShellAction } from "./shell-state.ts";

export type TranscriptCommandContext = {
  readonly geometry: TranscriptGeometry;
  readonly anchor: TranscriptSurfaceState["anchor"];
  readonly selected: string | null;
  readonly keys: readonly string[];
  readonly blocks: readonly TranscriptBlock[];
};

/** Executes a registry command that has already passed its availability check. */
export function runAvailableCommand(
  command: ShellCommand,
  dispatch: (action: ShellAction) => void,
  onExit: () => void,
  transcript: TranscriptCommandContext,
): boolean {
  const request = {
    spans: transcript.geometry.spans,
    rows: transcript.geometry.rows,
    anchor: transcript.anchor,
  };
  const page = Math.max(1, transcript.geometry.rows - 1);
  const anchorAction = (anchor: TranscriptSurfaceState["anchor"]): TranscriptSurfaceAction => ({
    kind: "anchor",
    anchor,
  });

  switch (command.id) {
    case "app.help":
      dispatch({ kind: "open-overlay", route: { kind: "help" } });
      return true;
    case "app.commandPalette":
      dispatch({ kind: "open-overlay", route: { kind: "palette", query: "" } });
      return true;
    case "overlay.close":
      dispatch({ kind: "close-overlay" });
      return true;
    case "focus.next":
      dispatch({ kind: "focus-next" });
      return true;
    case "focus.previous":
      dispatch({ kind: "focus-previous" });
      return true;
    case "app.exit":
      dispatch({ kind: "exit" });
      onExit();
      return true;
    case "view.scrollUp":
      dispatch({ kind: "transcript", action: anchorAction(scrolledBy(request, -page)) });
      return true;
    case "view.scrollDown":
      dispatch({ kind: "transcript", action: anchorAction(scrolledBy(request, page)) });
      return true;
    case "view.top":
      dispatch({ kind: "transcript", action: anchorAction(anchorAt(request, 0)) });
      return true;
    case "view.bottom":
    case "transcript.jumpToLatest":
      dispatch({ kind: "transcript", action: anchorAction(LATEST) });
      return true;
    case "transcript.selectNext":
    case "transcript.selectPrevious": {
      const step = command.id === "transcript.selectNext" ? 1 : -1;
      const key = neighbourKey(transcript.keys, transcript.selected, step);
      if (key === null) {
        dispatch({ kind: "notice", message: "There is no entry to select." });
        return false;
      }
      dispatch({ kind: "transcript", action: { kind: "select", key } });
      dispatch({ kind: "transcript", action: anchorAction(anchorRevealing(request, key)) });
      return true;
    }
    case "transcript.expand":
      if (transcript.selected === null) {
        dispatch({ kind: "notice", message: "There is no entry to expand." });
        return false;
      }
      dispatch({
        kind: "transcript",
        action: { kind: "toggle-expansion", key: transcript.selected },
      });
      return true;
    case "transcript.inspect":
    case "transcript.showDiagnostics":
      if (transcript.selected === null) {
        dispatch({ kind: "notice", message: "There is no entry to inspect." });
        return false;
      }
      dispatch({
        kind: "open-overlay",
        route: { kind: "inspect", key: transcript.selected },
      });
      return true;
    case "transcript.openArtifact": {
      if (transcript.selected === null) {
        dispatch({ kind: "notice", message: "There is no entry to open." });
        return false;
      }
      const selectedBlock = findSelectedBlock(transcript);
      if (selectedBlock === null || !blockOffersOpenArtifact(selectedBlock)) {
        dispatch({ kind: "notice", message: "This entry has no artifact to open." });
        return false;
      }
      const artifactId = primaryArtifactId(selectedBlock);
      if (artifactId === null) {
        dispatch({ kind: "notice", message: "This entry has no artifact to open." });
        return false;
      }
      const presentation = artifactPresentationFor(selectedBlock);
      if (presentation === null) {
        dispatch({ kind: "notice", message: "This artifact has no viewer in this build." });
        return false;
      }
      dispatch({
        kind: "open-overlay",
        route: artifactOverlayRoute(artifactId, presentation),
      });
      return true;
    }
    case "artifact.toggleDiffLayout":
      dispatch({ kind: "artifact-toggle-layout" });
      return true;
    case "artifact.nextHunk":
      dispatch({ kind: "artifact-next-hunk" });
      return true;
    case "artifact.previousHunk":
      dispatch({ kind: "artifact-previous-hunk" });
      return true;
    case "changes.open":
      dispatch({ kind: "open-overlay", route: changesOverlayRoute() });
      return true;
    case "changes.nextTab":
      dispatch({ kind: "changes-tab", delta: 1 });
      return true;
    case "changes.previousTab":
      dispatch({ kind: "changes-tab", delta: -1 });
      return true;
    case "changes.nextEntry":
      dispatch({ kind: "changes-cursor", delta: 1 });
      return true;
    case "changes.previousEntry":
      dispatch({ kind: "changes-cursor", delta: -1 });
      return true;
    case "changes.createCheckpoint":
      dispatch({ kind: "changes-pending", pending: "create-checkpoint" });
      return true;
    case "changes.restoreCheckpoint":
      dispatch({ kind: "changes-pending", pending: "restore" });
      return true;
    case "composer.submit":
      dispatch({ kind: "composer", action: { kind: "submit" } });
      return true;
    case "composer.newline":
      return true;
    case "composer.historyPrevious":
      dispatch({ kind: "composer", action: { kind: "history-previous" } });
      return true;
    case "composer.historyNext":
      dispatch({ kind: "composer", action: { kind: "history-next" } });
      return true;
    case "session.switch":
      dispatch({ kind: "open-overlay", route: { kind: "controls", panel: "session" } });
      return true;
    case "model.select":
      dispatch({ kind: "open-overlay", route: { kind: "controls", panel: "model" } });
      return true;
    case "context.show":
      dispatch({ kind: "open-overlay", route: { kind: "controls", panel: "context" } });
      return true;
    case "resource.show":
      dispatch({ kind: "open-overlay", route: { kind: "controls", panel: "resource" } });
      return true;
    case "workspace.addRoot":
      dispatch({ kind: "open-overlay", route: workspaceOverlayRoute("add") });
      return true;
    case "workspace.removeRoot":
      dispatch({ kind: "open-overlay", route: workspaceOverlayRoute("remove") });
      return true;
    case "workspace.save":
      dispatch({ kind: "open-overlay", route: workspaceOverlayRoute("save") });
      return true;
    case "workspace.load":
      dispatch({ kind: "open-overlay", route: workspaceOverlayRoute("load") });
      return true;
    case "workspace.show":
      dispatch({ kind: "open-overlay", route: workspaceOverlayRoute("show") });
      return true;
    case "session.resume":
      dispatch({ kind: "open-overlay", route: sessionNavOverlayRoute("resume") });
      return true;
    case "session.fork":
      dispatch({ kind: "open-overlay", route: sessionNavOverlayRoute("fork") });
      return true;
    case "session.rewind":
      dispatch({ kind: "open-overlay", route: sessionNavOverlayRoute("rewind") });
      return true;
    case "session.replay":
      dispatch({ kind: "open-overlay", route: sessionNavOverlayRoute("replay") });
      return true;
    case "task.decompose":
      dispatch({ kind: "open-overlay", route: taskIntelligenceOverlayRoute("decompose") });
      return true;
    case "task.validate":
      dispatch({ kind: "open-overlay", route: taskIntelligenceOverlayRoute("validate") });
      return true;
    case "task.progress":
      dispatch({ kind: "open-overlay", route: taskIntelligenceOverlayRoute("progress") });
      return true;
    case "session.new":
      dispatch({
        kind: "notice",
        message: "New session has no effect in this build.",
      });
      return false;
    default:
      dispatch({
        kind: "notice",
        message: `${command.title} has no effect in this build.`,
      });
      return false;
  }
}

function findSelectedBlock(transcript: TranscriptCommandContext): TranscriptBlock | null {
  if (transcript.selected === null) {
    return null;
  }
  return transcript.blocks.find((block) => blockKey(block.anchor) === transcript.selected) ?? null;
}
