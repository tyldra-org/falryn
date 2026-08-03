/**
 * The three wrappers everything else is built from.
 *
 * Each exists because it adds a semantic contract, which is the only reason this
 * repository wraps an OpenTUI primitive at all. None of them forks a component
 * to change a colour or a spacing.
 *
 * - `Line` is the single place a token becomes a colour and a role becomes
 *   attributes. That is what lets a source-tree control assert no view names a
 *   hex string, and it is where measured-width truncation happens so no view
 *   reaches for `String.length`.
 * - `StatusMark` is the promise that a status is never only a colour. It draws a
 *   symbol *and* a word, always, so the guarantee is structural rather than a
 *   thing each caller has to remember.
 * - `Panel` is a bordered region with a surface, so border strength stays a
 *   meaning rather than a line style chosen per call site.
 *
 * A resolved colour may be `null`, and these pass it through untouched. Omitting
 * the prop is what makes a monochrome terminal actually monochrome; substituting
 * a grey here would let colour-only meaning survive into the one terminal that
 * cannot carry it.
 */

import type { ReactNode } from "react";
import { sanitizeTerminalText, truncateToWidth } from "../../domain/index.ts";
import {
  type BorderStrength,
  type ColorToken,
  STATUS_PRESENTATION,
  type StatusToken,
  type SurfaceToken,
  type TypographyRole,
} from "../theme/index.ts";
import { useTheme } from "./context.tsx";

export type LineProps = {
  readonly children: string;
  readonly color?: ColorToken;
  /**
   * The typography role.
   *
   * Named `typography` rather than `role`, which reads better and avoids a
   * collision that is not merely cosmetic: `role` is ARIA's, and a linter
   * checking JSX accessibility reads any `role` prop as one — reporting
   * `heading` and `muted` as invalid ARIA roles on components that are not DOM
   * elements at all.
   */
  readonly typography?: TypographyRole;
  /**
   * Cells this line may occupy.
   *
   * Truncation goes through the domain's measured-width function with the
   * theme's own mark, so a wide glyph counts as two cells and the mark fits in
   * the space it was promised. A line with no bound is not truncated here; the
   * terminal will clip it, which is the correct behavior for content whose
   * container already decided the width.
   */
  readonly maxColumns?: number;
  /** Untrusted text: escapes control characters so a value cannot forge a line. */
  readonly untrusted?: boolean;
};

export function Line(props: LineProps): ReactNode {
  const theme = useTheme();
  const style = theme.typography(props.typography ?? "body");
  const color = props.color === undefined ? null : theme.color(props.color);

  const source = props.untrusted === true ? sanitizeTerminalText(props.children) : props.children;
  const text =
    props.maxColumns === undefined
      ? source
      : truncateToWidth(source, props.maxColumns, theme.marks.truncation);

  return (
    <text
      {...(color === null ? {} : { fg: color })}
      attributes={attributesFor(style)}
      wrapMode="none"
    >
      {text}
    </text>
  );
}

/**
 * Attributes as OpenTUI's bit field.
 *
 * The mapping is written here rather than imported from `@opentui/core`'s
 * helper so this module keeps one dependency on the renderer's shape instead of
 * scattering `createTextAttributes` calls through the views. The bit values are
 * the conventional SGR order.
 */
function attributesFor(style: {
  readonly bold: boolean;
  readonly dim: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
}): number {
  return (
    (style.bold ? 1 : 0) | (style.dim ? 2 : 0) | (style.italic ? 4 : 0) | (style.underline ? 8 : 0)
  );
}

export type StatusMarkProps = {
  readonly status: StatusToken;
  /**
   * Words instead of the status's own.
   *
   * The symbol is never overridable and the word is never omitted. A caller may
   * say "3 findings" where the default would say "warning" — it may not reduce
   * the status to a coloured glyph, which is the whole failure this component
   * exists to make impossible.
   */
  readonly label?: string;
  readonly maxColumns?: number;
};

export function StatusMark(props: StatusMarkProps): ReactNode {
  const theme = useTheme();
  const presentation = STATUS_PRESENTATION[props.status];
  const text = `${theme.symbol(presentation.symbol)} ${props.label ?? presentation.label}`;
  return (
    <Line
      color={presentation.token}
      typography="emphasis"
      {...(props.maxColumns === undefined ? {} : { maxColumns: props.maxColumns })}
    >
      {text}
    </Line>
  );
}

export type PanelProps = {
  readonly children: ReactNode;
  readonly strength?: BorderStrength;
  readonly surface?: SurfaceToken;
  readonly title?: string;
  readonly flexGrow?: number;
  readonly height?: number;
  readonly width?: number;
  readonly padding?: number;
};

export function Panel(props: PanelProps): ReactNode {
  const theme = useTheme();
  const style = theme.border(props.strength ?? "none");
  const background = theme.color(props.surface ?? "background");
  // `focus` is the only strength that borrows the focus token; every other one
  // is drawn in the muted foreground, because a border marking a region should
  // not compete with the content inside it.
  const borderColor = theme.color(props.strength === "focus" ? "focus" : "mutedForeground");

  return (
    <box
      {...(style === null ? { border: false } : { border: true, borderStyle: style })}
      {...(borderColor === null || style === null ? {} : { borderColor })}
      {...(background === null ? {} : { backgroundColor: background })}
      {...(props.title === undefined ? {} : { title: props.title })}
      {...(props.flexGrow === undefined ? {} : { flexGrow: props.flexGrow })}
      {...(props.height === undefined ? {} : { height: props.height })}
      {...(props.width === undefined ? {} : { width: props.width })}
      {...(props.padding === undefined ? {} : { padding: props.padding })}
    >
      {props.children}
    </box>
  );
}
