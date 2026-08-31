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
import type { ArtifactViewer, GitDashboard } from "../../application/index.ts";
import type { Instant } from "../../domain/index.ts";
import type { ComposerAction } from "../composer/index.ts";
import type { CompressionControlAction, CompressionControlState } from "../compression.ts";
import type { ConfirmationChoiceId, ConfirmationView, SecretEdit } from "../confirmation/index.ts";
import {
  CONTROL_PANEL_TITLES,
  type ControlCatalog,
  EMPTY_CONTROL_CATALOG,
} from "../controls/index.ts";
import { GitDashboardOverlay } from "../git/dashboard-overlay.tsx";
import {
  composerRows,
  hasContextPanel,
  type LayoutDecision,
  primaryColumns,
  primaryRows,
  selectLayout,
  type Viewport,
} from "../layout.ts";
import type { SessionNavigationController } from "../session-nav/index.ts";
import { SessionNavSheet, sessionNavPanelTitle } from "../session-nav/sheet.tsx";
import { TaskIntelligenceSheet, taskIntelligencePanelTitle } from "../task-intelligence/index.ts";
import { createTextCache } from "../text-cache.ts";
import { resolveTheme, type ThemeRequest } from "../theme/index.ts";
import { inspectionFor } from "../transcript/index.ts";
import type { TranscriptGeometry } from "../transcript-model.ts";
import type { CommandEntry, OverlayRoute, ShellModel } from "../view-model.ts";
import { ArtifactViewerOverlay } from "../viewer/artifact-viewer-overlay.tsx";
import type { WorkspaceController, WorkspaceSetView } from "../workspace/index.ts";
import { ActivityRail } from "./activity-rail.tsx";
import { ComposerView } from "./composer.tsx";
import { CompressionSheet } from "./compression-sheet.tsx";
import { ConfirmationSheet } from "./confirmation.tsx";
import { type Frame, FrameProvider } from "./context.tsx";
import { ControlSheet } from "./controls.tsx";
import { Inspector } from "./inspector.tsx";
import { OverlayHost } from "./overlay.tsx";
import { CommandPalette, HelpOverlay } from "./overlay-routes.tsx";
import { Line } from "./primitives.tsx";
import { StatusLine } from "./status-line.tsx";
import { TranscriptView } from "./transcript.tsx";
import { WorkspaceHeader } from "./workspace-header.tsx";
import { WorkspaceSheet, workspacePanelTitle } from "./workspace-sheet.tsx";

export type AppShellProps = {
  readonly model: ShellModel;
  /** Present only when a composed shell supplies the invocation clock. */
  readonly now?: () => Instant;
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
  readonly onPaletteQuery?: (query: string) => void;
  /** Runs the selected palette command by stable id. */
  readonly onPaletteSelect?: (id: string) => void;
  readonly confirmation?: ConfirmationView | null;
  readonly onConfirmationChoice?: (id: ConfirmationChoiceId) => void;
  readonly onSecretEdit?: (edit: SecretEdit) => void;
  readonly controls?: ControlCatalog;
  readonly selectedSessionId?: string | null;
  readonly selectedModelKey?: string | null;
  readonly selectedProfileId?: string | null;
  readonly onControlSelect?: (id: string) => void;
  readonly compression?: CompressionControlState;
  readonly onCompressionSelect?: (action: CompressionControlAction) => void;
  /** Loads artifact views for the code viewer overlay. Absent in static frames. */
  readonly artifactViewer?: ArtifactViewer;
  /** Observes Git status, worktrees, and checkpoints. Absent in static frames. */
  readonly gitDashboard?: GitDashboard;
  readonly onChangesSettled?: (notice: string) => void;
  /** Application-backed workspace-set mutations. Absent when no set is attached. */
  readonly workspaceController?: WorkspaceController;
  readonly workspace?: WorkspaceSetView;
  readonly onWorkspaceDraft?: (draft: string) => void;
  readonly onWorkspaceReplace?: (set: WorkspaceSetView, notice: string) => void;
  readonly onWorkspaceNotice?: (message: string) => void;
  readonly onWorkspaceClose?: () => void;
  /** Application-backed session navigation (#722). Absent when no store is attached. */
  readonly sessionNavigationController?: SessionNavigationController;
  readonly onSessionNavDraft?: (draft: string) => void;
  readonly onSessionNavSession?: (sessionId: string) => void;
  readonly onSessionNavNotice?: (message: string) => void;
  readonly onSessionNavClose?: () => void;
  readonly onTaskIntelligenceDraft?: (draft: string) => void;
  readonly onTaskIntelligenceNotice?: (message: string) => void;
  readonly onTaskIntelligenceClose?: () => void;
};

