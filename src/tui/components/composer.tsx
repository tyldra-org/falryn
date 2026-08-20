/**
 * `ComposerView` — the composer, on a terminal.
 *
 * The draft is `TextareaRenderable`, through the `<textarea>` element
 * `@opentui/react` exposes. It owns the buffer, the cursor, the selection, the
 * scrolling, and every motion over them; this component supplies the frame
 * around it, the two chrome rows, and the rules that are genuinely Falryn's.
 *
 * ## Why it is the library's renderable and not a hand-built field
 *
 * It was hand-built until #399, and the cursor was drawn in the wrong cell on a
 * real terminal — a row above the draft and a cell short of the text. The cause
 * was not an off-by-one to correct in place. This component drew its own rows
 * and then *re-derived* where the cursor belonged, from a box origin, a
 * display-width sum, and a window offset; the renderable already knew, because
 * it had drawn the text.
 *
 * The specific failure is worth recording because it explains why every check
 * passed. `setCursorPosition` is **one-based** — writing zero clamps to one —
 * and the placement wrote `screenX + cell` and `screenY + row`, which are the
 * renderable's **zero-based** coordinates. So the cursor sat exactly one row up
 * and one cell left. The frame checks compared *differences* between two cursor
 * positions, where a constant offset cancels; the one absolute check compared
 * the cursor against the same zero-based row the code had used. Both sides
 * shared the assumption, so they agreed with each other and not with the
 * terminal.
 *
 * Nothing here computes a screen coordinate now. The cursor is the renderable's
 * and the terminal is told about it by the thing that drew the text.
 *
 * ## What is still Falryn's
 *
 * History recall, and only that. `up` and `down` inside a draft move a line —
 * the textarea's own `move-up`/`move-down` — and at the draft's edges they
 * recall a submission, which no `TextareaAction` expresses. It is done through
 * `onKeyDown`, which a focused renderable runs *before* its own key handling
 * and honours `preventDefault()` from: at an edge the event is claimed and the
 * history action dispatched, and anywhere else it is left alone. Falryn adds a
 * rule and reimplements no motion.
 *
 * Paste is Falryn's too, for one reason: a large paste is classified, bounded,
 * and described rather than inserted. The classification runs first and the
 * text reaches the buffer through `insertText` only when it is inline.
 *
 * ## Why the region is bounded
 *
 * The composer does not dominate the screen when idle, which the design
 * direction states and a growing region would break: a draft the length of a
 * file would push the transcript off the top. `../layout.ts` owns that number,
 * because the transcript sizes its own window from what is left over and the two
 * have to agree exactly.
 */

import type {
  KeyBinding,
  KeyEvent,
  MouseEvent,
  PasteEvent,
  TextareaRenderable,
} from "@opentui/core";
import { defaultTextareaKeyBindings, MouseButton } from "@opentui/core";
import { usePaste, useSelectionHandler } from "@opentui/react";
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Instant } from "../../domain/index.ts";
import {
  type ClickSequence,
  type ComposerAction,
  type ComposerState,
  composerNotice,
  describeOutcome,
  transitionClickSequence,
} from "../composer/index.ts";
import type { ComposerModel } from "../composer-model.ts";
import { primaryColumns } from "../layout.ts";
import { classifyPaste } from "../paste.ts";
import type { StatusToken } from "../theme/index.ts";
import { useFrame, useLayoutClass, useTheme } from "./context.tsx";
import { Line, StatusMark } from "./primitives.tsx";

export type ComposerViewProps = {
  readonly model: ComposerModel;
  /**
   * Where the draft's changes go.
   *
   * Optional, because a frame rendered from a value alone has nothing to type
   * into and every check in `./frame.test.tsx` renders one. When it is absent
   * the textarea is left unfocused and reports nothing.
   */
  readonly onAction?: (action: ComposerAction) => void;
  /**
   * Focuses the composer, through the shell's own focus model.
   *
   * Separate from {@link onAction} because focus is not the composer's to own:
   * it belongs to the region model that decides which control keys reach.
   */
  readonly onFocus?: () => void;
  /**
   * The composed invocation clock, reduced to the only capability this view
   * needs. Static frames omit it and retain native single-press/drag behavior.
   */
  readonly now?: () => Instant;
};

