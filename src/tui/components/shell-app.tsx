/**
 * The interactive root.
 *
 * `AppShell` is presentational: hand it a model and it draws a frame. This is
 * the component that gives it one that changes — it owns the runtime state,
 * builds the keymap over the live renderer, and derives the model from what the
 * user has done.
 *
 * The split is not ceremony. `AppShell` and every component under it stay
 * testable by handing them a value, and the whole of the interactive behavior
 * sits in one place that can be reasoned about without asking what a frame looks
 * like. It is also what let the theme, layout, and frame ship in #24 before any
 * of this existed.
 *
 * ## The keymap's failure mode
 *
 * `planKeymap` can refuse — a binding conflict, or a reserved command unbound.
 * It refuses by returning rather than throwing, and this component renders the
 * frame anyway with a notice saying what is wrong. A throw here would take the
 * renderer down mid-render and leave the terminal in raw mode, which is the
 * exact failure the reserved commands exist to prevent: refusing to start
 * because the way out is misconfigured would be the worst possible response.
 */

import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider, useActiveKeys, useKeymap } from "@opentui/keymap/react";
import { useRenderer } from "@opentui/react";
import { type ReactNode, useMemo } from "react";
import type {
  ArtifactViewer,
  FileAttachmentProbe,
  GitDashboard,
  MidTurnInputService,
} from "../../application/index.ts";
import type { Instant } from "../../domain/index.ts";
import type {
  ActivityProjection,
  ShutdownState,
  TranscriptBlock,
  TranscriptProjection,
} from "../../presentation/index.ts";
import {
  blockKey,
  EMPTY_ACTIVITY,
  EMPTY_PROJECTION,
  includeBodiesOf,
  pickTranscriptIncludeBody,
  projectHealth,
} from "../../presentation/index.ts";
import { statusOfHealth } from "../activity/index.ts";
import type { ActivityModel } from "../activity-model.ts";
import type { CopyTextPort } from "../clipboard.ts";
import { searchCommands } from "../commands.ts";
import { COMPOSER_FEATURES, type SubmissionPort } from "../composer/index.ts";
import type { ComposerModel } from "../composer-model.ts";
import {
  type ConfirmationDecision,
  type ConfirmationPrompt,
  confirmationView,
} from "../confirmation/index.ts";
import { type ControlCatalog, EMPTY_CONTROL_CATALOG, projectHeader } from "../controls/index.ts";
import {
  activeCommandIds,
  commandRows,
  describeRefusal,
  type KeymapPlan,
  planKeymap,
} from "../keymap.ts";
import type { SessionCreationPort } from "../session-creation.ts";
import type { SessionNavigationController } from "../session-nav/index.ts";
import type { ThemeRequest } from "../theme/index.ts";
import { keysOf } from "../transcript/index.ts";
import type { TranscriptModel } from "../transcript-model.ts";
import type { ShellModel } from "../view-model.ts";
import {
  projectWorkspaceHeader,
  type WorkspaceController,
  type WorkspaceSetView,
} from "../workspace/index.ts";
import { AppShell } from "./app-shell.tsx";
import { KeymapBridge } from "./keymap-bridge.tsx";
import { ShellErrorBoundary } from "./shell-error-boundary.tsx";
import {
  activeContexts,
  COMPOSER_REGION,
  type ShellState,
  TRANSCRIPT_REGION,
  useShellRuntime,
} from "./shell-runtime.tsx";

