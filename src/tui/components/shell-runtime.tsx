/**
 * The interactive half of the shell: state, focus, and the keymap over them.
 *
 * `AppShell` draws a frame from a view model. This is what makes the frame
 * respond — it owns the overlay route, the focus model, and the command state,
 * registers one keymap layer per active context, and dispatches by stable
 * command ID.
 *
 * It exists as a hook rather than as more state inside `AppShell` for one
 * reason: everything here is testable against a keymap with no renderer behind
 * it, while `AppShell` cannot be. The reducer, the focus transitions, and the
 * command handlers are values; only the registration touches OpenTUI.
 *
 * ## Why the keymap is not optional
 *
 * A terminal in raw mode does not generate signals. `ISIG` is off, so pressing
 * Ctrl+C sends the byte `0x03` to stdin and no `SIGINT` is raised — which meant
 * that before this module existed the shell could be exited only by killing it
 * from another window, while the status line said `^C exit`. `app.exit` is the
 * binding that makes that sentence true.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  COMMAND_CONTEXTS,
  type CommandContext,
  type CommandState,
  commandById,
  EMPTY_COMMAND_STATE,
  type ShellCommand,
} from "../commands.ts";
import {
  type ComposerAction,
  type ComposerState,
  composerReducer,
  cursorPosition,
  type EditorAction,
  EMPTY_EDITOR,
  editorReducer,
  INITIAL_COMPOSER_STATE,
  linesOf,
  type SubmissionPort,
  UNAVAILABLE_SUBMISSION,
} from "../composer/index.ts";
import {
  containFocus,
  createFocusModel,
  type FocusModel,
  type FocusRegion,
  focusNext,
  focusPrevious,
  releaseFocus,
  withRegions,
} from "../focus.ts";
import { isContextActive, type KeymapPlan, resolveBinding } from "../keymap.ts";
import {
  anchorAt,
  anchorRevealing,
  INITIAL_TRANSCRIPT_STATE,
  LATEST,
  neighbourKey,
  scrolledBy,
  type TranscriptSurfaceAction,
  type TranscriptSurfaceState,
  totalRowsOf,
  transcriptSurfaceReducer,
} from "../transcript/index.ts";
import { EMPTY_GEOMETRY, type TranscriptGeometry } from "../transcript-model.ts";
import type { OverlayRoute } from "../view-model.ts";

/**
 * The regions of the frame, in reading order.
 *
 * Labels rather than ids alone, because a focus indicator that is not
 * colour-only needs words to put beside the region — and because "you are in the
 * workspace header" is the only thing an interface can honestly say to someone
 * who cannot see a highlight.
 */
export const FRAME_REGIONS: readonly FocusRegion[] = [
  { id: "frame.header", label: "workspace header" },
  { id: "frame.primary", label: "main region" },
  // Between the transcript and the status line, which is where it is drawn and
  // where reading order puts it. #357: the composer is a focusable control, and
  // its focus is what activates the composer keymap layer.
  { id: "frame.composer", label: "composer" },
  { id: "frame.status", label: "status line" },
];

/** The region id the composer occupies. One owner, so nothing spells it twice. */
export const COMPOSER_REGION = "frame.composer";

/** The regions an overlay contains focus within while it is open. */
export function overlayRegions(route: OverlayRoute): readonly FocusRegion[] {
  switch (route.kind) {
    case "help":
      return [{ id: "overlay.help", label: "help" }];
    case "palette":
      return [{ id: "overlay.palette", label: "command palette" }];
    case "none":
      return FRAME_REGIONS;
  }
}

/**
 * What the transcript surface is, as far as availability is concerned.
 *
 * Two numbers rather than the projection, because a command's availability must
 * depend on what exists and not on what was drawn. "There is a transcript with
 * entries in it" and "the entries are taller than the region" are the only two
 * facts any command here needs, and both are answers the surface reports after
 * it measures.
 */
export type TranscriptFacts = {
  readonly blocks: number;
  readonly scrollable: boolean;
};

export const NO_TRANSCRIPT: TranscriptFacts = { blocks: 0, scrollable: false };

export type ShellState = {
  readonly overlay: OverlayRoute;
  readonly focus: FocusModel;
  /** The last thing a command did, for the status line. Cleared by the next one. */
  readonly notice: string | null;
  /** Set when `app.exit` ran. The caller ends the session; this does not. */
  readonly exiting: boolean;
  /** What the reader has done to the transcript. Never persisted. */
  readonly transcript: TranscriptSurfaceState;
  readonly transcriptFacts: TranscriptFacts;
  /** The draft, its history, and the phase. Lives here so an overlay cannot reach it. */
  readonly composer: ComposerState;
};