export function ComposerView(props: ComposerViewProps): ReactNode {
  const frame = useFrame();
  const layoutClass = useLayoutClass();
  const theme = useTheme();
  const columns = primaryColumns(frame.viewport, layoutClass);
  const { model, now, onAction, onFocus } = props;
  const draft = useRef<TextareaRenderable | null>(null);
  // Press recognition is transient interaction state, not view state: it must
  // not schedule a redraw or store an OpenTUI event beyond its callback.
  const clickSequence = useRef<ClickSequence | null>(null);
  // How far the renderable has scrolled, so the chrome can still say how many
  // rows are above the view. Component state rather than the shell's: a scroll
  // offset is a fact about what is on screen, not about the session, and the
  // ownership boundary puts it here.
  const [hidden, setHidden] = useState(0);
  // Whether the renderable has a non-empty range. Falryn needs this only to
  // state the accessibility alternative; the range itself remains entirely
  // inside `TextareaRenderable`.
  const [selectionActive, setSelectionActive] = useState(false);
  const selectionBg = theme.color("selection");
  const selectionFg = theme.color("foreground");

  const refreshRenderedState = useCallback((renderable: TextareaRenderable): void => {
    setHidden(renderable.scrollY);
    setSelectionActive(renderable.getSelection() !== null);
  }, []);

  // A pointer drag changes the textarea's native range without changing its
  // content or cursor. OpenTUI reports that completed selection through this
  // renderer hook; Falryn reads only the existing renderable so the range still
  // has one owner and the chrome remains a view of it.
  useSelectionHandler(
    useCallback((): void => {
      const renderable = draft.current;
      if (renderable !== null) {
        refreshRenderedState(renderable);
      }
    }, [refreshRenderedState]),
  );

  // The draft is the renderable's, and this is the one direction Falryn writes
  // it: a history recall replaces the whole text. Typing never comes back
  // through here — `onContentChange` reports it and the state follows.
  //
  // Guarded on the text actually differing, because `setText` moves the cursor
  // to the end: applying it on every render would drag the cursor there after
  // each keystroke, which is the same class of defect as placing it by hand.
  //
  // `useLayoutEffect` so a mid-turn clear reaches the renderable before paint
  // and before a stale `onContentChange` echo can restore the buffer.
  useLayoutEffect(() => {
    const renderable = draft.current;
    if (renderable !== null && renderable.plainText !== model.state.text) {
      renderable.setText(model.state.text);
    }
  }, [model.state.text]);

  // Paste is classified before the renderable sees it, which is the one thing
  // Falryn must do first: a paste too large to inline is described rather than
  // inserted, and the renderable would insert it. `usePaste` runs ahead of
  // renderable handlers and `preventDefault()` stops them — so an inline paste
  // is simply let through and the renderable puts it in the buffer, and a
  // refused one is claimed here and reported.
  usePaste(
    useCallback(
      (event: PasteEvent): void => {
        if (onAction === undefined || !model.focused) {
          return;
        }
        // Decoded non-fatally on purpose: invalid UTF-8 becomes replacement
        // characters rather than a throw, and the classification then refuses
        // the result for what it is. A decoder that threw would take the render
        // down over a bad clipboard.
        const text = new TextDecoder().decode(event.bytes);
        if (classifyPaste(text).verdict !== "inline") {
          event.preventDefault();
        }
        onAction({ kind: "paste", text });
      },
      [model.focused, onAction],
    ),
  );

  const keyDown = useCallback(
    (key: KeyEvent): void => {
      if (onAction === undefined) {
        return;
      }
      const renderable = draft.current;
      if (renderable === null || (key.name !== "up" && key.name !== "down")) {
        return;
      }
      const { row, lastRow } = edgeOf(renderable);
      const atEdge = key.name === "up" ? row === 0 : row === lastRow;
      if (!atEdge || key.shift === true) {
        return;
      }
      key.preventDefault();
      onAction({ kind: key.name === "up" ? "history-previous" : "history-next" });
    },
    [onAction],
  );

  const mouseDown = useCallback(
    (event: MouseEvent): void => {
      // The focus model owns focus. OpenTUI has already applied this press to
      // the textarea before the callback runs, so the first count preserves
      // native collapsed placement and later counts compose native motions.
      onFocus?.();
      if (now === undefined) {
        return;
      }

      const transition = transitionClickSequence(
        clickSequence.current,
        {
          kind: "press",
          button: event.button === MouseButton.LEFT ? "primary" : "other",
          cell: { x: event.x, y: event.y },
        },
        now(),
      );
      clickSequence.current = transition.sequence;

      const renderable = draft.current;
      if (renderable === null) {
        return;
      }
      switch (transition.count) {
        case 1:
        case null:
          return;
        case 2:
          renderable.moveCursorRight();
          renderable.moveWordBackward();
          renderable.moveWordForward({ select: true });
          break;
        case 3:
          // A native click leaves a collapsed anchor at the clicked offset.
          // Clear it before composing the complete logical line.
          renderable.clearSelection();
          renderable.gotoLineStart();
          renderable.gotoLineEnd({ select: true });
          break;
      }
      refreshRenderedState(renderable);
    },
    [now, onFocus, refreshRenderedState],
  );

  const mouseDrag = useCallback((): void => {
    // Drag placement, selection, and auto-scroll are all OpenTUI behavior.
    // Falryn only ensures a later press begins a new repeated-press sequence.
    clickSequence.current = null;
  }, []);

  return (
    <box flexDirection="column" width={columns} height={frame.composerRows}>
      <textarea
        ref={draft}
        focused={model.focused && onAction !== undefined}
        width={columns}
        height={Math.max(1, frame.composerRows - CHROME_ROWS)}
        wrapMode="word"
        keyBindings={[...COMPOSER_KEY_BINDINGS]}
        {...(selectionBg === null ? {} : { selectionBg })}
        {...(selectionFg === null ? {} : { selectionFg })}
        {...(onFocus === undefined && now === undefined ? {} : { onMouseDown: mouseDown })}
        {...(now === undefined ? {} : { onMouseDrag: mouseDrag })}
        onContentChange={() => {
          const renderable = draft.current;
          if (renderable !== null) {
            refreshRenderedState(renderable);
            onAction?.({ kind: "draft", text: renderable.plainText });
          }
        }}
        onCursorChange={() => {
          const renderable = draft.current;
          if (renderable !== null) {
            refreshRenderedState(renderable);
          }
        }}
        onKeyDown={keyDown}
        onSubmit={() => onAction?.({ kind: "submit" })}
      />
      <ComposerStatus
        model={model}
        hidden={hidden}
        selectionActive={selectionActive}
        maxColumns={columns}
      />
    </box>
  );
}