export type ShellAppProps = {
  /** Everything that does not change with interaction: the header, the help prose. */
  readonly model: Omit<ShellModel, "overlay" | "commands" | "transcript" | "composer" | "activity">;
  readonly theme: ThemeRequest;
  /** Ends the session. Owned by the invocation's scope, not by this component. */
  readonly onExit: () => void;
  /** Present only in a composed interactive shell, never in a static frame. */
  readonly now?: () => Instant;
  /**
   * The transcript to project.
   *
   * A projection rather than a model: what the reader has done to it is this
   * component's runtime state, and a caller supplying both would be able to hand
   * the surface an expansion set for blocks that are not in the projection.
   */
  readonly transcript?: TranscriptProjection;
  /**
   * What the runtime is doing.
   *
   * A projection rather than a model, for the reason the transcript prop gives:
   * health is derived from it and from the runtime's own reports, and a caller
   * supplying both could hand the rail a health level that disagrees with the
   * entries beside it.
   */
  readonly activity?: ActivityProjection;
  /**
   * What the shutdown coordinator says, when one is attached.
   *
   * The narrow two-field state rather than the coordinator, because a component
   * holding the coordinator could start a shutdown, and a status line that can
   * tear the process down is a status line that eventually will. `undefined`
   * means no coordinator — which `projectHealth` reports as nothing attached
   * rather than as nothing wrong.
   */
  readonly shutdown?: ShutdownState;
  /** Resolves `@path` mentions and file attachments. Absent when no workspace is bound. */
  readonly fileProbe?: FileAttachmentProbe | null;
  /**
   * A confirmation the application is waiting on.
   *
   * Fixture-driven in this build: nothing produces one from a live tool yet.
   * Identity is the prompt's id and fingerprint; a changed fingerprint is a
   * new decision, not a reused approval.
   */
  readonly confirmation?: ConfirmationPrompt | null;
  readonly onConfirmation?: (decision: ConfirmationDecision) => void;
  readonly onSecretSubmit?: (secret: string) => void;
  /** Plain-print fallback when clipboard copy is unavailable (#623). */
  readonly copyPlainPrint?: (text: string) => boolean;
  /**
   * Session, model, context, and resource facts.
   *
   * The product launch projects the selected provider's live model catalog;
   * tests and unconfigured hosts may still supply an empty catalog. Selection
   * is a process-local cursor over these lists.
   */
  readonly controls?: ControlCatalog;
  /** Loads artifact views for the code viewer overlay. Absent in static frames. */
  readonly artifactViewer?: ArtifactViewer;
  /** Git changes dashboard. Absent in static frames and tests that do not need it. */
  readonly gitDashboard?: GitDashboard;
  /** Application-backed workspace-set mutations (#607). */
  readonly workspaceController?: WorkspaceController;
  readonly workspace?: WorkspaceSetView;
  /** Application-backed session navigation (#722). */
  readonly sessionNavigationController?: SessionNavigationController;
  readonly sessionCreation?: SessionCreationPort;
  /** Mid-turn classification while a turn is in flight (#612). */
  readonly midTurn?: MidTurnInputService;
  /** Product agent submission port (#707). Absent keeps UNAVAILABLE_SUBMISSION. */
  readonly submission?: SubmissionPort;
};

/**
 * An empty plan, for the run whose keymap was refused.
 *
 * No bindings rather than a partial set: a keymap with a conflict in it has an
 * unreachable command, and guessing which one to drop would make the interface
 * behave differently from what help says. The notice carries the reason and
 * every command stays reachable from the palette.
 */
const NO_BINDINGS: KeymapPlan = { bindings: [], unbound: [] };

export function ShellApp(props: ShellAppProps): ReactNode {
  const renderer = useRenderer();
  // `createDefault…` rather than `createOpenTuiKeymap`: the plain constructor
  // returns a keymap with no binding parsers registered, so the first
  // `registerLayer` throws "No keymap binding parsers are registered" — inside a
  // React effect, where nothing surfaces it. The shell shipped with every key
  // silently dead for exactly that reason.
  const keymap = useMemo(() => createDefaultOpenTuiKeymap(renderer), [renderer]);

  const verdict = useMemo(() => planKeymap(), []);
  const plan = verdict.ok ? verdict.plan : NO_BINDINGS;
  const refusal = verdict.ok
    ? null
    : `The keymap was refused: ${verdict.refusals.map(describeRefusal).join("; ")}.`;

  const projection = props.transcript ?? EMPTY_PROJECTION;
  const transcriptKeys = useMemo(() => keysOf(projection.blocks), [projection.blocks]);

  const copyPort = useMemo(
    (): CopyTextPort => ({
      tryClipboard: (text) => renderer.copyToClipboardOSC52(text),
      plainPrint: props.copyPlainPrint ?? (() => false),
    }),
    [renderer, props.copyPlainPrint],
  );

  const runtime = useShellRuntime({
    onExit: props.onExit,
    transcriptKeys,
    transcriptBlocks: projection.blocks,
    copyPort,
    ...(props.fileProbe === undefined ? {} : { fileProbe: props.fileProbe }),
    ...(props.confirmation === undefined ? {} : { confirmation: props.confirmation }),
    ...(props.onConfirmation === undefined ? {} : { onConfirmation: props.onConfirmation }),
    ...(props.onSecretSubmit === undefined ? {} : { onSecretSubmit: props.onSecretSubmit }),
    ...(props.workspace === undefined ? {} : { workspace: props.workspace }),
    ...(props.workspaceController === undefined
      ? {}
      : { workspaceController: props.workspaceController }),
    ...(props.sessionNavigationController === undefined
      ? {}
      : { sessionNavigationController: props.sessionNavigationController }),
    ...(props.sessionCreation === undefined ? {} : { sessionCreation: props.sessionCreation }),
    ...(props.midTurn === undefined ? {} : { midTurn: props.midTurn }),
    ...(props.submission === undefined ? {} : { submission: props.submission }),
  });
  const activityProjection = props.activity ?? EMPTY_ACTIVITY;
  const shutdown = props.shutdown ?? null;
  const activity: ActivityModel = useMemo(
    () => ({
      projection: activityProjection,
      // Projected once, here, so the rail and the status line cannot disagree
      // about how the run is going. The scheduler and the queue are still
      // absent in this build and stay `null` — saying so is what makes their
      // half of the answer honest rather than a green tick — while the scopes
      // and the shutdown coordinator are what the shell actually holds.
      health: projectHealth({
        activity: activityProjection,
        scheduler: null,
        queue: null,
        shutdown,
        configuration: null,
      }),
    }),
    [activityProjection, shutdown],
  );

  return (
    <KeymapProvider keymap={keymap}>
      <KeymapBridge
        plan={plan}
        contexts={activeContexts(runtime.state)}
        run={runtime.run}
        // The palette is a text control too, so a bare `?` types a question
        // mark into the search rather than opening help over it.
        typing={
          runtime.state.focus.focused === COMPOSER_REGION ||
          runtime.state.overlay.kind === "palette" ||
          (runtime.state.overlay.kind === "workspace" &&
            (runtime.state.overlay.panel === "add" || runtime.state.overlay.panel === "save")) ||
          (runtime.state.overlay.kind === "session-nav" &&
            runtime.state.overlay.panel === "rewind") ||
          (runtime.state.overlay.kind === "confirm" &&
            runtime.state.boundConfirmation?.secret !== null)
        }
      />
      <ShellErrorBoundary>
        <ResolvedShell
          {...props}
          refusal={refusal}
          projection={projection}
          activityModel={activity}
          runtime={runtime}
        />
      </ShellErrorBoundary>
    </KeymapProvider>
  );
}

