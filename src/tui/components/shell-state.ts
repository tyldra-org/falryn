import { blockKey, type TranscriptBlock } from "../../presentation/index.ts";
import {
  artifactPresentationFor,
  blockOffersOpenArtifact,
  primaryArtifactId,
} from "../../presentation/transcript/artifact-open.ts";
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
  type ConfirmationPrompt,
  confirmationIsStale,
  resolvedConfirmationKey,
} from "../confirmation/index.ts";
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
  hasDiagnostics,
  INITIAL_TRANSCRIPT_STATE,
  inspectBlock,
  type TranscriptSurfaceAction,
  type TranscriptSurfaceState,
  transcriptSurfaceReducer,
} from "../transcript/index.ts";
import type { OverlayRoute } from "../view-model.ts";
import { EMPTY_WORKSPACE_SET, type WorkspaceSetView } from "../workspace/index.ts";

/** The frame's focusable regions, in reading order. */
export const FRAME_REGIONS: readonly FocusRegion[] = [
  { id: "frame.header", label: "workspace header" },
  { id: "frame.primary", label: "main region" },
  { id: "frame.composer", label: "composer" },
  { id: "frame.status", label: "status line" },
];

export const COMPOSER_REGION = "frame.composer";
export const TRANSCRIPT_REGION = "frame.primary";

