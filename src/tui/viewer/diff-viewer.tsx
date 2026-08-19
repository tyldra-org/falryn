/**
 * Unified and split diff viewer (#266).
 */

import { RGBA, SyntaxStyle } from "@opentui/core";
import type { ReactNode } from "react";
import { type DiffViewModel, diffTextForHunk } from "../../presentation/viewer/index.ts";
import { useFrame } from "../components/context.tsx";
import { Line } from "../components/primitives.tsx";
import type { ColorToken } from "../theme/index.ts";
import type { Theme } from "../theme/theme.ts";
import { filetypeFor } from "./code-viewer.tsx";

const PANEL_CHROME_COLUMNS = 4;

export type DiffViewerProps = {
  readonly model: DiffViewModel | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly rows: number;
  readonly layout: "unified" | "split";
  readonly hunkIndex: number;
};

export function DiffViewer(props: DiffViewerProps): ReactNode {
  const { terminal, theme } = useFrame();
  const width = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);

  if (props.loading) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={width}>
        Loading diff…
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
  const syntaxStyle = syntaxStyleFor(theme);
  const hunkTotal = Math.max(1, model.hunkCount);
  const hunkIndex = Math.max(0, Math.min(props.hunkIndex, hunkTotal - 1));
  const chromeRows = (model.statusNote === null ? 0 : 1) + 1;
  const contentHeight = Math.max(1, props.rows - chromeRows);
  const focusedDiff = hunkTotal > 1 ? diffTextForHunk(model.text, hunkIndex) : model.text;

  return (
    <box flexDirection="column" height={props.rows}>
      {model.statusNote === null ? null : (
        <Line color="warning" typography="muted" maxColumns={width}>
          {model.statusNote}
        </Line>
      )}
      <Line color="mutedForeground" typography="muted" maxColumns={width}>
        {`Hunk ${hunkIndex + 1} of ${hunkTotal} · ${props.layout}`}
      </Line>
      {model.withheld ? (
        <Line color="mutedForeground" typography="muted" maxColumns={width}>
          Diff withheld.
        </Line>
      ) : (
        <scrollbox focused height={contentHeight} width={width}>
          <diff
            diff={focusedDiff}
            view={props.layout}
            filetype={filetypeFor("text")}
            syntaxStyle={syntaxStyle}
            showLineNumbers
            width={width}
            height={contentHeight}
          />
        </scrollbox>
      )}
    </box>
  );
}

function syntaxStyleFor(theme: Theme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    keyword: { fg: RGBA.fromHex(themeColor(theme, "accent")) },
    string: { fg: RGBA.fromHex(themeColor(theme, "success")) },
    comment: { fg: RGBA.fromHex(themeColor(theme, "mutedForeground")), italic: true },
    number: { fg: RGBA.fromHex(themeColor(theme, "warning")) },
    default: { fg: RGBA.fromHex(themeColor(theme, "foreground")) },
  });
}

function themeColor(theme: Theme, token: ColorToken): string {
  return theme.color(token) ?? theme.color("foreground") ?? "";
}
