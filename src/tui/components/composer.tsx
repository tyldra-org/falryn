/**
 * `ComposerView` — the composer, on a terminal.
 *
 * Everything this component *decides* was decided somewhere else: the text and
 * the cursor come from `../composer/editor.ts`, the phase from
 * `../composer/state.ts`, and what is missing from `../composer/features.ts`.
 * What is left here is measurement and mounting, which is the part that
 * genuinely needs a renderer.
 *
 * ## Why the cursor is the terminal's own
 *
 * It draws no caret. This component used to splice a glyph into the line at the
 * cursor's column, which made the drawn line one grapheme longer than the buffer
 * line and displaced every character after it — #386, visible as `hello wo▏rld`
 * and invisible at the end of a draft, which is why it shipped. A drawn line
 * that is not the buffer line is also a line whose width is wrong exactly while
 * the cursor is on it, and a frame in which typed text cannot be asserted.
 *
 * So the cursor is placed rather than drawn. Three objections were recorded
 * against that when the caret was chosen, and each has an answer against the
 * installed renderer rather than in principle:
 *
 * - the line primitive styles a whole line rather than a cell — which is only a
 *   problem for a *reversed cell*, and the terminal's own cursor is neither a
 *   cell nor a style;
 * - placing a real cursor needs absolute screen coordinates a flex layout only
 *   knows after it has run — `Renderable` exposes `screenX` and `screenY` in the
 *   renderer's own buffer space, which is the space `setCursorPosition` takes;
 * - a glyph survives a frame capture, which is what makes "the cursor moved" an
 *   assertion rather than a screenshot — and `captureSpans()` reports
 *   `cursor: [x, y]` from the same state `setCursorPosition` writes, so the
 *   assertion moves to the coordinate instead of disappearing.
 *
 * The column is a *cell* offset, not a grapheme count, and this component no
 * longer computes it. `../composer/geometry.ts` owns that mapping in both
 * directions — #391 — because the pointer needs the same arithmetic run
 * backwards, and two functions computing one relationship disagree eventually.
 * What is left here is handing it the drawn lines and the position.
 *
 * ## Why the region is bounded
 *
 * The composer does not dominate the screen when idle, which the design
 * direction states and a growing region would break: a draft the length of a
 * file would push the transcript off the top. It shows the lines around the
 * cursor up to `COMPOSER_MAX_TEXT_ROWS` and says how many it is not showing,
 * rather than growing or silently clipping. `../layout.ts` owns that number,
 * because the transcript sizes its own window from what is left over and the two
 * have to agree exactly.
 */

import type { BoxRenderable, KeyEvent, MouseEvent } from "@opentui/core";
import { LayoutEvents, MouseButton } from "@opentui/core";
import { useKeyboard, usePaste, useRenderer } from "@opentui/react";
import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { graphemes } from "../../domain/index.ts";
import {
  type ComposerAction,
  type ComposerState,
  cellOfPosition,
  cursorPosition,
  type DrawnLine,
  describeOutcome,
  type EditorAction,
  linesOf,
  positionOfCell,
  selectionOf,
} from "../composer/index.ts";
import type { ComposerModel } from "../composer-model.ts";
import { COMPOSER_MAX_TEXT_ROWS, primaryColumns } from "../layout.ts";
import type { StatusToken } from "../theme/index.ts";
import { useFrame, useLayoutClass } from "./context.tsx";
import { Line, StatusMark } from "./primitives.tsx";

export type ComposerViewProps = {
  readonly model: ComposerModel;
  /**
   * Where typing goes.
   *
   * Optional, because a frame rendered from a value alone has nothing to type
   * into and every test in `./frame.test.tsx` renders one. When it is absent no
   * keyboard subscription is made at all, so a static frame costs nothing.
   */
  readonly onAction?: (action: ComposerAction) => void;
  /**
   * Focuses the composer, through the shell's own focus model.
   *
   * Separate from {@link onAction} because focus is not the composer's to own:
   * it belongs to the region model that decides which control keys reach. A
   * click needs both — #386 draws the cursor only while the composer has focus,
   * so a click that placed one into an unfocused composer would leave no mark
   * and send the next keystroke somewhere else.
   */
  readonly onFocus?: () => void;
};