export type ShellAction =
  | { readonly kind: "open-overlay"; readonly route: OverlayRoute }
  | { readonly kind: "close-overlay" }
  | { readonly kind: "focus-next" }
  | { readonly kind: "focus-previous" }
  | { readonly kind: "notice"; readonly message: string }
  /** The reachable regions changed: a resize, or an item going away. */
  | { readonly kind: "reseat"; readonly regions: readonly FocusRegion[] }
  | { readonly kind: "transcript"; readonly action: TranscriptSurfaceAction }
  /** The surface measured itself. Only dispatched when an answer actually changed. */
  | { readonly kind: "transcript-facts"; readonly facts: TranscriptFacts }
  | { readonly kind: "composer"; readonly action: ComposerAction }
  /** Typing in the open palette. Ignored when the palette is not the route. */
  | { readonly kind: "palette-query"; readonly action: EditorAction }
  | { readonly kind: "exit" };

export const INITIAL_SHELL_STATE: ShellState = {
  overlay: { kind: "none" },
  focus: createFocusModel(FRAME_REGIONS),
  notice: null,
  exiting: false,
  transcript: INITIAL_TRANSCRIPT_STATE,
  transcriptFacts: NO_TRANSCRIPT,
  composer: INITIAL_COMPOSER_STATE,
};

/**
 * The state machine, as a pure function.
 *
 * Focus containment lives here rather than in the overlay component, so opening
 * an overlay and restoring focus when it closes are one transition each rather
 * than a component mounting and something else remembering.
 */
export function shellReducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.kind) {
    case "open-overlay":
      return {
        ...state,
        overlay: action.route,
        focus: containFocus(state.focus, overlayRegions(action.route)),
        notice: null,
      };
    case "close-overlay":
      return state.overlay.kind === "none"
        ? state
        : {
            ...state,
            overlay: { kind: "none" },
            focus: releaseFocus(state.focus, FRAME_REGIONS),
            notice: null,
          };
    case "focus-next":
      return { ...state, focus: focusNext(state.focus) };
    case "focus-previous":
      return { ...state, focus: focusPrevious(state.focus) };
    case "notice":
      return { ...state, notice: action.message === "" ? null : action.message };
    case "reseat":
      // Focus stays where it can and moves to the documented neighbour where it
      // cannot. The overlay is untouched: a resize does not close one, and it
      // does not move the transcript's anchor either — the anchor names a block,
      // so re-wrapping changes that block's height and not which block is being
      // read.
      return { ...state, focus: withRegions(state.focus, action.regions) };
    case "transcript":
      return { ...state, transcript: transcriptSurfaceReducer(state.transcript, action.action) };
    case "palette-query": {
      if (state.overlay.kind !== "palette") {
        // A key that arrived while the palette was closing. Dropped rather
        // than stored: there is no query to edit, and reviving one would be
        // the stale-search failure the route shape exists to prevent.
        return state;
      }
      const query = editorReducer(state.overlay.query, action.action);
      return query === state.overlay.query
        ? state
        : { ...state, overlay: { kind: "palette", query } };
    }
    case "composer": {
      const composer = composerReducer(state.composer, action.action);
      // Identity when the composer refused the action. A new state object for an
      // unchanged answer would re-render the whole frame on every key that did
      // nothing, which for a text control is most of them at a boundary.
      return composer === state.composer ? state : { ...state, composer };
    }
    case "transcript-facts":
      // Identity when nothing changed. The surface reports what it measured on
      // every frame it measures, and a new state object for an unchanged answer
      // would re-render the tree from inside an effect that ran because the tree
      // rendered — which is a measure/render loop rather than a frame.
      return state.transcriptFacts.blocks === action.facts.blocks &&
        state.transcriptFacts.scrollable === action.facts.scrollable
        ? state
        : { ...state, transcriptFacts: action.facts };
    case "exit":
      return { ...state, exiting: true };
  }
}

/** The command state implied by what the shell currently has. */
export function commandStateFor(state: ShellState): CommandState {
  return {
    ...EMPTY_COMMAND_STATE,
    overlayOpen: state.overlay.kind !== "none",
    hasTranscript: state.transcriptFacts.blocks > 0,
    hasScrollableContent: state.transcriptFacts.scrollable,
    // Focus, not existence. See `CommandState.hasComposer`: an always-active
    // composer layer would take `up` and `down` from the transcript for good.
    hasComposer: state.focus.focused === COMPOSER_REGION,
  };
}

