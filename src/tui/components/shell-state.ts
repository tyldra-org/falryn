import {
  COMMAND_CONTEXTS,
  type CommandContext,
  type CommandState,
  EMPTY_COMMAND_STATE,
} from "../commands.ts";
import {
  type ComposerAction,
  type ComposerState,
  composerReducer,
  INITIAL_COMPOSER_STATE,
} from "../composer/index.ts";
import {
  containFocus,
  createFocusModel,
  type FocusModel,
  type FocusRegion,
  focusNext,
  focusPrevious,
  focusRegion,
  releaseFocus,
  withRegions,
} from "../focus.ts";
import { isContextActive } from "../keymap.ts";
import {
  INITIAL_TRANSCRIPT_STATE,
  type TranscriptSurfaceAction,
  type TranscriptSurfaceState,
  transcriptSurfaceReducer,
} from "../transcript/index.ts";
import type { OverlayRoute } from "../view-model.ts";

/** The frame's focusable regions, in reading order. */
export const FRAME_REGIONS: readonly FocusRegion[] = [
  { id: "frame.header", label: "workspace header" },
  { id: "frame.primary", label: "main region" },
  { id: "frame.composer", label: "composer" },
  { id: "frame.status", label: "status line" },
];

export const COMPOSER_REGION = "frame.composer";

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

export type TranscriptFacts = {
  readonly blocks: number;
  readonly scrollable: boolean;
};

export const NO_TRANSCRIPT: TranscriptFacts = { blocks: 0, scrollable: false };

export type ShellState = {
  readonly overlay: OverlayRoute;
  readonly focus: FocusModel;
  readonly notice: string | null;
  readonly exiting: boolean;
  readonly transcript: TranscriptSurfaceState;
  readonly transcriptFacts: TranscriptFacts;
  readonly composer: ComposerState;
};

export type ShellAction =
  | { readonly kind: "open-overlay"; readonly route: OverlayRoute }
  | { readonly kind: "close-overlay" }
  | { readonly kind: "focus-next" }
  | { readonly kind: "focus-previous" }
  | { readonly kind: "focus-region"; readonly id: string }
  | { readonly kind: "notice"; readonly message: string }
  | { readonly kind: "reseat"; readonly regions: readonly FocusRegion[] }
  | { readonly kind: "transcript"; readonly action: TranscriptSurfaceAction }
  | { readonly kind: "transcript-facts"; readonly facts: TranscriptFacts }
  | { readonly kind: "composer"; readonly action: ComposerAction }
  | { readonly kind: "palette-query"; readonly query: string }
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

/** Pure owner of shell, focus, transcript-reader, and composer transitions. */
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
    case "focus-region":
      return { ...state, focus: focusRegion(state.focus, action.id) };
    case "notice":
      return { ...state, notice: action.message === "" ? null : action.message };
    case "reseat":
      return { ...state, focus: withRegions(state.focus, action.regions) };
    case "transcript":
      return { ...state, transcript: transcriptSurfaceReducer(state.transcript, action.action) };
    case "palette-query":
      if (state.overlay.kind !== "palette" || action.query === state.overlay.query) {
        return state;
      }
      return { ...state, overlay: { kind: "palette", query: action.query } };
    case "composer": {
      const composer = composerReducer(state.composer, action.action);
      return composer === state.composer ? state : { ...state, composer };
    }
    case "transcript-facts":
      return state.transcriptFacts.blocks === action.facts.blocks &&
        state.transcriptFacts.scrollable === action.facts.scrollable
        ? state
        : { ...state, transcriptFacts: action.facts };
    case "exit":
      return { ...state, exiting: true };
  }
}

export function commandStateFor(state: ShellState): CommandState {
  return {
    ...EMPTY_COMMAND_STATE,
    overlayOpen: state.overlay.kind !== "none",
    hasTranscript: state.transcriptFacts.blocks > 0,
    hasScrollableContent: state.transcriptFacts.scrollable,
    hasComposer: state.focus.focused === COMPOSER_REGION,
    hasHeldPaste: state.composer.lastPaste?.verdict === "preview",
    hasAttachments: state.composer.attachments.length > 0,
  };
}

export function activeContexts(state: ShellState): readonly CommandContext[] {
  const commandState = commandStateFor(state);
  if (commandState.overlayOpen) {
    return ["global", "overlay"];
  }
  return COMMAND_CONTEXTS.filter((context) => isContextActive(context, commandState));
}
