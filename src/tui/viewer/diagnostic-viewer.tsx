/**
 * Diagnostic artifact inspector (#269).
 *
 * Shows parsed level, code, and subsystem plus the bounded text body. Recovery
 * stays on explicit commands; this overlay does not spawn or restore.
 */

import type { ReactNode } from "react";
import type { DiagnosticViewModel } from "../../presentation/viewer/index.ts";
import { useFrame } from "../components/context.tsx";
import { Line } from "../components/primitives.tsx";

const PANEL_CHROME_COLUMNS = 4;

export type DiagnosticViewerProps = {
  readonly model: DiagnosticViewModel | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly rows: number;
};

export function DiagnosticViewer(props: DiagnosticViewerProps): ReactNode {
  const { terminal, cache } = useFrame();
  const width = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);

  if (props.loading) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={width}>
        Loading diagnostic…
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
  const lines = model.withheld ? [] : cache.wrap(model.text, width);
  const identity = [
    model.level ?? "unspecified",
    model.subsystem ?? "runtime",
    model.parsed ? "parsed" : "raw",
    ...(model.code === null ? [] : [model.code]),
  ].join(" · ");

  return (
    <box flexDirection="column" height={props.rows}>
      {model.statusNote === null ? null : (
        <Line color="warning" typography="muted" maxColumns={width}>
          {model.statusNote}
        </Line>
      )}
      <Line color="mutedForeground" typography="muted" maxColumns={width}>
        {identity}
      </Line>
      {model.withheld ? (
        <Line color="mutedForeground" typography="muted" maxColumns={width}>
          Diagnostic withheld.
        </Line>
      ) : (
        <scrollbox focused height={contentHeight} width={width}>
          <box flexDirection="column">
            {lines.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: wrapped diagnostic lines are positional slices.
              <Line key={index} color="foreground" typography="body" maxColumns={width}>
                {line}
              </Line>
            ))}
          </box>
        </scrollbox>
      )}
    </box>
  );
}