function ResolvedShell(
  props: ShellAppProps & {
    readonly refusal: string | null;
    readonly projection: TranscriptProjection;
    readonly activityModel: ActivityModel;
    readonly runtime: ReturnType<typeof useShellRuntime>;
  },
): ReactNode {
  const keymap = useKeymap();
  const activeKeys = useActiveKeys({ includeBindings: true });
  const rows = commandRows(props.runtime.commandState, activeCommandIds(activeKeys));
  const composer: ComposerModel = {
    state: props.runtime.state.composer,
    commands: rows,
    features: COMPOSER_FEATURES,
    focused: props.runtime.state.focus.focused === COMPOSER_REGION,
  };
  const transcript: TranscriptModel = {
    projection: props.projection,
    surface: props.runtime.state.transcript,
    commands: rows,
    emptyStateCommand: "app.help",
    focused: props.runtime.state.focus.focused === TRANSCRIPT_REGION,
    selectableBody: selectableBodyOf(
      props.runtime.state,
      props.projection.blocks.map((entry) => entry),
    ),
    onBodyRenderable: props.runtime.registerTranscriptBody,
  };
  const catalog = props.controls ?? EMPTY_CONTROL_CATALOG;
  const model: ShellModel = {
    ...props.model,
    header: projectWorkspaceHeader(
      projectHeader(props.model.header, catalog, {
        sessionId: props.runtime.state.selectedSessionId,
        modelId: props.runtime.state.selectedModelId,
      }),
      props.runtime.commandState.hasWorkspaceSet ? props.runtime.state.workspace : null,
    ),
    transcript,
    composer,
    activity: props.activityModel,
    overlay: props.runtime.state.overlay,
    commands:
      props.runtime.state.overlay.kind === "palette"
        ? paletteRows(rows, props.runtime.state.overlay.query)
        : [],
    status: {
      ...props.model.status,
      status: statusOfHealth(props.activityModel.health.level),
      message: props.activityModel.health.headline,
      ...(props.refusal !== null
        ? { status: "error" as const, message: props.refusal }
        : props.runtime.state.notice !== null
          ? { status: "warning" as const, message: props.runtime.state.notice }
          : {}),
      hints: hintsFor(rows),
    },
    help: props.model.help,
  };

  return (
    <AppShell
      theme={props.theme}
      model={model}
      {...(props.now === undefined ? {} : { now: props.now })}
      commandRows={rows}
      onTranscriptGeometry={props.runtime.reportTranscriptGeometry}
      onComposerAction={props.runtime.composer}
      onComposerFocus={props.runtime.focusComposer}
      onPaletteQuery={props.runtime.paletteQuery}
      onPaletteSelect={(id) => {
        keymap.runCommand(id);
      }}
      confirmation={
        props.runtime.state.overlay.kind === "confirm" &&
        props.runtime.state.boundConfirmation !== null
          ? confirmationView(
              props.runtime.state.boundConfirmation,
              props.runtime.state.pendingConfirmation,
              props.runtime.state.secretGraphemes,
            )
          : null
      }
      onConfirmationChoice={(id) => {
        props.runtime.confirm(id);
      }}
      onSecretEdit={props.runtime.editSecret}
      controls={catalog}
      selectedSessionId={props.runtime.state.selectedSessionId}
      selectedModelId={props.runtime.state.selectedModelId}
      onControlSelect={(id) => {
        const overlay = props.runtime.state.overlay;
        if (overlay.kind !== "controls") {
          return;
        }
        if (overlay.panel === "session" || overlay.panel === "model") {
          props.runtime.selectControl(overlay.panel, id);
        }
      }}
      {...(props.artifactViewer === undefined ? {} : { artifactViewer: props.artifactViewer })}
      {...(props.gitDashboard === undefined ? {} : { gitDashboard: props.gitDashboard })}
      onChangesSettled={props.runtime.settleChanges}
      {...(props.workspaceController === undefined
        ? {}
        : { workspaceController: props.workspaceController })}
      workspace={props.runtime.state.workspace}
      onWorkspaceDraft={props.runtime.workspaceDraft}
      onWorkspaceReplace={props.runtime.replaceWorkspace}
      onWorkspaceNotice={props.runtime.workspaceNotice}
      onWorkspaceClose={props.runtime.closeOverlay}
      {...(props.sessionNavigationController === undefined
        ? {}
        : { sessionNavigationController: props.sessionNavigationController })}
      onSessionNavDraft={props.runtime.sessionNavDraft}
      onSessionNavSession={props.runtime.sessionNavSession}
      onSessionNavNotice={props.runtime.sessionNavNotice}
      onSessionNavClose={props.runtime.closeOverlay}
      onTaskIntelligenceDraft={props.runtime.taskIntelligenceDraft}
      onTaskIntelligenceNotice={props.runtime.taskIntelligenceNotice}
      onTaskIntelligenceClose={props.runtime.closeOverlay}
    />
  );
}

