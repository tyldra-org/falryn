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
import { fromRendererFailure, type ShutdownCoordinator } from "../application/index.ts";
import {
  buildIdentity,
  type CliStreams,
  FALRYN_VERSION,
  writeDiagnosticLine,
} from "../cli/index.ts";
import type { FalrynError } from "../domain/index.ts";
import type { ShellCapabilities } from "./capabilities.ts";
import {
  nothingToRestore,
  openRendererSession,
  type RendererFactory,
  type RendererSession,
} from "./renderer-session.ts";
import { selectScreenMode } from "./screen-mode.ts";
import { ShellView, type ShellViewModel } from "./shell-view.tsx";
import { createTerminalShutdownParticipant } from "./shutdown.ts";

export type ShellRunRequest = {
  readonly streams: CliStreams;
  readonly capabilities: ShellCapabilities;
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

  let paused = false;
  const unsubscribe = session.onResize((capabilities) => {
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
    root.render(<ShellView model={viewModel(capabilities, session)} />);
  });

  try {
    root.render(<ShellView model={viewModel(session.capabilities(), session)} />);
    await settled(request.stop, lost.signal);

    if (lost.signal.aborted && !request.stop.aborted) {
      return {
        kind: "failed",
        error: fromRendererFailure({ code: "lost", detail: null }),
      };
    }
    return request.stop.aborted ? { kind: "stopped" } : { kind: "closed" };
  } finally {
    unsubscribe();
    session.renderer.off("destroy", onDestroy);
    unmount(root, request.streams);
  }
}

function viewModel(capabilities: ShellCapabilities, session: RendererSession): ShellViewModel {
  return {
    version: `${FALRYN_VERSION} (${buildIdentity().mode})`,
    mode: session.renderer.screenMode,
    // Never `?? 80`. The shell only draws when the record has a size, so the
    // fallback here is a value that could never be laid out against by accident.
    columns: capabilities.columns ?? 0,
    rows: capabilities.rows ?? 0,
  };
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