/** The chrome the composer always draws, which `../layout.ts` reserves for it. */
const CHROME_ROWS = 2;

const REPLACED = new Set(["home", "end"]);

function keyOf(binding: KeyBinding): string {
  return `${binding.ctrl === true ? "ctrl+" : ""}${binding.name}`;
}

const COMPOSER_KEY_BINDINGS: readonly KeyBinding[] = [
  ...defaultTextareaKeyBindings.filter((binding) => !REPLACED.has(keyOf(binding))),
  { name: "return", shift: true, action: "newline" },
  { name: "home", action: "line-home" },
  { name: "end", action: "line-end" },
  { name: "home", shift: true, action: "select-line-home" },
  { name: "end", shift: true, action: "select-line-end" },
  { name: "home", ctrl: true, action: "buffer-home" },
  { name: "end", ctrl: true, action: "buffer-end" },
  { name: "home", ctrl: true, shift: true, action: "select-buffer-home" },
  { name: "end", ctrl: true, shift: true, action: "select-buffer-end" },
];

function edgeOf(renderable: TextareaRenderable): {
  readonly row: number;
  readonly lastRow: number;
} {
  return { row: renderable.logicalCursor.row, lastRow: Math.max(0, renderable.lineCount - 1) };
}

/**
 * The composer's two chrome rows.
 *
 * Exactly two, always, because `composerRows` reserved exactly two — see
 * `../layout.ts` for why a row that came and went would re-lay-out every region
 * above it. The first says what the composer is doing and which keys act on it;
 * the second reports the last submission, or the declared gaps when there is
 * nothing to report.
 *
 * Both are words rather than a colour or a border. Focus is stated in the first
 * row for the same reason: a border would be the natural indicator and it would
 * also make the region two rows taller when focused, which is the one thing the
 * height contract forbids.
 */
