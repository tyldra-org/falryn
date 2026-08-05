import type { ShellCommand } from "../commands.ts";
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
import type { ShellAction } from "./shell-state.ts";

export type TranscriptCommandContext = {
  readonly geometry: TranscriptGeometry;
  readonly anchor: TranscriptSurfaceState["anchor"];
  readonly selected: string | null;
  readonly keys: readonly string[];
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
    default:
      dispatch({
        kind: "notice",
        message: `${command.title} has no effect in this build.`,
      });
      return false;
  }
}
