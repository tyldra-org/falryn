/**
 * The interactive shell, start to finish.
 *
 * This is the only module that composes a renderer, a React root, and the
 * invocation's stop signal, and it is deliberately shaped like `dispatch`: open,
 * run, tear down, report. Everything it composes is separately testable — the
 * launch decision, the capability record, mode selection, and the session's
 * restoration each answer on their own — so what is left here is the wiring and
 * the one thing wiring is uniquely able to get wrong, which is the order things
 * are released in.
 *
 * It ends in exactly one way in this build: something stopped it. There is no
 * composer, no command, and no quit binding yet, so the shell runs until the
 * invocation's scope is cancelled by an interrupt, or its `--timeout` deadline
 * passes, or the renderer goes away underneath it. The seam for the shell
 * closing itself exists and is reported distinctly, because #26 will use it and
 * a caller that could not tell the two apart would report a deliberate quit as a
 * cancellation.
 *
 * Nothing here calls `process.exit()`. Teardown is not something to be skipped
 * to exit faster — it is the reason the user gets their terminal back.
 *
 * This module reaches OpenTUI's runtime. `src/cli/dispatch.ts` imports it
 * dynamically, so a run the launch decision refused never evaluates it and never
 * loads the native library.
 */

import { createRoot, type Root } from "@opentui/react";
import type { ReactNode } from "react";
import {
  fromRendererFailure,
  type ScopeTree,
  type ShutdownCoordinator,
} from "../application/index.ts";
import {
  type CliStreams,
  type GlobalOptions,
  resolveColor,
  writeDiagnosticLine,
} from "../cli/index.ts";
import type { EnvironmentPort, FalrynError } from "../domain/index.ts";
import {
  prefersConservativeSymbols,
  prefersReducedMotion,
  requestedVariant,
} from "./appearance.ts";
import type { ShellCapabilities } from "./capabilities.ts";
import { ShellApp } from "./components/shell-app.tsx";
import {
  nothingToRestore,
  openRendererSession,
  type RendererFactory,
  type RendererSession,
} from "./renderer-session.ts";
import { type RuntimeFeed, runtimeFeed, useRuntimeProjection } from "./runtime-feed.ts";
import { selectScreenMode } from "./screen-mode.ts";
import { shellModel } from "./shell-model.ts";
import { createTerminalShutdownParticipant } from "./shutdown.ts";
import { selectVariant, type ThemeRequest } from "./theme/index.ts";

export type ShellRunRequest = {
  readonly streams: CliStreams;
  readonly capabilities: ShellCapabilities;
  /** The parsed options. `--color` and `--workspace` both reach the frame. */
  readonly options: GlobalOptions;
  /** Read for the appearance preferences, and for nothing else. */
  readonly environment: EnvironmentPort;
  /** Aborts when the invocation's scope stops: an interrupt, or a deadline. */
  readonly stop: AbortSignal;
  /**
   * Where the `restore-terminal` participant is registered.
   *
   * Optional because a caller that composed no runtime lifecycle has no
   * coordinator to register with, and the shell still restores on its own way
   * out. The participant is what covers the paths the shell never returns
   * from — an escalated interrupt, a forced shutdown — rather than the ones it
   * does.
   */
  readonly shutdown?: ShutdownCoordinator;
  /**
   * The scope tree this invocation is running inside.
   *
   * Read-only here, and only for the rail: the shell folds its ordered events
   * into the activity projection. Optional for the same reason `shutdown` is —
   * a caller that composed no runtime has none — and an absent tree is reported
   * as nothing attached rather than as nothing happening.
   */
  readonly scopes?: ScopeTree;
  /** Supplied by tests, so a shell run needs no terminal and no native library. */
  readonly createRenderer?: RendererFactory;
};

export type ShellRun =
  /** The scope stopped it. The caller resolves the outcome from the scope. */
  | { readonly kind: "stopped" }
  /** The shell ended itself. Reserved for #26; nothing produces it today. */
  | { readonly kind: "closed" }
  /** The renderer never started, or went away underneath the shell. */
  | { readonly kind: "failed"; readonly error: FalrynError };

