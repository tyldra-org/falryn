/**
 * `AppShell` — the root, and the only component that decides anything.
 *
 * It resolves the theme, measures the viewport, selects the layout class, owns
 * the text cache, and coordinates the overlay. Everything below it reads those
 * answers and renders. That split is what keeps capability handling from
 * spreading: there is exactly one place that turns a colour level into a
 * palette and a cell count into a layout, and a component that wanted to do
 * either would have to reach past a context that does not expose the inputs.
 *
 * ## Resize
 *
 * The viewport comes from the renderer, so a resize re-renders the tree with new
 * numbers and nothing else. That is deliberate and it is what makes the
 * preservation contract hold by construction rather than by careful bookkeeping:
 * the overlay route, the theme, and the cache all live above the measurement, so
 * a terminal getting narrower changes the arrangement and cannot change what is
 * open, what is selected, or what has been measured. The one thing a resize
 * *does* invalidate is wrapped text, and that is keyed by width.
 *
 * A viewport below the minimum renders an actionable notice instead of the
 * frame. Not a smaller frame: there is no honest arrangement at that size, and
 * an interface with content pushed off the edge is worse than one that says how
 * much room it needs.
 */

import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useMemo, useRef } from "react";
import type { ComposerAction, EditorAction } from "../composer/index.ts";
import {
  composerRows,
  hasContextPanel,
  type LayoutDecision,
  primaryColumns,
  primaryRows,
  selectLayout,
  type Viewport,
} from "../layout.ts";
import { createTextCache } from "../text-cache.ts";
import { resolveTheme, type ThemeRequest } from "../theme/index.ts";
import type { TranscriptGeometry } from "../transcript-model.ts";
import type { CommandEntry, ShellModel } from "../view-model.ts";
import { ActivityRail } from "./activity-rail.tsx";
import { ComposerView } from "./composer.tsx";
import { type Frame, FrameProvider } from "./context.tsx";
import { OverlayHost } from "./overlay.tsx";
import { CommandPalette, HelpOverlay } from "./overlay-routes.tsx";
import { Line } from "./primitives.tsx";
import { ScrollbackCommits } from "./scrollback-commits.tsx";
import { StatusLine } from "./status-line.tsx";
import { TranscriptView } from "./transcript.tsx";
import { WorkspaceHeader } from "./workspace-header.tsx";

export type AppShellProps = {
  readonly model: ShellModel;
  /**
   * Everything needed to resolve the theme, from the layer that knows.
   *
   * Passed rather than derived here: the colour level has already been through
   * `--color`, and the reduced-motion decision has already read the environment.
   * Re-deriving either would be a second answer.
   */
  readonly theme: ThemeRequest;
  /**
   * Reports what the transcript measured, for the layer that dispatches
   * commands.
   *
   * Optional because a frame rendered from a value alone — every test in
   * `./frame.test.tsx` — has nothing to report to.
   */
  readonly onTranscriptGeometry?: (geometry: TranscriptGeometry) => void;
  /**
   * Every command as a row, for the help overlay.
   *
   * Passed rather than derived here because deriving it needs the keymap plan,
   * and this component is deliberately the half that does not know one exists.
   * An empty list is the correct default: a frame rendered without a runtime
   * has no bindings to describe.
   */
  readonly commandRows?: readonly CommandEntry[];
  /**
   * Where composer input goes.
   *
   * Optional for the same reason `onTranscriptGeometry` is: a frame rendered
   * from a value alone has nothing to type into, and without it the composer
   * makes no keyboard subscription at all.
   */
  readonly onComposerAction?: (action: ComposerAction) => void;
  /** A click in the composer focuses it, through the shell's own focus model. */
  readonly onComposerFocus?: () => void;
  /** Where typing in the open palette goes. Absent means a static frame. */
  readonly onPaletteQuery?: (action: EditorAction) => void;
};

export function AppShell(props: AppShellProps): ReactNode {
  const renderer = useRenderer();
  // The subscription. `useTerminalDimensions` is what re-renders this tree on a
  // resize; the renderer's own terminal size is read during that render rather
  // than subscribed to separately, so there is one resize path and not two that
  // could arrive a frame apart.
  // Called for its subscription, not for its value: it is what re-renders this
  // tree on a resize. The *value* comes from the renderer, because the drawable
  // region also changes for reasons that are not resizes — an overlay growing
  // the footer, for one — and a hook that only tracks the terminal would hand
  // back a height that was correct one render ago.
  useTerminalDimensions();
  const viewport: Viewport = { columns: renderer.width, rows: renderer.height };
  const terminal: Viewport = {
    columns: renderer.terminalWidth,
    rows: renderer.terminalHeight,
  };
  // Selected from the terminal, drawn into the viewport. See `Frame` in
  // `./context.tsx` for why those are different questions.
  const layout = selectLayout(terminal);

  const theme = useMemo(() => resolveTheme(props.theme), [props.theme]);

  // Created once and reset on generation change rather than rebuilt: a cache
  // that was a `useMemo` over the theme would be discarded and refilled on
  // every resize, which is exactly the frame a cache is meant to make cheap.
  const cache = useRef<ReturnType<typeof createTextCache> | null>(null);
  cache.current ??= createTextCache({ generation: theme.generation });
  cache.current.reset(theme.generation);

  // Computed once, here, and handed to both the composer that draws those rows
  // and the transcript that sizes itself against what is left.
  const reserved = composerRows(props.model.composer.state.text.split("\n").length);

  const frame: Frame = {
    theme,
    viewport,
    terminal,
    layout,
    cache: cache.current,
    composerRows: reserved,
  };

  return (
    <FrameProvider value={frame}>
      {/*
       * Above the layout decision on purpose. Scrollback belongs to the terminal
       * rather than to the arrangement, so a viewport too small for an honest
       * frame is still a session whose finalized entries have somewhere to go —
       * and a transcript that stopped committing while a window was briefly
       * narrow would have a permanent hole in it.
       */}
      <ScrollbackCommits model={props.model.transcript} />
      {layout.kind === "insufficient" ? (
        <MinimumSizeNotice viewport={terminal} decision={layout} />
      ) : (
        <ShellFrame
          model={props.model}
          viewport={viewport}
          layout={layout}
          commandRows={props.commandRows ?? []}
          {...(props.onTranscriptGeometry === undefined
            ? {}
            : { onTranscriptGeometry: props.onTranscriptGeometry })}
          {...(props.onComposerAction === undefined
            ? {}
            : { onComposerAction: props.onComposerAction })}
          {...(props.onComposerFocus === undefined
            ? {}
            : { onComposerFocus: props.onComposerFocus })}
          {...(props.onPaletteQuery === undefined ? {} : { onPaletteQuery: props.onPaletteQuery })}
        />
      )}
    </FrameProvider>
  );
}

