/**
 * The two overlay routes this delivery mounts.
 *
 * Presentation shells. Their *content* is a view model someone hands them, and
 * the keys that open them and move within them are #26's — so these are honest
 * about being unbound rather than pretending to be interactive. A palette with a
 * fake selection or a help overlay claiming shortcuts that do not exist would be
 * worse than one that says so.
 *
 * Both wrap long text through the frame's cache rather than wrapping on every
 * frame, which is the one place in this delivery where the cache has a real
 * caller: help text is paragraphs, and a resize re-measures all of it.
 */

import type { ReactNode } from "react";
import type { CommandEntry, HelpSection } from "../view-model.ts";
import { useFrame } from "./context.tsx";
import { Line } from "./primitives.tsx";

/** Cells the overlay panel's own border and padding take from its content. */
const PANEL_CHROME_COLUMNS = 4;

export type HelpOverlayProps = {
  readonly sections: readonly HelpSection[];
};

export function HelpOverlay(props: HelpOverlayProps): ReactNode {
  const { terminal, cache } = useFrame();
  const width = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);

  if (props.sections.length === 0) {
    return (
      <Line color="mutedForeground" typography="muted">
        There is nothing to explain yet.
      </Line>
    );
  }

  return (
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
    </box>
  );
}

export type CommandPaletteProps = {
  readonly commands: readonly CommandEntry[];
};

export function CommandPalette(props: CommandPaletteProps): ReactNode {
  const { terminal } = useFrame();
  const width = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);

  if (props.commands.length === 0) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={width}>
        No commands are available yet.
      </Line>
    );
  }

  return (
    <box flexDirection="column">
      {props.commands.map((command) => (
        <box key={command.id} flexDirection="row" justifyContent="space-between">
          <Line color="foreground" maxColumns={width}>
            {command.title}
          </Line>
          {command.hint === null ? null : (
            <Line color="mutedForeground" typography="muted" maxColumns={width}>
              {command.hint}
            </Line>
          )}
        </box>
      ))}
    </box>
  );
}
