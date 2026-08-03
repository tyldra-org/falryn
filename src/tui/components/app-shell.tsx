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
import { type LayoutDecision, primaryColumns, selectLayout, type Viewport } from "../layout.ts";
import { createTextCache } from "../text-cache.ts";
import { resolveTheme, type ThemeRequest } from "../theme/index.ts";
import type { ShellModel } from "../view-model.ts";
import { type Frame, FrameProvider } from "./context.tsx";
import { OverlayHost } from "./overlay.tsx";
import { CommandPalette, HelpOverlay } from "./overlay-routes.tsx";
import { Line } from "./primitives.tsx";
import { StatusLine } from "./status-line.tsx";
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
   * The primary region's content.
   *
   * `TranscriptView` and `Composer` mount here — they are #25's. Until then the
   * shell supplies a quiet placeholder rather than this component inventing one,
   * because an empty region's message is a product decision and not a layout
   * one.
   */
  readonly children?: ReactNode;
};

export function AppShell(props: AppShellProps): ReactNode {
  const renderer = useRenderer();
  // The subscription. `useTerminalDimensions` is what re-renders this tree on a
  // resize; the renderer's own terminal size is read during that render rather
  // than subscribed to separately, so there is one resize path and not two that
  // could arrive a frame apart.
  const dimensions = useTerminalDimensions();
  const viewport: Viewport = { columns: dimensions.width, rows: dimensions.height };
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

  const frame: Frame = { theme, viewport, terminal, layout, cache: cache.current };

  return (
    <FrameProvider value={frame}>
      {layout.kind === "insufficient" ? (
        <MinimumSizeNotice viewport={terminal} decision={layout} />
      ) : (
        <ShellFrame model={props.model} viewport={viewport} layout={layout}>
          {props.children}
        </ShellFrame>
      )}
    </FrameProvider>
  );
}

function ShellFrame(props: {
  readonly model: ShellModel;
  readonly viewport: Viewport;
  readonly layout: Extract<LayoutDecision, { kind: "layout" }>;
  readonly children?: ReactNode;
}): ReactNode {
  const { model } = props;
  // Bounded rather than stretched. A `wide` terminal has room for a contextual
  // panel, and until #25 puts one there the right thing to do with the extra
  // columns is not to run prose across all of them — a 300-column line is a
  // line nobody can track back to its start.
  const primary = primaryColumns(props.viewport, props.layout.class);

  return (
    <box flexDirection="column" width={props.viewport.columns} height={props.viewport.rows}>
      <WorkspaceHeader model={model.header} />
      <box flexGrow={1} flexDirection="column" width={primary}>
        {model.overlay.kind === "none" ? (
          props.children
        ) : (
          <OverlayHost
            route={model.overlay}
            title={model.overlay.kind === "help" ? "Help" : "Commands"}
            dismissHint="Esc closes this"
          >
            {model.overlay.kind === "help" ? (
              <HelpOverlay sections={model.help} />
            ) : (
              <CommandPalette commands={model.commands} />
            )}
          </OverlayHost>
        )}
      </box>
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
