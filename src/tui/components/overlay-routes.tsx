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
 */

import type { ReactNode } from "react";
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
  readonly commands: readonly CommandEntry[];
  /** What was typed. Empty shows everything, which is the useful default. */
  readonly query: string;
  readonly rows: number;
};

export function CommandPalette(props: CommandPaletteProps): ReactNode {
  const { terminal } = useFrame();
  const width = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);

  // One row goes to the search line, and one more to the "N more" line when
  // there is one. Both are subtracted before the slice, for the reason the help
  // overlay states: an extra row draws over the panel border rather than being
  // clipped.
  const budget = Math.max(1, props.rows - 1);
  const truncated = props.commands.length > budget;
  const shown = props.commands.slice(0, truncated ? budget - 1 : budget);
  const hidden = props.commands.length - shown.length;

  return (
    <box flexDirection="column">
      <Line color="mutedForeground" typography="label" maxColumns={width}>
        {props.query === "" ? "Type to search commands." : `Search: ${props.query}`}
      </Line>
      {props.commands.length === 0 ? (
        <Line color="mutedForeground" typography="muted" maxColumns={width}>
          Nothing matches that.
        </Line>
      ) : (
        props.commands
          .slice(0, Math.max(1, props.rows - 1))
          .map((command) => <CommandRow key={command.id} command={command} width={width} />)
      )}
      {props.commands.length > Math.max(1, props.rows - 1) ? (
        <Line color="mutedForeground" typography="muted" maxColumns={width}>
          {`${props.commands.length - Math.max(1, props.rows - 1)} more — narrow the search`}
        </Line>
      ) : null}
    </box>
  );
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
