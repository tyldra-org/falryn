/**
 * Syntax-highlighted source viewer (#265).
 *
 * Renders a `CodeViewModel` with OpenTUI's `<code>` primitive. Loading,
 * refusal, and wrong-kind states stay plain text so the overlay never invents
 * highlighting for bytes it does not have.
 */

import { RGBA, SyntaxStyle } from "@opentui/core";
import type { ReactNode } from "react";
import type { CodeViewModel } from "../../presentation/viewer/index.ts";
import { useFrame } from "../components/context.tsx";
import { Line } from "../components/primitives.tsx";
import type { ColorToken } from "../theme/index.ts";
import type { Theme } from "../theme/theme.ts";

/** Cells the overlay panel's own border and padding take from its content. */
const PANEL_CHROME_COLUMNS = 4;

export type CodeViewerProps = {
  readonly model: CodeViewModel | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly rows: number;
};

export function CodeViewer(props: CodeViewerProps): ReactNode {
  const { terminal, theme } = useFrame();
  const width = Math.max(8, terminal.columns - PANEL_CHROME_COLUMNS);

  if (props.loading) {
    return (
      <Line color="mutedForeground" typography="muted" maxColumns={width}>
        Loading source…
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
  const filetype = filetypeFor(model.language);
  const contentHeight = Math.max(1, props.rows - (model.statusNote === null ? 0 : 1));

  return (
    <box flexDirection="column" height={props.rows}>
      {model.statusNote === null ? null : (
        <Line color="warning" typography="muted" maxColumns={width}>
          {model.statusNote}
        </Line>
      )}
      {model.withheld ? (
        <Line color="mutedForeground" typography="muted" maxColumns={width}>
          Source withheld.
        </Line>
      ) : (
        <scrollbox focused height={contentHeight} width={width}>
          <code
            content={model.text}
            filetype={filetype}
            syntaxStyle={syntaxStyle}
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

/** Maps domain code languages to Tree-sitter filetypes OpenTUI understands. */
export function filetypeFor(language: string): string {
  switch (language) {
    case "typescript":
      return "typescript";
    case "javascript":
      return "javascript";
    case "python":
      return "python";
    case "rust":
      return "rust";
    case "go":
      return "go";
    case "java":
      return "java";
    case "c":
      return "c";
    case "cpp":
      return "cpp";
    case "bash":
      return "bash";
    case "css":
      return "css";
    case "html":
      return "html";
    case "json":
      return "json";
    case "markdown":
      return "markdown";
    case "yaml":
      return "yaml";
    case "xml":
      return "xml";
    case "toml":
      return "toml";
    default:
      return "text";
  }
}