/**
 * Runs the shell until something stops it.
 *
 * Never throws. Every failure the renderer can produce is returned as a typed
 * error, because the caller has to restore the terminal, emit a plain
 * diagnostic, and resolve an exit status — none of which it can do from inside a
 * stack unwind.
 */
export async function runShell(request: ShellRunRequest): Promise<ShellRun> {
  const selection = selectScreenMode(request.capabilities);

  const opened = await openRendererSession({
    capabilities: request.capabilities,
    selection,
    ...(request.createRenderer === undefined ? {} : { createRenderer: request.createRenderer }),
  });

  if (!opened.ok) {
    // Registered and run even though there is nothing to give back. A failure
    // path that skips restoration is the one path where the terminal is most
    // likely to already be half-configured, and "nothing to restore" is a fact
    // the report should state rather than an absence nobody recorded.
    const terminal = nothingToRestore();
    register(request.shutdown, terminal);
    terminal.restore();
    return { kind: "failed", error: fromRendererFailure(opened.error) };
  }

  const session = opened.value;
  register(request.shutdown, session);

  try {
    return await drive(session, request);
  } finally {
    // Always, on every path including a throw from React. The renderer is
    // released after the tree is unmounted, never before: unmounting into a
    // destroyed renderer is a second failure on top of the first.
    session.restore();
  }
}

/** Mounts the tree, keeps it current, and waits for something to end the run. */
async function drive(session: RendererSession, request: ShellRunRequest): Promise<ShellRun> {
  const root = createRoot(session.renderer);
  // A renderer that tore itself down — an unhandled rejection reached OpenTUI's
  // own handler, or the host stream went away — must not leave the shell waiting
  // on a stop signal that is never coming.
  const lost = new AbortController();
  const onDestroy = (): void => lost.abort();
  session.renderer.on("destroy", onDestroy);

  // The shell ending itself. #23 built this seam and nothing reached it: the
  // scope stopping was the only way out, and on a terminal in raw mode — where
  // Ctrl+C arrives as a byte rather than as `SIGINT` — that meant killing the
  // process from another window. `app.exit` aborts this.
  const closed = new AbortController();

  let paused = false;
  const unsubscribe = session.onResize(() => {
    // Only the pause decision. The tree re-renders itself: `AppShell` measures
    // the viewport through the renderer, so a resize reaches every component
    // that cares without this having to re-render anything — and without the
    // overlay route, the theme, or the cache passing through a re-render that
    // could drop them.
    if (!session.isRenderable()) {
      // Zero or transient dimensions: stop drawing, keep everything. The session
      // is not torn down and the tree is not unmounted, so the terminal coming
      // back is a repaint rather than a restart.
      if (!paused) {
        paused = true;
        session.renderer.pause();
      }
      return;
    }
    if (paused) {
      paused = false;
      session.renderer.resume();
    }
  });

  try {
    root.render(await frameFor(session, request, () => closed.abort()));
    await settled(request.stop, lost.signal, closed.signal);

    if (lost.signal.aborted && !request.stop.aborted && !closed.signal.aborted) {
      return {
        kind: "failed",
        error: fromRendererFailure({ code: "lost", detail: null }),
      };
    }
    // A deliberate quit outranks the stop signal: pressing the exit key and an
    // interrupt arriving in the same moment is one departure, and the user's own
    // is the one to report.
    return closed.signal.aborted ? { kind: "closed" } : { kind: "stopped" };
  } finally {
    unsubscribe();
    session.renderer.off("destroy", onDestroy);
    unmount(root, request.streams);
  }
}

/**
 * How long to wait for the terminal to say whether it is light or dark.
 *
 * Bounded and short. The answer decides the palette, so waiting for it means the
 * first painted frame is not the wrong one — but a terminal that never answers
 * must not hold the interface closed, and most do not answer at all.
 */