function ComposerStatus(props: {
  readonly model: ComposerModel;
  readonly hidden: number;
  readonly selectionActive: boolean;
  readonly maxColumns: number;
}): ReactNode {
  const { model } = props;
  const { state } = model;

  const parts: string[] = [phraseFor(state)];
  if (model.focused) {
    parts.push("focused");
  }
  if (props.selectionActive) {
    parts.push("Selection active");
  }
  if (props.hidden > 0) {
    parts.push(`${props.hidden} more ${props.hidden === 1 ? "line" : "lines"} above`);
  }
  for (const id of ["composer.submit", "composer.newline"]) {
    const row = model.commands.find((entry) => entry.id === id);
    if (row?.binding != null && row.unavailableReason === null) {
      parts.push(`${row.binding} ${id === "composer.submit" ? "sends" : "adds a line"}`);
    }
  }

  return (
    <box flexDirection="column">
      <StatusMark
        status={statusFor(state)}
        label={parts.join(" · ")}
        maxColumns={props.maxColumns}
      />
      <SecondRow model={model} maxColumns={props.maxColumns} />
    </box>
  );
}

/**
 * The outcome of the last submission, or what the composer does not do yet.
 *
 * One row either way. The outcome wins when there is one, because "your prompt
 * was not sent and your draft is still here" is the more urgent of the two and
 * the gaps are a fact about the build that will still be true next frame.
 */
function SecondRow(props: {
  readonly model: ComposerModel;
  readonly maxColumns: number;
}): ReactNode {
  const outcome = props.model.state.lastOutcome;
  if (outcome !== null) {
    return (
      <StatusMark
        status={outcome.kind === "accepted" ? "success" : "uncertain"}
        label={describeOutcome(outcome)}
        maxColumns={props.maxColumns}
      />
    );
  }

  const notice = composerNotice(props.model.state);
  if (notice !== null) {
    return <StatusMark status="uncertain" label={notice} maxColumns={props.maxColumns} />;
  }

  const { features } = props.model;
  const summary =
    features.length === 0
      ? "Type a prompt."
      : `Not here yet: ${features.map((feature) => feature.title.toLowerCase()).join(", ")}.`;
  return (
    <Line color="mutedForeground" typography="muted" maxColumns={props.maxColumns}>
      {summary}
    </Line>
  );
}

/** The phase as a sentence a reader can act on, never as a bare token. */
function phraseFor(state: ComposerState): string {
  switch (state.phase) {
    case "editing":
      return state.text === "" ? "Ready" : "Editing";
    case "recalling":
      return "Recalled from history";
    case "sending":
      return "Sending";
    case "queued":
      return "Queued";
    case "cancelled":
      return "Cancelled";
    case "disabled":
      return "Disabled";
  }
}

/** The status token a phase wears. One mapping, so nothing disagrees about it. */
function statusFor(state: ComposerState): StatusToken {
  switch (state.phase) {
    case "editing":
    case "recalling":
      return "informational";
    case "sending":
    case "queued":
      return "pending";
    case "cancelled":
      return "cancelled";
    case "disabled":
      return "uncertain";
  }
}
