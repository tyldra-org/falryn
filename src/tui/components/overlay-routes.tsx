/**
 * The two overlay routes.
 *
 * Both render the same rows from the same registry, and the difference is what
 * they are for: help explains, the palette dispatches. Neither maintains a table
 * of its own, which is the point — a hand-written shortcut list is wrong the
 * first time a binding moves, and it is wrong silently.
 *
 * Availability is shown rather than filtered out. A command that cannot run
 * today is still something a user should be able to find, read, and be told the
 * reason for: "there is no composer yet" answers the question that a missing row
 * leaves someone searching for.
 *
 * Help wraps its prose through the frame's cache rather than on every frame,
 * which is where that cache has its real caller: help text is paragraphs, and a
 * resize re-measures all of it.
 *
 * The palette subscribes to keys, which is why this module reaches OpenTUI's
 * runtime and help does not. A search field is a focused text control, and the
 * alternative — routing every character through the command registry — would put
 * a dispatch between a keystroke and the character it produces.
 */

import type { KeyEvent } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import type { ReactNode } from "react";
import { graphemes } from "../../domain/index.ts";
import type { EditorAction } from "../composer/index.ts";
import type { CommandEntry, HelpSection } from "../view-model.ts";
import { useFrame } from "./context.tsx";
import { Line } from "./primitives.tsx";

/** Cells the overlay panel's own border and padding take from its content. */
const PANEL_CHROME_COLUMNS = 4;

/** Cells reserved for the key column, so titles line up down the overlay. */
const KEY_COLUMN = 12;

export type HelpOverlayProps = {
  readonly sections: readonly HelpSection[];
  readonly commands: readonly CommandEntry[];
  /** Rows the panel has. Content beyond them is reported, never drawn over. */
  readonly rows: number;
};

export function HelpOverlay(props: HelpOverlayProps): ReactNode {
  const { terminal, cache } = useFrame();
  const width = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);

  // The commands come first when room is short. Someone who opened help on a
  // small terminal is looking for a key, not for orientation prose.
  //
  // The budget counts every row this component draws, including the one the
  // "N more" line takes — which is why it is subtracted before the slice rather
  // than after. Getting that backwards renders one row too many, and a terminal
  // does not clip: the extra line draws over the panel's own border.
  const budget = Math.max(1, props.rows);
  const truncated = props.commands.length > budget;
  const shownCommands = props.commands.slice(0, truncated ? budget - 1 : budget);
  const hiddenCommands = props.commands.length - shownCommands.length;
  const proseRows = Math.max(0, budget - shownCommands.length - (truncated ? 1 : 0));

  return (
    <box flexDirection="column">
      {proseRows > 0
        ? props.sections.slice(0, proseRows).map((section) => (
            <box key={section.title} flexDirection="column">
              <Line color="accent" typography="heading" maxColumns={width}>
                {section.title}
              </Line>
              {/*
            A wrapped line has no identity of its own — it is a slice of a
            paragraph, and two paragraphs can wrap to the same words — so its
            position within its section is the only stable key there is. The
            list is also append-only within a section and never reordered, which
            is the condition that makes an index key safe.
          */}
              {cache.wrap(section.body, width).map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a wrapped line is identified by its position, per the note above.
                <Line key={`${section.title}:${index}`} color="foreground" maxColumns={width}>
                  {line}
                </Line>
              ))}
            </box>
          ))
        : null}

      {shownCommands.map((command) => (
        <CommandRow key={command.id} command={command} width={width} />
      ))}
      {hiddenCommands > 0 ? (
        <Line color="mutedForeground" typography="muted" maxColumns={width}>
          {`${hiddenCommands} more — a taller terminal shows them`}
        </Line>
      ) : null}
    </box>
  );
}

export type CommandPaletteProps = {
  /** Already narrowed by the query. This component filters nothing. */
  readonly commands: readonly CommandEntry[];
  /** What was typed. Empty shows everything, which is the useful default. */
  readonly query: string;
  readonly rows: number;
  /**
   * Where typing goes.
   *
   * Optional, because a frame rendered from a value alone has nothing to type
   * into — every case in `./frame.test.tsx` renders one. Absent, the key
   * handler returns immediately and no edit is ever produced.
   */
  readonly onQuery?: (action: EditorAction) => void;
};