export function ComposerView(props: ComposerViewProps): ReactNode {
  useComposerInput(props.model, props.onAction);
  const frame = useFrame();
  const layoutClass = useLayoutClass();
  const columns = primaryColumns(frame.viewport, layoutClass);
  const { model } = props;

  const window = visibleLines(model.state);
  const box = useRef<BoxRenderable | null>(null);
  const at = cursorPosition(model.state.editor);
  useCursorPlacement({
    box,
    // Where the cursor's line sits among the drawn ones. The window is anchored
    // to the cursor, so this is never negative — but the drawn rows are what the
    // coordinate is relative to, not the draft's own line numbers.
    row: at.line - window.hidden,
    cell: cellOfPosition(window.lines, at) ?? 0,
    columns,
    focused: model.focused,
  });

  const { onAction, onFocus } = props;
  const click = (event: MouseEvent): void => {
    const renderable = box.current;
    if (renderable === null || event.button !== MouseButton.LEFT) {
      return;
    }
    // The mapping #391 delivered, in the space the event already arrives in:
    // `MouseEvent.x`/`y` and `screenX`/`screenY` are both the renderer's own
    // buffer coordinates, so there is no translation between them to get wrong.
    const at = positionOfCell(
      { lines: window.lines, originColumn: renderable.screenX, originRow: renderable.screenY },
      { column: event.x, row: event.y },
    );
    if (at === null) {
      return;
    }
    // Focus first: placing a cursor into a composer that does not have focus
    // draws nothing and takes no keys.
    onFocus?.();
    onAction?.({ kind: "edit", action: { kind: "place", at } });
  };

  return (
    // The rule below is about DOM elements taking a pointer handler without a
    // role a screen reader can announce. A terminal has neither a role system
    // nor a screen-reader surface, and the concern the rule stands in for — a
    // pointer must not be the only way to reach something — is held directly
    // here: this handler duplicates a position the arrow keys already reach, and
    // every command stays reachable from the keyboard.
    // biome-ignore lint/a11y/noStaticElementInteractions: no roles in a terminal, and the keyboard route is complete
    <box
      ref={box}
      flexDirection="column"
      width={columns}
      height={frame.composerRows}
      onMouseDown={click}
    >
      {window.lines.map((line) => (
        // Keyed by the line's position in the document rather than by its offset
        // in the window, so a key stays with its line while the window scrolls.
        <Line
          key={`composer-line-${line.number}`}
          color="foreground"
          typography="body"
          maxColumns={columns}
          untrusted
        >
          {line.text}
        </Line>
      ))}
      <ComposerStatus model={model} hidden={window.hidden} maxColumns={columns} />
    </box>
  );
}

/**
 * Keys and pastes, while the composer has focus.
 *
 * Everything a binding claims never arrives here — the keymap resolves a bound
 * key and dispatches before any subscriber sees it, which was measured rather
 * than assumed. So this handles exactly what is left: characters, the deletions,
 * and the horizontal and document movements that have no command of their own.
 *
 * Nothing is handled while the composer is unfocused. A background control that
 * consumed keys would be the "background regions do not consume keys intended
 * for the focused control" rule broken in the one place it is easiest to break.
 */
function useComposerInput(
  model: ComposerModel,
  onAction: ((action: ComposerAction) => void) | undefined,
): void {
  const active = model.focused && onAction !== undefined;

  useKeyboard((key) => {
    if (!active || onAction === undefined) {
      return;
    }
    const edit = editFor(key);
    if (edit !== null) {
      onAction({ kind: "edit", action: edit });
    }
  });

  usePaste((event) => {
    if (!active || onAction === undefined) {
      return;
    }
    // Decoded here because the event carries bytes, and decoded non-fatally on
    // purpose: invalid UTF-8 becomes replacement characters rather than a throw,
    // and the classification then refuses the result for what it is. A decoder
    // that threw would take the render down over a bad clipboard.
    const text = new TextDecoder().decode(event.bytes);
    // Through the composer's state machine, which routes it to the
    // classification. A component that inserted the text itself would be the
    // path that floods a terminal with a pasted file.
    onAction({ kind: "paste", text });
  });
}

/**
 * The edit a key means, or `null` when it means nothing here.
 *
 * `null` rather than a no-op action, so a key the composer has no use for is
 * left alone entirely instead of producing a state transition that returns
 * identity.
 */
function editFor(key: KeyEvent): EditorAction | null {
  const extend = key.shift === true;

  switch (key.name) {
    case "backspace":
      return { kind: "delete-backward" };
    case "delete":
      return { kind: "delete-forward" };
    case "left":
      return { kind: "move", motion: "left", extend };
    case "right":
      return { kind: "move", motion: "right", extend };
    case "home":
      return { kind: "move", motion: "line-start", extend };
    case "end":
      return { kind: "move", motion: "line-end", extend };
    default:
      break;
  }

  if (key.ctrl === true && key.name === "a") {
    return { kind: "select-all" };
  }
  // A modifier means a chord, and a chord that reached here is one nothing
  // bound — inserting its letter would type `p` for an unregistered `alt+p`.
  if (key.ctrl === true || key.meta === true) {
    return null;
  }
  // One character with no modifier is text, whatever character it is. Measured
  // by grapheme rather than by `length`, so an astral character is one insert
  // and not a pair of halves.
  const sequence = key.sequence;
  if (sequence !== "" && graphemes(sequence).length === 1 && sequence >= " ") {
    return { kind: "insert", text: sequence };
  }
  return null;
}