export function overlayRegions(route: OverlayRoute): readonly FocusRegion[] {
  switch (route.kind) {
    case "help":
      return [{ id: "overlay.help", label: "help" }];
    case "palette":
      return [{ id: "overlay.palette", label: "command palette" }];
    case "inspect":
      return [{ id: "overlay.inspect", label: "inspector" }];
    case "confirm":
      return [{ id: "overlay.confirm", label: "confirmation" }];
    case "controls":
      return [{ id: "overlay.controls", label: "controls" }];
    case "workspace":
      return [{ id: "overlay.workspace", label: "workspace set" }];
    case "session-nav":
      return [{ id: "overlay.session-nav", label: "session navigation" }];
    case "task-intelligence":
      return [{ id: "overlay.task-intelligence", label: "task intelligence" }];
    case "artifact":
      return [{ id: "overlay.artifact", label: "artifact viewer" }];
    case "changes":
      return [{ id: "overlay.changes", label: "changes dashboard" }];
    case "none":
      return FRAME_REGIONS;
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
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
  /** Live prompt from the application port. */
  readonly pendingConfirmation: ConfirmationPrompt | null;
  /** What the sheet is bound to. Stale when this and pending disagree. */
  readonly boundConfirmation: ConfirmationPrompt | null;
  readonly secretGraphemes: number;
  /** Last decided identity, so the same prompt is not re-offered. */
  readonly resolvedConfirmationKey: string | null;
  readonly selectedSessionId: string | null;
  readonly selectedModelId: string | null;
  /** Bound workspace roots for this session, or empty when none are attached. */
  readonly workspace: WorkspaceSetView;
  /** True while a mid-turn in-flight attempt is attached (#612). */
  readonly runningWork: boolean;
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
  | { readonly kind: "workspace-draft"; readonly draft: string }
  | { readonly kind: "session-nav-draft"; readonly draft: string }
  | { readonly kind: "session-nav-session"; readonly sessionId: string }
  | { readonly kind: "task-intelligence-draft"; readonly draft: string }
  | { readonly kind: "workspace-set"; readonly workspace: WorkspaceSetView }
  | { readonly kind: "running-work"; readonly running: boolean }
  | { readonly kind: "offer-confirmation"; readonly prompt: ConfirmationPrompt }
  | { readonly kind: "withdraw-confirmation" }
  | { readonly kind: "resolve-confirmation"; readonly decision: "accepted" | "refused" }
  | { readonly kind: "secret-mask"; readonly graphemes: number }
  | { readonly kind: "select-control"; readonly field: "session" | "model"; readonly id: string }
  | { readonly kind: "artifact-toggle-layout" }
  | { readonly kind: "artifact-next-hunk" }
  | { readonly kind: "artifact-previous-hunk" }
  | { readonly kind: "changes-tab"; readonly delta: 1 | -1 }
  | { readonly kind: "changes-cursor"; readonly delta: 1 | -1 }
  | { readonly kind: "changes-pending"; readonly pending: "create-checkpoint" | "restore" }
  | { readonly kind: "changes-settled"; readonly notice: string }
  | { readonly kind: "exit" };

export const INITIAL_SHELL_STATE: ShellState = {
  overlay: { kind: "none" },
  focus: createFocusModel(FRAME_REGIONS),
  notice: null,
  exiting: false,
  transcript: INITIAL_TRANSCRIPT_STATE,
  transcriptFacts: NO_TRANSCRIPT,
  composer: INITIAL_COMPOSER_STATE,
  pendingConfirmation: null,
  boundConfirmation: null,
  secretGraphemes: 0,
  resolvedConfirmationKey: null,
  selectedSessionId: null,
  selectedModelId: null,
  workspace: EMPTY_WORKSPACE_SET,
  runningWork: false,
};

function confirmRoute(prompt: ConfirmationPrompt): OverlayRoute {
  return { kind: "confirm", id: prompt.id };
}

function noticeFor(decision: "accepted" | "refused"): string {
  switch (decision) {
    case "accepted":
      return "Accepted.";
    case "refused":
      return "Declined.";
    default: {
      const exhaustive: never = decision;
      return exhaustive;
    }
  }
}

function clearConfirmation(state: ShellState, notice: string | null): ShellState {
  const resolved =
    state.boundConfirmation === null
      ? state.resolvedConfirmationKey
      : resolvedConfirmationKey(state.boundConfirmation);
  return {
    ...state,
    overlay: { kind: "none" },
    focus: releaseFocus(state.focus, FRAME_REGIONS),
    notice,
    pendingConfirmation: null,
    boundConfirmation: null,
    secretGraphemes: 0,
    resolvedConfirmationKey: resolved,
  };
}

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
      if (state.overlay.kind === "none") {
        return state;
      }
      if (state.overlay.kind !== "confirm" && state.boundConfirmation !== null) {
        const route = confirmRoute(state.boundConfirmation);
        return {
          ...state,
          overlay: route,
          focus: containFocus(state.focus, overlayRegions(route)),
          notice: null,
        };
      }
      return clearConfirmation(state, state.overlay.kind === "confirm" ? "Declined." : null);
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
    case "workspace-draft":
      if (state.overlay.kind !== "workspace" || action.draft === state.overlay.draft) {
        return state;
      }
      return {
        ...state,
        overlay: { ...state.overlay, draft: action.draft },
      };
    case "session-nav-draft":
      if (state.overlay.kind !== "session-nav" || action.draft === state.overlay.draft) {
        return state;
      }
      return {
        ...state,
        overlay: { ...state.overlay, draft: action.draft },
      };
    case "session-nav-session":
      if (state.overlay.kind !== "session-nav" || action.sessionId === state.overlay.sessionId) {
        return state;
      }
      return {
        ...state,
        overlay: { ...state.overlay, sessionId: action.sessionId },
      };
    case "task-intelligence-draft":
      if (state.overlay.kind !== "task-intelligence" || action.draft === state.overlay.draft) {
        return state;
      }
      return {
        ...state,
        overlay: { ...state.overlay, draft: action.draft },
      };
    case "workspace-set":
      return state.workspace === action.workspace
        ? state
        : { ...state, workspace: action.workspace };
    case "running-work":
      return state.runningWork === action.running
        ? state
        : { ...state, runningWork: action.running };
    case "composer": {
      const composer = composerReducer(state.composer, action.action);
      return composer === state.composer ? state : { ...state, composer };
    }
    case "transcript-facts":
      return state.transcriptFacts.blocks === action.facts.blocks &&
        state.transcriptFacts.scrollable === action.facts.scrollable
        ? state
        : { ...state, transcriptFacts: action.facts };
    case "offer-confirmation": {
      if (state.resolvedConfirmationKey === resolvedConfirmationKey(action.prompt)) {
        return state;
      }
      const keepBound =
        state.boundConfirmation !== null &&
        state.overlay.kind === "confirm" &&
        confirmationIsStale(state.boundConfirmation, action.prompt);
      if (keepBound) {
        return { ...state, pendingConfirmation: action.prompt };
      }
      const steal =
        state.overlay.kind === "none" ||
        state.overlay.kind === "confirm" ||
        state.boundConfirmation === null;
      if (!steal) {
        return {
          ...state,
          pendingConfirmation: action.prompt,
          boundConfirmation: action.prompt,
        };
      }
      const route = confirmRoute(action.prompt);
      return {
        ...state,
        pendingConfirmation: action.prompt,
        boundConfirmation: action.prompt,
        overlay: route,
        focus: containFocus(state.focus, overlayRegions(route)),
        notice: null,
      };
    }
    case "withdraw-confirmation":
      if (state.pendingConfirmation === null && state.boundConfirmation === null) {
        return state;
      }
      return {
        ...clearConfirmation(state, null),
        resolvedConfirmationKey: state.resolvedConfirmationKey,
      };
    case "resolve-confirmation":
      if (state.boundConfirmation === null && state.pendingConfirmation === null) {
        return state;
      }
      return clearConfirmation(state, noticeFor(action.decision));
    case "secret-mask":
      return state.secretGraphemes === action.graphemes
        ? state
        : { ...state, secretGraphemes: action.graphemes };
    case "select-control": {
      const selected =
        action.field === "session"
          ? { ...state, selectedSessionId: action.id }
          : { ...state, selectedModelId: action.id };
      return selected.overlay.kind === "none"
        ? selected
        : shellReducer(selected, { kind: "close-overlay" });
    }
    case "artifact-toggle-layout":
      if (state.overlay.kind !== "artifact" || state.overlay.presentation !== "diff") {
        return state;
      }
      return {
        ...state,
        overlay: {
          ...state.overlay,
          layout: state.overlay.layout === "unified" ? "split" : "unified",
        },
      };
    case "artifact-next-hunk":
      if (state.overlay.kind !== "artifact" || state.overlay.presentation !== "diff") {
        return state;
      }
      return {
        ...state,
        overlay: { ...state.overlay, hunkIndex: state.overlay.hunkIndex + 1 },
      };
    case "artifact-previous-hunk":
      if (state.overlay.kind !== "artifact" || state.overlay.presentation !== "diff") {
        return state;
      }
      return {
        ...state,
        overlay: { ...state.overlay, hunkIndex: Math.max(0, state.overlay.hunkIndex - 1) },
      };
    case "changes-tab": {
      if (state.overlay.kind !== "changes") {
        return state;
      }
      const tabs = ["files", "worktrees", "checkpoints"] as const;
      const index = tabs.indexOf(state.overlay.tab);
      const next = tabs[(index + action.delta + tabs.length) % tabs.length];
      if (next === undefined) {
        return state;
      }
      return {
        ...state,
        overlay: { ...state.overlay, tab: next, cursor: 0, pending: "none" },
      };
    }
    case "changes-cursor":
      if (state.overlay.kind !== "changes") {
        return state;
      }
      return {
        ...state,
        overlay: {
          ...state.overlay,
          cursor: Math.max(0, state.overlay.cursor + action.delta),
        },
      };
    case "changes-pending":
      if (state.overlay.kind !== "changes" || state.overlay.pending !== "none") {
        return state;
      }
      return {
        ...state,
        overlay: { ...state.overlay, pending: action.pending },
      };
    case "changes-settled":
      if (state.overlay.kind !== "changes") {
        return state;
      }
      return {
        ...state,
        notice: action.notice,
        overlay: {
          ...state.overlay,
          pending: "none",
          generation: state.overlay.generation + 1,
        },
      };
    case "exit":
      return { ...state, exiting: true };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function commandStateFor(
  state: ShellState,
  blocks: readonly TranscriptBlock[] = [],
): CommandState {
  const selected = selectedBlock(state.transcript.selected, blocks);
  const bound = state.boundConfirmation;
  const stale = bound !== null && confirmationIsStale(bound, state.pendingConfirmation);
  return {
    ...EMPTY_COMMAND_STATE,
    overlayOpen: state.overlay.kind !== "none",
    hasTranscript: state.transcriptFacts.blocks > 0,
    hasScrollableContent: state.transcriptFacts.scrollable,
    hasComposer: state.focus.focused === COMPOSER_REGION,
    hasHeldPaste: state.composer.lastPaste?.verdict === "preview",
    hasAttachments: state.composer.attachments.length > 0,
    hasDraft: state.composer.text.trim().length > 0,
    hasEnhancement: state.composer.enhancement !== null,
    hasReadyEnhancement: state.composer.enhancement?.status === "ready",
    hasEnhancementFeedback: state.composer.lastEnhancement !== null,
    hasInspectableSelection: selected !== null && inspectBlock(selected) !== null,
    hasDiagnosticSelection: selected !== null && hasDiagnostics(selected),
    hasConfirmation: bound !== null || state.pendingConfirmation !== null,
    confirmationStale: stale,
    confirmationNeedsSecret:
      bound !== null && !stale && bound.secret !== null && state.secretGraphemes === 0,
    hasOpenableArtifact: openableArtifact(selected),
    hasDiffArtifactOverlay:
      state.overlay.kind === "artifact" && state.overlay.presentation === "diff",
    diffArtifactHunkIndex:
      state.overlay.kind === "artifact" && state.overlay.presentation === "diff"
        ? state.overlay.hunkIndex
        : 0,
    hasChangesOverlay: state.overlay.kind === "changes",
    changesTab: state.overlay.kind === "changes" ? state.overlay.tab : null,
    hasWorkspaceSet: state.workspace.roots.length > 0,
    hasRemovableWorkspaceRoot: state.workspace.roots.length > 1,
    hasSessionNavigation: false,
    hasRunningWork: state.runningWork,
  };
}

function openableArtifact(block: TranscriptBlock | null): boolean {
  if (block === null || !blockOffersOpenArtifact(block)) {
    return false;
  }
  if (artifactPresentationFor(block) === null) {
    return false;
  }
  return primaryArtifactId(block) !== null;
}

function selectedBlock(
  key: string | null,
  blocks: readonly TranscriptBlock[],
): TranscriptBlock | null {
  if (key === null) {
    return null;
  }
  return blocks.find((block) => blockKey(block.anchor) === key) ?? null;
}

export function activeContexts(state: ShellState): readonly CommandContext[] {
  const commandState = commandStateFor(state);
  if (commandState.hasConfirmation) {
    return commandState.overlayOpen
      ? ["global", "overlay", "confirmation"]
      : ["global", "confirmation"];
  }
  if (commandState.overlayOpen) {
    return ["global", "overlay"];
  }
  return COMMAND_CONTEXTS.filter((context) => isContextActive(context, commandState));
}