export type ShellRuntime = {
  readonly state: ShellState;
  readonly commandState: CommandState;
  /**
   * Runs a command by ID.
   *
   * Returns whether it ran. An unavailable command does not run and says why on
   * the notice — the alternative, silently doing nothing, is what makes a key
   * feel broken rather than unavailable.
   */
  run(id: string): boolean;
  /** Runs whatever a key resolves to right now. Returns whether anything did. */
  press(key: string): boolean;
  /** Re-seats focus over a new region set, keeping it where it can. */
  reseat(regions: readonly FocusRegion[]): void;
  /** Accepts what the transcript measured. Stable, so it may be an effect's dependency. */
  reportTranscriptGeometry(geometry: TranscriptGeometry): void;
  /**
   * Sends an action to the composer.
   *
   * The control needs this because typing is not a command: a printable key is
   * text, and routing every character through the registry would put a command
   * dispatch between a keystroke and the character it produces. Bindings still
   * go through `run`; this is the path for everything that is not one.
   */
  composer(action: ComposerAction): void;
  /** Sends an edit to the open palette's search field. */
  paletteQuery(action: EditorAction): void;
};

export type ShellRuntimeOptions = {
  readonly plan: KeymapPlan;
  /**
   * Ends the session.
   *
   * Supplied by the caller because this module does not own the exit: the
   * invocation's cancellation scope does, and a second path out would be a
   * second answer to what a shell exiting means.
   */
  readonly onExit: () => void;
  /**
   * The block keys the projection currently holds, in order.
   *
   * Keys rather than blocks: selection and expansion are identity, and a
   * runtime that held the blocks would be a second reader of content it has no
   * reason to see.
   */
  readonly transcriptKeys: readonly string[];
  /**
   * Where a submission goes.
   *
   * Supplied so a test can hand over a port that accepts, which is the only way
   * to exercise the accepted path in a build whose one real port refuses. The
   * default is the honest refusal.
   */
  readonly submission?: SubmissionPort;
};

export function useShellRuntime(options: ShellRuntimeOptions): ShellRuntime {
  const [state, dispatch] = useReducer(shellReducer, INITIAL_SHELL_STATE);
  const commandState = useMemo(() => commandStateFor(state), [state]);

  // A ref rather than state. The spans and the row budget are what the reader is
  // currently looking at, and writing them into state would re-render the tree
  // on every frame that measured the same thing again. The two *answers* that
  // change availability are dispatched instead, and only when they change.
  const geometry = useRef<TranscriptGeometry>(EMPTY_GEOMETRY);

  // `dispatch` is stable, so this callback is too — which matters because the
  // surface reports from an effect, and an unstable callback there would re-run
  // the effect on every render. The reducer, not this, decides whether the
  // report changed anything: see the `transcript-facts` case.
  const reportTranscriptGeometry = useCallback((next: TranscriptGeometry): void => {
    geometry.current = next;
    dispatch({
      kind: "transcript-facts",
      facts: { blocks: next.spans.length, scrollable: totalRowsOf(next.spans) > next.rows },
    });
  }, []);

  const run = useCallback(
    (id: string): boolean => {
      const command = commandById(id);
      if (command === undefined) {
        // A binding referencing an unregistered command fails closed rather than
        // falling back to something shorter or doing nothing quietly.
        dispatch({ kind: "notice", message: `No command named ${id}.` });
        return false;
      }

      const availability = command.availability(commandStateFor(state));
      if (availability.kind === "unavailable") {
        dispatch({
          kind: "notice",
          message: `${command.title} is unavailable: ${availability.reason}.`,
        });
        return false;
      }

      return runAvailable(
        command,
        dispatch,
        options.onExit,
        {
          geometry: geometry.current,
          anchor: state.transcript.anchor,
          selected: state.transcript.selected,
          keys: options.transcriptKeys,
        },
        state.composer,
      );
    },
    [state, options.onExit, options.transcriptKeys],
  );

  const press = useCallback(
    (key: string): boolean => {
      const binding = resolveBinding(options.plan, key, commandStateFor(state));
      return binding === null ? false : run(binding.command);
    },
    [options.plan, state, run],
  );

  const reseat = useCallback((regions: readonly FocusRegion[]): void => {
    dispatch({ kind: "reseat", regions });
  }, []);

  const composer = useCallback((action: ComposerAction): void => {
    dispatch({ kind: "composer", action });
  }, []);

  const paletteQuery = useCallback((action: EditorAction): void => {
    dispatch({ kind: "palette-query", action });
  }, []);

  // The projection changed shape, so a selection or an expansion naming a block
  // that is gone is dropped and an empty selection settles on the latest entry.
  // The reducer returns identity when nothing changed, which is what keeps this
  // from re-rendering the tree on every projection that happens to be equal.
  const { transcriptKeys } = options;
  useEffect(() => {
    dispatch({ kind: "transcript", action: { kind: "reconcile", keys: transcriptKeys } });
  }, [transcriptKeys]);

  // The port answers in the transition after the snapshot was taken, so the
  // machine really passes through `sending` rather than resolving inside the
  // same dispatch. That is the phase a later provider will hold open, and a
  // shortcut here would be a state nothing ever entered.
  const port = options.submission ?? UNAVAILABLE_SUBMISSION;
  const inFlight = state.composer.inFlight;
  useEffect(() => {
    if (inFlight === null) {
      return;
    }
    dispatch({ kind: "composer", action: { kind: "resolve", outcome: port.submit(inFlight) } });
  }, [inFlight, port]);

  return {
    state,
    commandState,
    run,
    press,
    reseat,
    reportTranscriptGeometry,
    composer,
    paletteQuery,
  };
}

