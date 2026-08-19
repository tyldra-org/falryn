/**
 * Media summary viewer (#267).
 *
 * Shows format, stored size, and a hex prefix. No pixel decode or execution.
 */

import type { ReactNode } from "react";
import type { MediaViewModel } from "../../presentation/viewer/index.ts";
import { useFrame } from "../components/context.tsx";
import { Line } from "../components/primitives.tsx";

const PANEL_CHROME_COLUMNS = 4;

export type MediaViewerProps = {
  readonly model: MediaViewModel | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly rows: number;
};

export function MediaViewer(props: MediaViewerProps): ReactNode {
  const { terminal, cache } = useFrame();
  const width = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);

  if (props.loading) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={width}>
        Loading media summary…
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
  const hexLines = model.withheld ? [] : cache.wrap(model.hexPreview, width);

  return (
    <box flexDirection="column" height={props.rows}>
      {model.statusNote === null ? null : (
        <Line color="warning" typography="muted" maxColumns={width}>
          {model.statusNote}
        </Line>
      )}
      <Line color="mutedForeground" typography="muted" maxColumns={width}>
        {`${model.format} · summary · ${model.storedByteLength} bytes`}
      </Line>
      {model.withheld ? (
        <Line color="mutedForeground" typography="muted" maxColumns={width}>
          Media summary withheld.
        </Line>
      ) : (
        <scrollbox focused height={contentHeight} width={width}>
          <box flexDirection="column">
            {hexLines.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: wrapped hex lines are positional slices.
              <Line key={index} color="foreground" typography="code" maxColumns={width}>
                {line}
              </Line>
            ))}
          </box>
        </scrollbox>
      )}
    </box>
  );
}
