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

import type { KeyBinding, KeyEvent, PasteEvent, TextareaRenderable } from "@opentui/core";
import { defaultTextareaKeyBindings, SyntaxStyle } from "@opentui/core";
import { usePaste, useSelectionHandler } from "@opentui/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ComposerToken,
  MentionTrigger,
  TokenRange,
} from "../../domain/context/composer-mentions.ts";
import { useFrame, useLayoutClass, useTheme } from "../shell/context.tsx";
import { primaryColumns } from "../shell/layout.ts";
import type { StatusToken, Theme } from "../theme/index.ts";
import { Line, StatusMark } from "../visual/primitives.tsx";
import type { ComposerModel } from "./composer-model.ts";
import {
  type ComposerAction,
  type ComposerState,
  composerNotice,
  describeOutcome,
} from "./index.ts";
import { classifyPaste } from "./paste.ts";
import { suggestionListRows, suggestionWindow } from "./suggestions.ts";

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
};

export function ComposerView(props: ComposerViewProps): ReactNode {
  const frame = useFrame();
  const layoutClass = useLayoutClass();
  const theme = useTheme();
  const columns = primaryColumns(frame.viewport, layoutClass);
  const { model, onAction, onFocus } = props;
  const draft = useRef<TextareaRenderable | null>(null);
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
  const listRows = suggestionListRows(model.state.suggestions, columns);
  // One native style table per theme generation, released with it. Tokens are
  // coloured through it; without colour they are underlined, so a pick still reads
  // as one unit on a monochrome terminal.
  const mentionStyle = useMemo(() => mentionStyleFor(theme), [theme]);
  useEffect(() => () => mentionStyle.style.destroy(), [mentionStyle]);

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
  // Guarded on the text actually differing, because a replacement puts the cursor
  // at the end (`setText` alone leaves it at the start, so it is moved there):
  // applying it on every render would drag the cursor there after each keystroke,
  // which is the same class of defect as placing it by hand.
  //
  // `useLayoutEffect` so a mid-turn clear reaches the renderable before paint
  // and before a stale `onContentChange` echo can restore the buffer.
  useLayoutEffect(() => {
    const renderable = draft.current;
    if (renderable === null) return;
    if (renderable.syntaxStyle !== mentionStyle.style) renderable.syntaxStyle = mentionStyle.style;
    if (renderable.plainText !== model.state.text) {
      renderable.setText(model.state.text);
      placeTokens(renderable, model.state.tokens, mentionStyle);
      const caret = model.state.caret;
      if (caret === null) renderable.gotoBufferEnd();
      else renderable.cursorOffset = offsetOf(renderable, caret, model.state.text.length);
    } else if (!tokensPlaced(renderable, model.state.tokens, mentionStyle)) {
      // A token was demoted or rebound while the text stayed the same.
      placeTokens(renderable, model.state.tokens, mentionStyle);
    }
  }, [model.state.text, model.state.tokens, model.state.caret, mentionStyle]);

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

  // OpenTUI owns single-, double-, and triple-click selection. Falryn only
  // mirrors focus into its region model after the native press is applied.
  const mouseDown = useCallback((): void => {
    onFocus?.();
  }, [onFocus]);

  return (
    <box flexDirection="column" width={columns} height={frame.composerRows}>
      {listRows > 0 && model.state.suggestions !== null ? (
        <SuggestionList model={model} columns={columns} rows={listRows} />
      ) : null}
      <textarea
        ref={draft}
        focused={model.focused && onAction !== undefined}
        width={columns}
        height={Math.max(1, frame.composerRows - CHROME_ROWS - listRows)}
        wrapMode="word"
        keyBindings={[...COMPOSER_KEY_BINDINGS]}
        {...(selectionBg === null ? {} : { selectionBg })}
        {...(selectionFg === null ? {} : { selectionFg })}
        {...(onFocus === undefined ? {} : { onMouseDown: mouseDown })}
        onContentChange={() => {
          const renderable = draft.current;
          if (renderable !== null) {
            refreshRenderedState(renderable);
            onAction?.({
              kind: "draft",
              text: renderable.plainText,
              cursor: indexOf(renderable, renderable.cursorOffset),
              tokens: reportedRanges(renderable, mentionStyle),
            });
          }
        }}
        onCursorChange={() => {
          const renderable = draft.current;
          if (renderable !== null) {
            refreshRenderedState(renderable);
            onAction?.({ kind: "cursor", cursor: indexOf(renderable, renderable.cursorOffset) });
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

/**
 * The suggestion list, above the draft and inside the composer's reserved rows.
 *
 * Rows are data from a source; this draws them and nothing else. The selected row
 * is marked with a symbol as well as a colour, and unavailable rows state their
 * reason, so neither depends on colour to be read.
 */
function SuggestionList(props: {
  readonly model: ComposerModel;
  readonly columns: number;
  readonly rows: number;
}): ReactNode {
  const suggestions = props.model.state.suggestions;
  if (suggestions === null) return null;
  const window = suggestionWindow(suggestions, props.columns);
  const narrow = props.columns < 60;
  const selected = suggestions.rows[suggestions.selected];
  // Position and, when narrow, the selected row's source come first: they are what a
  // truncated line must keep.
  const hint = [
    `${Math.min(suggestions.selected + 1, suggestions.total)} of ${suggestions.total}`,
    ...(narrow && selected !== undefined ? [selected.detail] : []),
    "↑↓ move",
    "Tab or Return use",
    "Esc close",
  ].join(" · ");
  return (
    <box flexDirection="column" height={props.rows}>
      {window.rows.map((row, index) => {
        const isSelected = window.first + index === suggestions.selected;
        const detail =
          row.unavailable !== null
            ? `unavailable: ${row.unavailable.reason}`
            : narrow
              ? ""
              : row.detail;
        return (
          <Line
            key={row.id}
            color={
              row.unavailable !== null ? "mutedForeground" : isSelected ? "accent" : "foreground"
            }
            typography={isSelected ? "emphasis" : "body"}
            maxColumns={props.columns}
            untrusted
          >
            {`${isSelected ? "› " : "  "}${row.label}${detail === "" ? "" : `  ${detail}`}`}
          </Line>
        );
      })}
      {suggestions.notice === null ? null : (
        <Line color="warning" maxColumns={props.columns} untrusted>
          {suggestions.notice}
        </Line>
      )}
      <Line color="mutedForeground" typography="muted" maxColumns={props.columns}>
        {hint}
      </Line>
    </box>
  );
}

/** The extmark type that marks a mention token. */
const TOKEN_TYPE = "falryn.mention";

type MentionStyle = {
  readonly style: SyntaxStyle;
  readonly ids: Readonly<Record<MentionTrigger, number | undefined>>;
};

function mentionStyleFor(theme: Theme): MentionStyle {
  const color = (token: "accent" | "informational" | "link") => theme.color(token);
  const styleFor = (token: "accent" | "informational" | "link") => {
    const fg = color(token);
    return fg === null ? { underline: true, bold: true } : { fg, bold: true };
  };
  const style = SyntaxStyle.fromStyles({
    "mention.command": styleFor("accent"),
    "mention.capability": styleFor("informational"),
    "mention.attachment": styleFor("link"),
  });
  return {
    style,
    ids: {
      "/": style.getStyleId("mention.command") ?? undefined,
      $: style.getStyleId("mention.capability") ?? undefined,
      "@": style.getStyleId("mention.attachment") ?? undefined,
    },
  };
}

/**
 * The editor measures positions in terminal cells; the draft is UTF-16 text. These
 * two conversions ask the editor itself, so wide and combined characters agree.
 */
function indexOf(renderable: TextareaRenderable, offset: number): number {
  return renderable.editBuffer.getTextRange(0, offset).length;
}

function offsetOf(renderable: TextareaRenderable, index: number, length: number): number {
  // Past the end the editor clamps, so the end is the first offset reaching it.
  // Elsewhere the boundary is the last offset before the next character begins,
  // which puts a wide character wholly on one side.
  const target = Math.min(index, length);
  const first = (predicate: (offset: number) => boolean): number => {
    let low = 0;
    let high = length * 2 + 2;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (predicate(middle)) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  return target >= length
    ? first((offset) => indexOf(renderable, offset) >= length)
    : first((offset) => indexOf(renderable, offset) > target) - 1;
}

function tokenTypeId(renderable: TextareaRenderable): number {
  return renderable.extmarks.getTypeId(TOKEN_TYPE) ?? renderable.extmarks.registerType(TOKEN_TYPE);
}

/** Where the editor now holds each token, keyed by token id, in UTF-16 offsets. */
function reportedRanges(
  renderable: TextareaRenderable,
  _style: MentionStyle,
): ReadonlyMap<string, TokenRange> {
  const ranges = new Map<string, TokenRange>();
  for (const mark of renderable.extmarks.getAllForTypeId(tokenTypeId(renderable))) {
    const id = (mark.data as { readonly id?: unknown } | undefined)?.id;
    if (typeof id !== "string") continue;
    const start = indexOf(renderable, mark.start);
    ranges.set(id, {
      start,
      end: start + renderable.editBuffer.getTextRange(mark.start, mark.end).length,
    });
  }
  return ranges;
}

function tokensPlaced(
  renderable: TextareaRenderable,
  tokens: readonly ComposerToken[],
  style: MentionStyle,
): boolean {
  const ranges = reportedRanges(renderable, style);
  return (
    ranges.size === tokens.length &&
    tokens.every((token) => {
      const range = ranges.get(token.id);
      return range !== undefined && range.start === token.start && range.end === token.end;
    })
  );
}

/**
 * Mark every token as one virtual range: the cursor skips it, Backspace after it
 * removes it whole, and undo restores it — all the editor's own behaviour.
 */
function placeTokens(
  renderable: TextareaRenderable,
  tokens: readonly ComposerToken[],
  style: MentionStyle,
): void {
  const typeId = tokenTypeId(renderable);
  for (const mark of renderable.extmarks.getAllForTypeId(typeId)) {
    renderable.extmarks.delete(mark.id);
  }
  const length = renderable.plainText.length;
  for (const token of tokens) {
    const styleId = style.ids[token.trigger];
    renderable.extmarks.create({
      start: offsetOf(renderable, token.start, length),
      end: offsetOf(renderable, token.end, length),
      virtual: true,
      typeId,
      data: { id: token.id },
      ...(styleId === undefined ? {} : { styleId }),
    });
  }
}

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
  // Mentions are named in words and brackets as well as colour, so a monochrome
  // terminal or a screen reader still says what the prompt will use (#1206).
  if (state.tokens.length > 0) {
    parts.push(`Using ${state.tokens.map((token) => `[${token.label}]`).join(" ")}`);
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
