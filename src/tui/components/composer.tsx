/**
 * `ComposerView` — the composer, on a terminal.
 *
 * Everything this component *decides* was decided somewhere else: the text and
 * the cursor come from `../composer/editor.ts`, the phase from
 * `../composer/state.ts`, and what is missing from `../composer/features.ts`.
 * What is left here is measurement and mounting, which is the part that
 * genuinely needs a renderer.
 *
 * ## Why the caret is a character
 *
 * A terminal cursor is the natural way to show where typing goes, and OpenTUI
 * can place one. It is not what this draws, for two reasons. The line primitive
 * styles a whole line rather than a cell, so a reversed cursor cell would need a
 * second styling owner; and placing the real cursor needs the composer's
 * absolute screen coordinates, which a flex layout only knows after it has run.
 * A caret glyph from the symbol set is a character, so it survives a monochrome
 * terminal, an ASCII repertoire, and a frame capture — the last of which is what
 * makes "the cursor moved" an assertion rather than a screenshot.
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

import type { KeyEvent } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";
import type { ReactNode } from "react";
import { graphemes } from "../../domain/index.ts";
import {
  type ComposerAction,
  type ComposerState,
  cursorPosition,
  describeOutcome,
  type EditorAction,
  linesOf,
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
};

export function ComposerView(props: ComposerViewProps): ReactNode {
  useComposerInput(props.model, props.onAction);
  const frame = useFrame();
  const layoutClass = useLayoutClass();
  const columns = primaryColumns(frame.viewport, layoutClass);
  const { model } = props;

  const window = visibleLines(model.state, frame.theme.symbols.caret);

  return (
    <box flexDirection="column" width={columns} height={frame.composerRows}>
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

/** One drawn line, carrying where in the draft it came from. */
type WindowLine = {
  /** Zero-based line number in the draft. The React key, and never the offset. */
  readonly number: number;
  readonly text: string;
};

type Window = {
  readonly lines: readonly WindowLine[];
  readonly hidden: number;
};

/**
 * The lines around the cursor, with the caret drawn into the one it is on.
 *
 * The window is anchored to the cursor rather than to the start, because the
 * line being typed is the one that has to stay visible — a composer that showed
 * the first six lines of a long draft would hide the text as it was written.
 */
function visibleLines(state: ComposerState, caret: string): Window {
  const lines = linesOf(state.editor);
  const at = cursorPosition(state.editor);
  // Anchored so the cursor's line is the last one shown, clamped at both ends.
  const start = Math.max(0, Math.min(at.line - COMPOSER_MAX_TEXT_ROWS + 1, lines.length - 1));
  const shown: WindowLine[] = [];
  for (let line = start; line < lines.length && shown.length < COMPOSER_MAX_TEXT_ROWS; line += 1) {
    const text = lines[line] ?? "";
    shown.push({ number: line, text: line === at.line ? withCaret(text, at.column, caret) : text });
  }

  return { lines: shown, hidden: start };
}

/**
 * A line with the caret placed before the character the cursor is on.
 *
 * Both halves are rebuilt from graphemes rather than cut at a code-unit index.
 * That is the same rule the editing model follows, and it is not pedantry here
 * either: the cursor's column is a grapheme offset that does not correspond to a
 * string index at all, and cutting at one would split a surrogate pair.
 */
function withCaret(line: string, column: number, caret: string): string {
  const units = graphemes(line);
  return `${units.slice(0, column).join("")}${caret}${units.slice(column).join("")}`;
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