/**
 * Everything a transcript command needs that is not in the registry.
 *
 * Passed rather than read, so the effects below stay a pure function of the
 * geometry the reader is looking at. A handler that reached for a ref would be
 * testable only through a renderer.
 */
type TranscriptContext = {
  readonly geometry: TranscriptGeometry;
  readonly anchor: TranscriptSurfaceState["anchor"];
  readonly selected: string | null;
  readonly keys: readonly string[];
};

/**
 * What an available command does.
 *
 * Separate from `run` so the availability check and the effect cannot drift: a
 * command reaching here has already been found and found available, and this
 * function's only job is the effect.
 */
function runAvailable(
  command: ShellCommand,
  dispatch: (action: ShellAction) => void,
  onExit: () => void,
  transcript: TranscriptContext,
  composer: ComposerState,
): boolean {
  const request = {
    spans: transcript.geometry.spans,
    rows: transcript.geometry.rows,
    anchor: transcript.anchor,
  };
  // A page is the region less one row, so the line a reader was on stays on
  // screen. A full-height page moves every row they were reading off it.
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
      // Always an empty query. The palette opens ready to search rather than
      // showing whatever was typed the last time it was open.
      dispatch({ kind: "open-overlay", route: { kind: "palette", query: EMPTY_EDITOR } });
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
    // The end of a transcript is the latest entry, so both keys resolve to the
    // following anchor rather than to a pin on the last block — a pin there
    // would stop following the moment that block grew.
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
      // Selection moves the window only when it has to. See `anchorRevealing`.
      dispatch({ kind: "transcript", action: anchorAction(anchorRevealing(request, key)) });
      return true;
    }

    case "transcript.expand": {
      if (transcript.selected === null) {
        dispatch({ kind: "notice", message: "There is no entry to expand." });
        return false;
      }
      dispatch({
        kind: "transcript",
        action: { kind: "toggle-expansion", key: transcript.selected },
      });
      return true;
    }

    case "composer.submit":
      dispatch({ kind: "composer", action: { kind: "submit" } });
      return true;
    case "composer.newline":
      dispatch({ kind: "composer", action: { kind: "edit", action: { kind: "newline" } } });
      return true;

    // `up` and `down` are a line inside the draft and a history step at its
    // edges. The boundary is decided here rather than in the composer's reducer
    // because it is a *binding* question — what this key means right now — and
    // the reducer would have to be told the answer either way.
    case "composer.historyPrevious": {
      const at = cursorPosition(composer.editor);
      if (at.line > 0) {
        dispatch({
          kind: "composer",
          action: { kind: "edit", action: { kind: "move", motion: "up", extend: false } },
        });
        return true;
      }
      dispatch({ kind: "composer", action: { kind: "history-previous" } });
      return true;
    }
    case "composer.historyNext": {
      const at = cursorPosition(composer.editor);
      if (at.line < linesOf(composer.editor).length - 1) {
        dispatch({
          kind: "composer",
          action: { kind: "edit", action: { kind: "move", motion: "down", extend: false } },
        });
        return true;
      }
      dispatch({ kind: "composer", action: { kind: "history-next" } });
      return true;
    }

    default:
      // Every other command is declared unavailable in this build, so reaching
      // here means a command was made available without an effect being written
      // for it. Saying so is better than appearing to work.
      dispatch({
        kind: "notice",
        message: `${command.title} has no effect in this build.`,
      });
      return false;
  }
}

/** The contexts whose layers should be live, given the state. */
export function activeContexts(state: ShellState): readonly CommandContext[] {
  const commandState = commandStateFor(state);
  return COMMAND_CONTEXTS.filter((context) => isContextActive(context, commandState));
}
