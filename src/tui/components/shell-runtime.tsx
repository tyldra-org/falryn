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

import { useCallback, useMemo, useReducer } from "react";
import {
  COMMAND_CONTEXTS,
  type CommandContext,
  type CommandState,
  commandById,
  EMPTY_COMMAND_STATE,
  type ShellCommand,
} from "../commands.ts";
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
  { id: "frame.status", label: "status line" },
];

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

export type ShellState = {
  readonly overlay: OverlayRoute;
  readonly focus: FocusModel;
  /** The last thing a command did, for the status line. Cleared by the next one. */
  readonly notice: string | null;
  /** Set when `app.exit` ran. The caller ends the session; this does not. */
  readonly exiting: boolean;
};

export type ShellAction =
  | { readonly kind: "open-overlay"; readonly route: OverlayRoute }
  | { readonly kind: "close-overlay" }
  | { readonly kind: "focus-next" }
  | { readonly kind: "focus-previous" }
  | { readonly kind: "notice"; readonly message: string }
  /** The reachable regions changed: a resize, or an item going away. */
  | { readonly kind: "reseat"; readonly regions: readonly FocusRegion[] }
  | { readonly kind: "exit" };

export const INITIAL_SHELL_STATE: ShellState = {
  overlay: { kind: "none" },
  focus: createFocusModel(FRAME_REGIONS),
  notice: null,
  exiting: false,
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
      // cannot. The overlay is untouched: a resize does not close one.
      return { ...state, focus: withRegions(state.focus, action.regions) };
    case "exit":
      return { ...state, exiting: true };
  }
}

/** The command state implied by what the shell currently has. */
export function commandStateFor(state: ShellState): CommandState {
  return {
    ...EMPTY_COMMAND_STATE,
    overlayOpen: state.overlay.kind !== "none",
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
};

export function useShellRuntime(options: ShellRuntimeOptions): ShellRuntime {
  const [state, dispatch] = useReducer(shellReducer, INITIAL_SHELL_STATE);
  const commandState = useMemo(() => commandStateFor(state), [state]);

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

      return runAvailable(command, dispatch, options.onExit);
    },
    [state, options.onExit],
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

  return { state, commandState, run, press, reseat };
}

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
): boolean {
  switch (command.id) {
    case "app.help":
      dispatch({ kind: "open-overlay", route: { kind: "help" } });
      return true;
    case "app.commandPalette":
      dispatch({ kind: "open-overlay", route: { kind: "palette" } });
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