export function CommandPalette(props: CommandPaletteProps): ReactNode {
  const { terminal } = useFrame();
  const width = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);
  usePaletteInput(props.onQuery);

  // The search line is drawn first and always, so everything else is measured
  // against what is left of the budget. Deliberately not clamped to a minimum: a
  // one-row panel has room for the query and nothing else, and clamping a budget
  // up to 1 is how a region comes to draw more rows than it was given. A
  // terminal does not clip — the surplus row lands on its neighbour.
  const contentRows = Math.max(0, props.rows - 1);
  const matched = props.commands.length;

  // The notice takes a row of its own, and only when there is a row for it to
  // take. `matched > contentRows` rather than a separate truncation flag,
  // because the question is whether the list fits in the rows that remain.
  const notice = matched > contentRows && contentRows >= 1;
  const shown = props.commands.slice(0, Math.max(0, contentRows - (notice ? 1 : 0)));
  const hidden = matched - shown.length;

  return (
    <box flexDirection="column">
      <Line color="mutedForeground" typography="label" maxColumns={width}>
        {props.query === "" ? "Type to search commands." : `Search: ${props.query}`}
      </Line>
      {/*
       * Keyed off what *matched*, never off what fits. Asking whether any row was
       * shown conflates two different answers — "your search found nothing" and
       * "the panel is too short to list what it found" — and reports the first
       * when the second is true. That regressed during #364 and reached every
       * palette open: the overlay caps its height while the reveal runs, so the
       * budget is one row for that whole window and a full list rendered
       * "Nothing matches that." above its own "N more" line.
       */}
      {matched === 0 ? (
        contentRows >= 1 ? (
          <Line color="mutedForeground" typography="muted" maxColumns={width}>
            Nothing matches that.
          </Line>
        ) : null
      ) : (
        shown.map((command) => <CommandRow key={command.id} command={command} width={width} />)
      )}
      {notice ? (
        <Line color="mutedForeground" typography="muted" maxColumns={width}>
          {/*
           * Two sentences, because "more" is only true when something was shown.
           * With no room for a single command, "12 more" invites the reader to
           * look for the eleven above it.
           */}
          {shown.length === 0
            ? `${hidden} commands; too little room to list them`
            : `${hidden} more — narrow the search`}
        </Line>
      ) : null}
    </box>
  );
}

/**
 * Keys, while the palette is open.
 *
 * Everything a binding claims never arrives here — the keymap resolves a bound
 * key and dispatches before any subscriber sees it — so `escape` still closes
 * the overlay and `ctrl+c` still leaves. What is left is characters and the
 * edits a search field needs, which is deliberately less than the composer
 * handles: a query is one line, so there is no vertical movement to support.
 *
 * The palette is only rendered while it is the open route, so there is no
 * focused check here. Mounting *is* the condition.
 */
function usePaletteInput(onQuery: ((action: EditorAction) => void) | undefined): void {
  useKeyboard((key) => {
    if (onQuery === undefined) {
      return;
    }
    const edit = editFor(key);
    if (edit !== null) {
      onQuery(edit);
    }
  });
}

/** The edit a key means in a search field, or `null` when it means nothing here. */
function editFor(key: KeyEvent): EditorAction | null {
  switch (key.name) {
    case "backspace":
      return { kind: "delete-backward" };
    case "delete":
      return { kind: "delete-forward" };
    case "left":
      return { kind: "move", motion: "left", extend: key.shift === true };
    case "right":
      return { kind: "move", motion: "right", extend: key.shift === true };
    case "home":
      return { kind: "move", motion: "line-start", extend: key.shift === true };
    case "end":
      return { kind: "move", motion: "line-end", extend: key.shift === true };
    default:
      break;
  }

  // A modifier means a chord, and a chord that reached here is one nothing
  // bound — inserting its letter would type `p` for an unregistered `alt+p`.
  if (key.ctrl === true || key.meta === true) {
    return null;
  }
  const sequence = key.sequence;
  if (sequence !== "" && graphemes(sequence).length === 1 && sequence >= " ") {
    return { kind: "insert", text: sequence };
  }
  return null;
}

/**
 * One command: its key, its name, and why it will not run.
 *
 * The reason is the row's most important field when it is present. A palette
 * that greyed an entry out would communicate unavailability with colour alone,
 * which is the one thing this area's controls forbid — so the words carry it and
 * the muted colour is the second channel rather than the only one.
 */
function CommandRow(props: { readonly command: CommandEntry; readonly width: number }): ReactNode {
  const { command } = props;
  const unavailable = command.unavailableReason !== null;

  return (
    <box flexDirection="row">
      <Line color="accent" typography="label" maxColumns={KEY_COLUMN}>
        {/* An em dash rather than a blank: "this command has no key" is a fact,
            and an empty column reads as a rendering gap. */}
        {command.binding ?? "—"}
      </Line>
      <Line
        color={unavailable ? "mutedForeground" : "foreground"}
        typography={unavailable ? "muted" : "body"}
        maxColumns={Math.max(8, props.width - KEY_COLUMN)}
      >
        {unavailable ? `${command.title} — ${command.unavailableReason}` : command.title}
      </Line>
    </box>
  );
}
