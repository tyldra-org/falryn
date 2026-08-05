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

import type { SelectOption, SelectRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { type ReactNode, useMemo, useRef } from "react";
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

  return (
    <scrollbox focused height={Math.max(1, props.rows)}>
      <box flexDirection="column">
        {props.sections.map((section) => (
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
        ))}
        {props.commands.map((command) => (
          <CommandRow key={command.id} command={command} width={width} />
        ))}
      </box>
    </scrollbox>
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
  readonly onQuery?: (query: string) => void;
  /** Runs the selected command by stable id. */
  readonly onSelect?: (id: string) => void;
};

export function CommandPalette(props: CommandPaletteProps): ReactNode {
  const { terminal, theme } = useFrame();
  const width = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);
  const results = useRef<SelectRenderable | null>(null);
  const options = useMemo(() => props.commands.map(optionOf), [props.commands]);
  const textColor = theme.color("foreground");
  const mutedColor = theme.color("mutedForeground");
  const selectionColor = theme.color("selection");

  useKeyboard((key) => {
    const list = results.current;
    if (list === null || options.length === 0) {
      return;
    }
    if (key.name === "up") {
      key.preventDefault();
      list.moveUp();
    } else if (key.name === "down") {
      key.preventDefault();
      list.moveDown();
    }
  });

  const select = (option: SelectOption | null): void => {
    if (option !== null && typeof option.value === "string") {
      props.onSelect?.(option.value);
    }
  };

  return (
    <box flexDirection="column">
      <input
        value={props.query}
        focused={props.onQuery !== undefined}
        width={width}
        placeholder="Type to search commands."
        {...(textColor === null ? {} : { textColor })}
        {...(mutedColor === null ? {} : { placeholderColor: mutedColor })}
        onInput={(query) => props.onQuery?.(query)}
        onSubmit={() => results.current?.selectCurrent()}
      />
      {props.rows > 1 && options.length > 0 ? (
        <select
          ref={results}
          options={options}
          height={props.rows - 1}
          width={width}
          focused={false}
          showScrollIndicator
          showDescription={props.rows >= 3}
          selectedIndex={0}
          {...(textColor === null
            ? {}
            : { textColor, selectedTextColor: textColor, selectedDescriptionColor: textColor })}
          {...(mutedColor === null ? {} : { descriptionColor: mutedColor })}
          {...(selectionColor === null ? {} : { selectedBackgroundColor: selectionColor })}
          onSelect={(_index, option) => select(option)}
        />
      ) : props.rows > 1 ? (
        <Line color="mutedForeground" typography="muted" maxColumns={width}>
          Nothing matches that.
        </Line>
      ) : null}
    </box>
  );
}

function optionOf(command: CommandEntry): SelectOption {
  return {
    name: `${command.binding ?? "—"}  ${command.title}`,
    description:
      command.unavailableReason === null
        ? command.description
        : `Unavailable: ${command.unavailableReason}`,
    value: command.id,
  };
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