function ShellFrame(props: {
  readonly model: ShellModel;
  readonly viewport: Viewport;
  readonly layout: Extract<LayoutDecision, { kind: "layout" }>;
  readonly commandRows: readonly CommandEntry[];
  readonly onTranscriptGeometry?: (geometry: TranscriptGeometry) => void;
  readonly onComposerAction?: (action: ComposerAction) => void;
  /** A click in the composer focuses it, through the shell's own focus model. */
  readonly onComposerFocus?: () => void;
  readonly onPaletteQuery?: (action: EditorAction) => void;
}): ReactNode {
  const { model } = props;
  // Bounded rather than stretched. A `wide` terminal has room for a contextual
  // panel, and #358 puts the activity rail there — so the columns the rail
  // takes are subtracted rather than the transcript being given a proportion,
  // which is how an interface arrives at a permanently tiled control centre.
  const primary = primaryColumns(props.viewport, props.layout.class);
  const railRows = primaryRows(
    props.viewport,
    composerRows(model.composer.state.text.split("\n").length),
  );

  return (
    <box flexDirection="column" width={props.viewport.columns} height={props.viewport.rows}>
      <WorkspaceHeader model={model.header} />
      <box flexDirection="row" flexGrow={1}>
        <box flexGrow={1} flexDirection="column" width={primary}>
          {model.overlay.kind === "none" ? (
            <TranscriptView
              model={model.transcript}
              {...(props.onTranscriptGeometry === undefined
                ? {}
                : { onGeometry: props.onTranscriptGeometry })}
            />
          ) : (
            <OverlayHost
              route={model.overlay}
              title={model.overlay.kind === "help" ? "Help" : "Commands"}
              dismissHint="Esc closes this"
            >
              {(rows) =>
                model.overlay.kind === "help" ? (
                  <HelpOverlay sections={model.help} commands={props.commandRows} rows={rows} />
                ) : (
                  <CommandPalette
                    commands={model.commands}
                    query={model.overlay.kind === "palette" ? model.overlay.query.text : ""}
                    rows={rows}
                    {...(props.onPaletteQuery === undefined
                      ? {}
                      : { onQuery: props.onPaletteQuery })}
                  />
                )
              }
            </OverlayHost>
          )}
        </box>
        {/*
         * The one persistent contextual surface a wide layout gets. The design
         * direction allows exactly one and refuses a permanently tiled control
         * centre, so narrower layouts get no rail rather than a squeezed one —
         * and `primaryColumns` already subtracts its width only when it is
         * drawn, so the transcript keeps the room on every other layout.
         */}
        {hasContextPanel(props.layout.class) ? (
          <ActivityRail projection={model.activity.projection} rows={railRows} />
        ) : null}
      </box>
      {/*
       * Below the primary region and above the status line, which is reading
       * order and is also where the focus ring expects it. Outside the flexing
       * box on purpose: the composer asks for the rows it needs and the
       * transcript receives what is left, so a growing draft never pushes the
       * status line off the screen.
       */}
      <ComposerView
        model={model.composer}
        {...(props.onComposerAction === undefined ? {} : { onAction: props.onComposerAction })}
        {...(props.onComposerFocus === undefined ? {} : { onFocus: props.onComposerFocus })}
      />
      <StatusLine model={model.status} />
    </box>
  );
}

export type MinimumSizeNoticeProps = {
  readonly viewport: Viewport;
  readonly decision: Extract<LayoutDecision, { kind: "insufficient" }>;
};

/**
 * What a terminal too small for any arrangement is shown.
 *
 * Names the size it has and the size it needs, because "too small" is not
 * something a user can act on and "24×6" is. It draws no border: a box around a
 * message on a terminal with six rows spends two of them on lines.
 */
export function MinimumSizeNotice(props: MinimumSizeNoticeProps): ReactNode {
  const { decision, viewport } = props;
  return (
    <box flexDirection="column">
      <Line color="warning" typography="heading">
        Terminal too small
      </Line>
      <Line color="foreground">
        {`${viewport.columns}×${viewport.rows}; needs ${decision.needColumns}×${decision.needRows}`}
      </Line>
    </box>
  );
}