export function AppShell(props: AppShellProps): ReactNode {
  const renderer = useRenderer();
  // The subscription. `useTerminalDimensions` is what re-renders this tree on a
  // resize; the renderer's own terminal size is read during that render rather
  // than subscribed to separately, so there is one resize path and not two that
  // could arrive a frame apart.
  // Called for its subscription, not for its value: it is what re-renders this
  // tree on a resize. Falryn always uses OpenTUI's alternate screen, so the
  // renderer's drawable region is the terminal's full viewport.
  useTerminalDimensions();
  const viewport: Viewport = { columns: renderer.width, rows: renderer.height };
  const terminal: Viewport = {
    columns: renderer.terminalWidth,
    rows: renderer.terminalHeight,
  };
  const layout = selectLayout(viewport);

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
      {layout.kind === "insufficient" ? (
        <MinimumSizeNotice viewport={viewport} decision={layout} />
      ) : (
        <ShellFrame
          model={props.model}
          viewport={viewport}
          layout={layout}
          commandRows={props.commandRows ?? []}
          {...(props.now === undefined ? {} : { now: props.now })}
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
          {...(props.onPaletteSelect === undefined
            ? {}
            : { onPaletteSelect: props.onPaletteSelect })}
          {...(props.confirmation === undefined ? {} : { confirmation: props.confirmation })}
          {...(props.onConfirmationChoice === undefined
            ? {}
            : { onConfirmationChoice: props.onConfirmationChoice })}
          {...(props.onSecretEdit === undefined ? {} : { onSecretEdit: props.onSecretEdit })}
          {...(props.controls === undefined ? {} : { controls: props.controls })}
          {...(props.selectedSessionId === undefined
            ? {}
            : { selectedSessionId: props.selectedSessionId })}
          {...(props.selectedModelKey === undefined
            ? {}
            : { selectedModelKey: props.selectedModelKey })}
          {...(props.selectedProfileId === undefined
            ? {}
            : { selectedProfileId: props.selectedProfileId })}
          {...(props.onControlSelect === undefined
            ? {}
            : { onControlSelect: props.onControlSelect })}
          {...(props.compression === undefined ? {} : { compression: props.compression })}
          {...(props.onCompressionSelect === undefined
            ? {}
            : { onCompressionSelect: props.onCompressionSelect })}
          {...(props.artifactViewer === undefined ? {} : { artifactViewer: props.artifactViewer })}
          {...(props.gitDashboard === undefined ? {} : { gitDashboard: props.gitDashboard })}
          {...(props.onChangesSettled === undefined
            ? {}
            : { onChangesSettled: props.onChangesSettled })}
          {...(props.workspaceController === undefined
            ? {}
            : { workspaceController: props.workspaceController })}
          {...(props.workspace === undefined ? {} : { workspace: props.workspace })}
          {...(props.onWorkspaceDraft === undefined
            ? {}
            : { onWorkspaceDraft: props.onWorkspaceDraft })}
          {...(props.onWorkspaceReplace === undefined
            ? {}
            : { onWorkspaceReplace: props.onWorkspaceReplace })}
          {...(props.onWorkspaceNotice === undefined
            ? {}
            : { onWorkspaceNotice: props.onWorkspaceNotice })}
          {...(props.onWorkspaceClose === undefined
            ? {}
            : { onWorkspaceClose: props.onWorkspaceClose })}
          {...(props.sessionNavigationController === undefined
            ? {}
            : { sessionNavigationController: props.sessionNavigationController })}
          {...(props.onSessionNavDraft === undefined
            ? {}
            : { onSessionNavDraft: props.onSessionNavDraft })}
          {...(props.onSessionNavSession === undefined
            ? {}
            : { onSessionNavSession: props.onSessionNavSession })}
          {...(props.onSessionNavNotice === undefined
            ? {}
            : { onSessionNavNotice: props.onSessionNavNotice })}
          {...(props.onSessionNavClose === undefined
            ? {}
            : { onSessionNavClose: props.onSessionNavClose })}
          {...(props.onTaskIntelligenceDraft === undefined
            ? {}
            : { onTaskIntelligenceDraft: props.onTaskIntelligenceDraft })}
          {...(props.onTaskIntelligenceNotice === undefined
            ? {}
            : { onTaskIntelligenceNotice: props.onTaskIntelligenceNotice })}
          {...(props.onTaskIntelligenceClose === undefined
            ? {}
            : { onTaskIntelligenceClose: props.onTaskIntelligenceClose })}
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
  readonly now?: () => Instant;
  readonly onTranscriptGeometry?: (geometry: TranscriptGeometry) => void;
  readonly onComposerAction?: (action: ComposerAction) => void;
  /** A click in the composer focuses it, through the shell's own focus model. */
  readonly onComposerFocus?: () => void;
  readonly onPaletteQuery?: (query: string) => void;
  readonly onPaletteSelect?: (id: string) => void;
  readonly confirmation?: ConfirmationView | null;
  readonly onConfirmationChoice?: (id: ConfirmationChoiceId) => void;
  readonly onSecretEdit?: (edit: SecretEdit) => void;
  readonly controls?: ControlCatalog;
  readonly selectedSessionId?: string | null;
  readonly selectedModelKey?: string | null;
  readonly selectedProfileId?: string | null;
  readonly onControlSelect?: (id: string) => void;
  readonly compression?: CompressionControlState;
  readonly onCompressionSelect?: (action: CompressionControlAction) => void;
  readonly artifactViewer?: ArtifactViewer;
  readonly gitDashboard?: GitDashboard;
  readonly onChangesSettled?: (notice: string) => void;
  readonly workspaceController?: WorkspaceController;
  readonly workspace?: WorkspaceSetView;
  readonly onWorkspaceDraft?: (draft: string) => void;
  readonly onWorkspaceReplace?: (set: WorkspaceSetView, notice: string) => void;
  readonly onWorkspaceNotice?: (message: string) => void;
  readonly onWorkspaceClose?: () => void;
  readonly sessionNavigationController?: SessionNavigationController;
  readonly onSessionNavDraft?: (draft: string) => void;
  readonly onSessionNavSession?: (sessionId: string) => void;
  readonly onSessionNavNotice?: (message: string) => void;
  readonly onSessionNavClose?: () => void;
  readonly onTaskIntelligenceDraft?: (draft: string) => void;
  readonly onTaskIntelligenceNotice?: (message: string) => void;
  readonly onTaskIntelligenceClose?: () => void;
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
              title={overlayTitle(model.overlay, model, props.confirmation ?? null)}
              dismissHint={
                model.overlay.kind === "confirm" ? "Esc declines this" : "Esc closes this"
              }
            >
              {(rows) => overlayBody(model, props, rows)}
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
        {...(props.now === undefined ? {} : { now: props.now })}
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

function overlayTitle(
  route: OverlayRoute,
  model: ShellModel,
  confirmation: ConfirmationView | null,
): string {
  switch (route.kind) {
    case "none":
      return "";
    case "help":
      return "Help";
    case "palette":
      return "Commands";
    case "inspect":
      return inspectionFor(model.transcript.projection.blocks, route.key)?.title ?? "Inspect";
    case "confirm":
      return confirmation?.prompt.title ?? "Confirm";
    case "controls":
      return CONTROL_PANEL_TITLES[route.panel];
    case "compression":
      return "Compression";
    case "workspace":
      return workspacePanelTitle(route.panel);
    case "session-nav":
      return sessionNavPanelTitle(route.panel);
    case "task-intelligence":
      return taskIntelligencePanelTitle(route.panel);
    case "artifact":
      switch (route.presentation) {
        case "diff":
          return "Diff";
        case "document":
          return "Document";
        case "media":
          return "Media";
        case "diagnostic":
          return "Diagnostic";
        case "code":
          return "Source";
        default: {
          const exhaustive: never = route.presentation;
          return exhaustive;
        }
      }
    case "changes":
      return "Changes";
    default: {
      const exhaustive: never = route;
      return exhaustive;
    }
  }
}

function overlayBody(
  model: ShellModel,
  props: {
    readonly commandRows?: readonly CommandEntry[];
    readonly onPaletteQuery?: (query: string) => void;
    readonly onPaletteSelect?: (id: string) => void;
    readonly confirmation?: ConfirmationView | null;
    readonly onConfirmationChoice?: (id: ConfirmationChoiceId) => void;
    readonly onSecretEdit?: (edit: SecretEdit) => void;
    readonly controls?: ControlCatalog;
    readonly selectedSessionId?: string | null;
    readonly selectedModelKey?: string | null;
    readonly selectedProfileId?: string | null;
    readonly onControlSelect?: (id: string) => void;
    readonly compression?: CompressionControlState;
    readonly onCompressionSelect?: (action: CompressionControlAction) => void;
    readonly artifactViewer?: ArtifactViewer;
    readonly gitDashboard?: GitDashboard;
    readonly onChangesSettled?: (notice: string) => void;
    readonly workspaceController?: WorkspaceController;
    readonly workspace?: WorkspaceSetView;
    readonly onWorkspaceDraft?: (draft: string) => void;
    readonly onWorkspaceReplace?: (set: WorkspaceSetView, notice: string) => void;
    readonly onWorkspaceNotice?: (message: string) => void;
    readonly onWorkspaceClose?: () => void;
    readonly sessionNavigationController?: SessionNavigationController;
    readonly onSessionNavDraft?: (draft: string) => void;
    readonly onSessionNavSession?: (sessionId: string) => void;
    readonly onSessionNavNotice?: (message: string) => void;
    readonly onSessionNavClose?: () => void;
    readonly onTaskIntelligenceDraft?: (draft: string) => void;
    readonly onTaskIntelligenceNotice?: (message: string) => void;
    readonly onTaskIntelligenceClose?: () => void;
  },
  rows: number,
): ReactNode {
  const overlay = model.overlay;
  switch (overlay.kind) {
    case "none":
      return null;
    case "help":
      return <HelpOverlay sections={model.help} commands={props.commandRows ?? []} rows={rows} />;
    case "palette":
      return (
        <CommandPalette
          commands={model.commands}
          query={overlay.query}
          rows={rows}
          {...(props.onPaletteQuery === undefined ? {} : { onQuery: props.onPaletteQuery })}
          {...(props.onPaletteSelect === undefined ? {} : { onSelect: props.onPaletteSelect })}
        />
      );
    case "inspect":
      return (
        <Inspector
          inspection={inspectionFor(model.transcript.projection.blocks, overlay.key)}
          rows={rows}
        />
      );
    case "confirm":
      return (
        <ConfirmationSheet
          confirmation={props.confirmation ?? null}
          rows={rows}
          {...(props.onConfirmationChoice === undefined
            ? {}
            : { onChoice: props.onConfirmationChoice })}
          {...(props.onSecretEdit === undefined ? {} : { onSecretEdit: props.onSecretEdit })}
        />
      );
    case "controls":
      return (
        <ControlSheet
          catalog={props.controls ?? EMPTY_CONTROL_CATALOG}
          panel={overlay.panel}
          selectedId={
            overlay.panel === "session"
              ? (props.selectedSessionId ?? null)
              : overlay.panel === "model"
                ? (props.selectedModelKey ?? null)
                : overlay.panel === "profile"
                  ? (props.selectedProfileId ?? null)
                  : null
          }
          rows={rows}
          {...(props.onControlSelect === undefined ? {} : { onSelect: props.onControlSelect })}
        />
      );
    case "compression":
      return (
        <CompressionSheet
          state={props.compression ?? { brief: null, hush: null, loom: null }}
          rows={rows}
          {...(props.onCompressionSelect === undefined
            ? {}
            : { onSelect: props.onCompressionSelect })}
        />
      );
    case "workspace":
      if (props.workspaceController === undefined) {
        return (
          <Line color="error" typography="body" maxColumns={Math.max(8, rows)}>
            No workspace set is attached to this shell.
          </Line>
        );
      }
      return (
        <WorkspaceSheet
          panel={overlay.panel}
          draft={overlay.draft}
          workspace={props.workspace ?? { roots: [] }}
          controller={props.workspaceController}
          rows={rows}
          {...(props.onWorkspaceDraft === undefined ? {} : { onDraft: props.onWorkspaceDraft })}
          {...(props.onWorkspaceReplace === undefined
            ? {}
            : { onWorkspace: props.onWorkspaceReplace })}
          {...(props.onWorkspaceNotice === undefined ? {} : { onNotice: props.onWorkspaceNotice })}
          {...(props.onWorkspaceClose === undefined ? {} : { onClose: props.onWorkspaceClose })}
        />
      );
    case "session-nav":
      if (props.sessionNavigationController === undefined) {
        return (
          <Line color="error" typography="body" maxColumns={Math.max(8, rows)}>
            No session store is attached to this shell.
          </Line>
        );
      }
      return (
        <SessionNavSheet
          panel={overlay.panel}
          sessionId={overlay.sessionId}
          draft={overlay.draft}
          controller={props.sessionNavigationController}
          rows={rows}
          {...(props.onSessionNavDraft === undefined ? {} : { onDraft: props.onSessionNavDraft })}
          {...(props.onSessionNavSession === undefined
            ? {}
            : { onSession: props.onSessionNavSession })}
          {...(props.onSessionNavNotice === undefined
            ? {}
            : { onNotice: props.onSessionNavNotice })}
          {...(props.onSessionNavClose === undefined ? {} : { onClose: props.onSessionNavClose })}
        />
      );
    case "task-intelligence":
      return (
        <TaskIntelligenceSheet
          panel={overlay.panel}
          draft={overlay.draft}
          rows={rows}
          {...(props.onTaskIntelligenceDraft === undefined
            ? {}
            : { onDraft: props.onTaskIntelligenceDraft })}
          {...(props.onTaskIntelligenceNotice === undefined
            ? {}
            : { onNotice: props.onTaskIntelligenceNotice })}
          {...(props.onTaskIntelligenceClose === undefined
            ? {}
            : { onClose: props.onTaskIntelligenceClose })}
        />
      );
    case "artifact":
      if (props.artifactViewer === undefined) {
        return (
          <Line color="error" typography="body" maxColumns={Math.max(8, rows)}>
            No artifact viewer is attached to this shell.
          </Line>
        );
      }
      return (
        <ArtifactViewerOverlay
          artifactId={overlay.artifactId}
          presentation={overlay.presentation}
          layout={overlay.layout}
          hunkIndex={overlay.hunkIndex}
          viewer={props.artifactViewer}
          rows={rows}
        />
      );
    case "changes":
      if (props.gitDashboard === undefined) {
        return (
          <Line color="error" typography="body" maxColumns={Math.max(8, rows)}>
            No Git dashboard is attached to this shell.
          </Line>
        );
      }
      return (
        <GitDashboardOverlay
          key={overlay.generation}
          dashboard={props.gitDashboard}
          tab={overlay.tab}
          cursor={overlay.cursor}
          pending={overlay.pending}
          rows={rows}
          onSettled={props.onChangesSettled ?? (() => {})}
        />
      );
    default: {
      const exhaustive: never = overlay;
      return exhaustive;
    }
  }
}