/**
 * The drawn lines, and how many the window starts past.
 *
 * The line shape is `DrawnLine` from `../composer/geometry.ts` rather than a
 * local one: the mapping between a draft position and a screen cell is owned
 * there, and it takes these lines. Two shapes for one thing is how the two
 * directions of that mapping would drift apart.
 */
type Window = {
  readonly lines: readonly DrawnLine[];
  readonly hidden: number;
};

/**
 * The lines around the cursor, exactly as the draft holds them.
 *
 * The window is anchored to the cursor rather than to the start, because the
 * line being typed is the one that has to stay visible — a composer that showed
 * the first six lines of a long draft would hide the text as it was written.
 */
function visibleLines(state: ComposerState): Window {
  const lines = linesOf(state.editor);
  const at = cursorPosition(state.editor);
  // Anchored so the cursor's line is the last one shown, clamped at both ends.
  const start = Math.max(0, Math.min(at.line - COMPOSER_MAX_TEXT_ROWS + 1, lines.length - 1));
  const shown: DrawnLine[] = [];
  for (let line = start; line < lines.length && shown.length < COMPOSER_MAX_TEXT_ROWS; line += 1) {
    shown.push({ number: line, text: lines[line] ?? "" });
  }

  return { lines: shown, hidden: start };
}

/**
 * Puts the terminal's own cursor where the next character will go.
 *
 * The hook shape `./overlay-room.tsx` established: hold the renderer, write on
 * change, undo on unmount, and check `isDestroyed` first — that guard is not
 * defensive habit, it is that unmount can run *after* the session destroyed the
 * renderer, and reaching released native state throws where nothing catches it.
 *
 * ## Why it subscribes to layout rather than only to a render
 *
 * A `useEffect` runs after React commits, and Yoga runs its layout inside the
 * renderer's own pass. So the first effect after mount can read a `screenY` that
 * layout has not produced yet, and the cursor would be placed a frame late —
 * which looks correct the moment anything else redraws, and is therefore the
 * kind of defect that survives review. `LAYOUT_CHANGED` on the composer's own
 * renderable is when the coordinate becomes true, and the check for this asserts
 * the cursor on the *first settled frame* rather than after a keystroke, so a
 * placement that is one frame behind fails rather than passing on the second.
 *
 * ## Why the column clamps
 *
 * `Line` truncates at `maxColumns` and the composer does not scroll
 * horizontally, so a cursor past the truncation point has no cell of its own. It
 * clamps to the last drawn one: a cursor placed outside the composer's box lands
 * on a cell belonging to another region, which is a worse defect than the one
 * this replaced.
 */
function useCursorPlacement(options: {
  readonly box: RefObject<BoxRenderable | null>;
  readonly row: number;
  readonly cell: number;
  readonly columns: number;
  readonly focused: boolean;
}): void {
  const renderer = useRenderer();
  const { box, row, cell, columns, focused } = options;

  useEffect(() => {
    const renderable = box.current;
    if (renderable === null) {
      return;
    }

    const place = (): void => {
      if (renderer.isDestroyed) {
        return;
      }
      renderer.setCursorPosition(
        renderable.screenX + Math.min(cell, Math.max(0, columns - 1)),
        renderable.screenY + row,
        focused,
      );
    };

    place();
    renderable.on(LayoutEvents.LAYOUT_CHANGED, place);
    return () => {
      renderable.off(LayoutEvents.LAYOUT_CHANGED, place);
    };
  }, [renderer, box, row, cell, columns, focused]);

  useEffect(() => {
    // Hidden on the way out, and only on the way out — a cleanup that ran on
    // every dependency change would hide the cursor between two placements of
    // it. The shell's own teardown restores cursor visibility through
    // `destroy()` as well; this is for the case where the composer goes away
    // while the renderer stays.
    return () => {
      if (!renderer.isDestroyed) {
        const state = renderer.getCursorState();
        renderer.setCursorPosition(state.x, state.y, false);
      }
    };
  }, [renderer]);
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
  readonly maxColumns: number;
}): ReactNode {
  const { model } = props;
  const { state } = model;

  const parts: string[] = [phraseFor(state)];
  if (model.focused) {
    parts.push("focused");
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
      return state.editor.text === "" ? "Ready" : "Editing";
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

/** Whether anything is selected, for a caller deciding what a copy would take. */
export function hasSelection(state: ComposerState): boolean {
  return selectionOf(state.editor) !== null;
}