/**
 * The keys the status line advertises.
 *
 * Drawn from the same rows help uses, and only the ones that currently run —
 * a hint for an unavailable command is a promise the interface cannot keep, and
 * the status line is the worst place to make one because it is always visible.
 */
function hintsFor(
  rows: readonly {
    id: string;
    title: string;
    binding: string | null;
    unavailableReason: string | null;
  }[],
) {
  const shown = ["app.exit", "app.help", "app.commandPalette"];
  return shown
    .map((id) => rows.find((row) => row.id === id))
    .filter((row) => row !== undefined && row.binding !== null && row.unavailableReason === null)
    .map((row) => ({
      keys: displayKey(row?.binding ?? ""),
      command: (row?.title ?? "").toLowerCase(),
    }));
}

/**
 * A key as a person writes it.
 *
 * `ctrl+c` is what a binding is called; `^C` is what a status line has room for
 * and what every terminal user already reads. The mapping is here rather than in
 * the registry because it is presentation — help shows the binding's own name.
 */
export function displayKey(binding: string): string {
  const control = /^ctrl\+(.)$/.exec(binding);
  if (control !== null) {
    return `^${(control[1] ?? "").toUpperCase()}`;
  }
  return binding;
}

/**
 * Commands matching a palette query, as rows.
 *
 * The one narrowing rule, used by the shell above and asserted directly by the
 * palette's tests. Before #364 it had no product caller at all: the palette was
 * handed every row and a literal empty query, so typing could not narrow
 * anything and this function was a matcher nothing matched with.
 */
export function paletteRows(
  rows: readonly ReturnType<typeof commandRows>[number][],
  query: string,
) {
  const matching = new Set(searchCommands(query).map((command) => command.id));
  return rows.filter((row) => matching.has(row.id));
}

function selectableBodyOf(
  state: ShellState,
  blocks: readonly TranscriptBlock[],
): TranscriptModel["selectableBody"] {
  const key = state.transcript.selected;
  if (key === null || !state.transcript.expanded.has(key)) {
    return null;
  }
  if (state.focus.focused !== TRANSCRIPT_REGION) {
    return null;
  }
  const block = blocks.find((item) => blockKey(item.anchor) === key);
  if (block === undefined || includeBodiesOf(block).length !== 1) {
    return null;
  }
  const pick = pickTranscriptIncludeBody(block, true);
  if (!pick.ok) {
    return null;
  }
  return { key, text: pick.text };
}