const THEME_QUERY_TIMEOUT_MS = 120;

/** The whole tree, with the theme resolved from what this terminal reported. */
async function frameFor(session: RendererSession, request: ShellRunRequest, onExit: () => void) {
  const { capabilities, environment, options } = request;

  // Asked before the first paint rather than reacted to afterwards. A frame
  // painted dark and corrected to light a moment later is a visible flash, and
  // it happens on exactly the terminals that answered correctly.
  const prefers = await session.renderer.waitForThemeMode(THEME_QUERY_TIMEOUT_MS);

  const theme = {
    variant: selectVariant({
      requested: requestedVariant(environment),
      terminalPrefers: prefers,
    }),
    // The resolved level, after `--color`. The raw capability would put colour
    // on a run that asked for none.
    colorLevel: resolveColor(options.color, capabilities.handles.stdout.color),
    symbols: capabilities.handles.stdout.symbols,
    conservativeSymbols: prefersConservativeSymbols(capabilities),
    reducedMotion: prefersReducedMotion(environment, capabilities),
    generation: capabilities.generation,
  } satisfies ThemeRequest;

  const {
    overlay: _overlay,
    commands: _commands,
    transcript: _transcript,
    ...model
  } = shellModel(options);

  // No transcript is supplied because nothing produces one: there is no agent
  // loop, provider, or tool runner in this build. The surface renders its empty
  // state, which names a command that runs — the placeholder line that used to
  // sit here named nothing and was the filler #355 removed.
  //
  // Activity is different, and that difference is #370: the runtime this shell
  // is running inside does exist, so the rail is fed from it rather than left
  // empty. `undefined` when the caller composed no scope tree.
  const feed = runtimeFeed({ scopes: request.scopes, shutdown: request.shutdown });

  return (
    <LiveShell
      theme={theme}
      model={model}
      onExit={onExit}
      {...(feed === undefined ? {} : { feed })}
    />
  );
}

/**
 * The shell, subscribed to the runtime.
 *
 * A component rather than a value because the tree is rendered once: `drive`
 * hands React one element and never hands it another, so anything that changes
 * during a run has to change from inside the tree. The subscription is here
 * rather than in `ShellApp` so that component stays something a test can hand a
 * projection to.
 */
function LiveShell(props: {
  readonly theme: ThemeRequest;
  readonly model: Parameters<typeof ShellApp>[0]["model"];
  readonly onExit: () => void;
  readonly feed?: RuntimeFeed;
}): ReactNode {
  const runtime = useRuntimeProjection(props.feed);
  return (
    <ShellApp
      theme={props.theme}
      model={props.model}
      onExit={props.onExit}
      activity={runtime.activity}
      {...(runtime.shutdown === null ? {} : { shutdown: runtime.shutdown })}
    />
  );
}

/**
 * Unmounts the React tree, reporting rather than propagating a teardown failure.
 *
 * A throw here would skip `session.restore()` in the caller's `finally`, which
 * is the one thing this whole area exists to guarantee happens.
 */
function unmount(root: Root, streams: CliStreams): void {
  try {
    root.unmount();
  } catch (thrown) {
    writeDiagnosticLine(
      streams,
      `The interface did not unmount cleanly: ${thrown instanceof Error ? thrown.message : "unknown failure"}`,
    );
  }
}

function register(
  coordinator: ShutdownCoordinator | undefined,
  terminal: Parameters<typeof createTerminalShutdownParticipant>[0],
): void {
  // A registration refused because shutdown had already begun is not worth
  // failing the run over: the shell restores on its own way out regardless, and
  // the coordinator refuses precisely because the phase may already have run.
  coordinator?.register(createTerminalShutdownParticipant(terminal));
}

/** Resolves once any of the given signals has aborted. */
function settled(...signals: readonly AbortSignal[]): Promise<void> {
  const any = AbortSignal.any([...signals]);
  if (any.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    any.addEventListener("abort", () => resolve(), { once: true });
  });
}
