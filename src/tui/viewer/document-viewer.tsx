/**
 * Plain document viewer (#267).
 *
 * Renders markdown, HTML-as-text, logs, and plain text without sanitization or
 * layout beyond wrapping. Highlighting stays with the code viewer.
 */

import type { ReactNode } from "react";
import { wrapToWidthWindow } from "../../domain/index.ts";
import type { DocumentViewModel } from "../../presentation/viewer/index.ts";
import { useFrame } from "../components/context.tsx";
import { Line } from "../components/primitives.tsx";

const PANEL_CHROME_COLUMNS = 4;

export type DocumentViewerProps = {
  readonly model: DocumentViewModel | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly rows: number;
};

export function DocumentViewer(props: DocumentViewerProps): ReactNode {
  const { terminal } = useFrame();
  const width = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);

  if (props.loading) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={width}>
        Loading document…
      </Line>
    );
  }

  if (props.error !== null) {
    return (
      <Line color="error" typography="body" maxColumns={width}>
        {props.error}
      </Line>
    );
  }

  if (props.model === null) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={width}>
        Nothing to show.
      </Line>
    );
  }

  const { model } = props;
  const chromeRows = (model.statusNote === null ? 0 : 1) + 1;
  const contentHeight = Math.max(1, props.rows - chromeRows);
  const windowed = model.withheld
    ? { lines: [] as const, truncated: false }
    : wrapToWidthWindow(model.text, width, contentHeight);
  const lines = windowed.lines;

  return (
    <box flexDirection="column" height={props.rows}>
      {model.statusNote === null ? null : (
        <Line color="warning" typography="muted" maxColumns={width}>
          {model.statusNote}
        </Line>
      )}
      <Line color="mutedForeground" typography="muted" maxColumns={width}>
        {`${model.family} · document${windowed.truncated ? " · windowed" : ""}`}
      </Line>
      {model.withheld ? (
        <Line color="mutedForeground" typography="muted" maxColumns={width}>
          Document withheld.
        </Line>
      ) : (
        <box flexDirection="column" height={contentHeight}>
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: wrapped document lines are positional slices.
            <Line key={index} color="foreground" typography="body" maxColumns={width}>
              {line}
            </Line>
          ))}
        </box>
      )}
    </box>
  );
}
