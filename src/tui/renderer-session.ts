/**
 * The one renderer, and the promise that the terminal is given back.
 *
 * Two guarantees live here and nowhere else.
 *
 * **Exactly one renderer per process.** OpenTUI's renderer takes exclusive
 * ownership of stdin and stdout, replaces `global.requestAnimationFrame`,
 * registers process listeners, and allocates native memory. A second one is not
 * a second view, it is two objects fighting over one terminal — so a second
 * creation attempt is reported as the defect it is rather than absorbed.
 *
 * **Restoration happens at most once in effect and any number of times safely.**
 * The terminal is a resource this process borrowed. Every exit path converges
 * here: clean return, first interrupt, escalated interrupt, deadline expiry,
 * renderer crash, and a renderer that failed before it ever drew. A user whose
 * terminal is left in raw mode with the alternate screen up and the cursor
 * hidden has to close the window, and that is the failure this module exists to
 * make impossible.
 *
 * What it does *not* do is write escape sequences. OpenTUI's `destroy()` owns
 * the sequences; this module owns *when* it runs and *that it runs once*. A
 * second sequence writer here would be a second answer to what "restored" means,
 * and `src/cli-boundaries.test.ts` already holds that line for the CLI.
 *
 * The renderer always owns the alternate screen. OpenTUI restores the user's
 * original main-screen scrollback when `destroy()` runs; Falryn supplies the
 * lifecycle ordering that makes that cleanup reliable.
 */

import type { CliRenderer, CliRendererConfig } from "@opentui/core";
import { createCliRenderer } from "@opentui/core";
import {
  err,
  ok,
  type RendererFailure,
  type Result,
  terminalSize,
  type Unsubscribe,
} from "../domain/index.ts";
import {
  type RendererCapabilities,
  type ShellCapabilities,
  usesMouse,
  withRendererCapabilities,
  withSize,
} from "./capabilities.ts";

/**
 * Terminal state the session asks for, so restoration can name what it gave back.
 *
 * The list is derived from the configuration actually passed rather than
 * asserted, so a mode nobody enabled is never reported as one that was restored.
 */
export const TERMINAL_MODES = [
  "raw-input",
  "alternate-screen",
  "mouse",
  "focus-events",
  "bracketed-paste",
  "cursor-visibility",
] as const;

export type TerminalMode = (typeof TERMINAL_MODES)[number];

/**
 * Resize settling, in milliseconds.
 *
 * Long enough that dragging a window edge does not produce a frame per pixel
 * column, short enough that letting go feels immediate. The latest dimensions
 * win: a resize is a fact about now, and an intermediate size is never worth
 * catching up to.
 */
export const RESIZE_DEBOUNCE_MS = 25;

export type RestorationReport = {
  /** What was given back. Empty when the session never enabled anything. */
  readonly modes: readonly TerminalMode[];
  /**
   * Whether this call is the one that did it.
   *
   * `false` on every call after the first. Both the shell's own teardown and
   * the `restore-terminal` shutdown participant call this, frequently at the
   * same time, and a report that could not distinguish them would make an
   * idempotent contract untestable.
   */
  readonly restoredNow: boolean;
  /** A safe description of a teardown that threw, or `null`. Never the error. */
  readonly failure: string | null;
};

/** Anything the shutdown participant can restore, including a failed session. */
export type RestorableTerminal = {
  restore(): RestorationReport;
  isRestored(): boolean;
};

export type RendererSession = RestorableTerminal & {
  readonly renderer: CliRenderer;
  /** The modes this session asked the terminal for. */
  readonly enabled: readonly TerminalMode[];
  /** The record, refreshed from the renderer and from every resize since. */
  capabilities(): ShellCapabilities;
  /**
   * Whether the terminal currently has a size worth drawing into.
   *
   * `false` pauses rendering rather than laying out against dimensions that do
   * not exist. State is preserved: the session is not torn down, it stops
   * drawing until the terminal reports a size again.
   */
  isRenderable(): boolean;
  /** Called after every settled resize, with the refreshed record. */
  onResize(listener: (capabilities: ShellCapabilities) => void): Unsubscribe;
};

export type RendererFactory = (config: CliRendererConfig) => Promise<CliRenderer>;

export type OpenSessionRequest = {
  readonly capabilities: ShellCapabilities;
  /**
   * Supplied by tests.
   *
   * A factory that throws when called is how "a machine-format or non-TTY run
   * creates no renderer at all" is proved rather than asserted.
   */
  readonly createRenderer?: RendererFactory;
  /**
   * Whether the user wants the interface to capture pointer input.
   *
   * One resolved boolean rather than the configuration map, so this area
   * interprets no key and never imports `src/config`. `undefined` is a caller
   * that resolved no configuration at all — every rendered check that mounts a
   * shell directly — and is off, because turning a user's terminal selection
   * over to Falryn is not something to infer from a missing value.
   */
  readonly pointer?: boolean;
};

/**
 * The renderer this process has open, if any.
 *
 * Module state, and that is the point: the constraint is per process, not per
 * caller, and a guard a caller could forget to consult would not be one.
 */
let open: RendererSession | null = null;

/** Whether a renderer is currently open. Exported so a control can prove the guard. */
export function hasOpenRendererSession(): boolean {
  return open !== null;
}

const MAX_FAILURE_DETAIL = 200;

function safeDetail(thrown: unknown): string | null {
  const raw = thrown instanceof Error ? thrown.message : null;
  if (raw === null || raw === "") {
    return null;
  }
  return raw.length > MAX_FAILURE_DETAIL ? `${raw.slice(0, MAX_FAILURE_DETAIL)}…` : raw;
}

/**
 * The renderer options that are not defaults, each for a stated reason.
 *
 * Four of OpenTUI's defaults would each install a second owner of something
 * Falryn already owns. Overriding them is not a preference, and #22 measured
 * that two of the overrides do what they say.
 */
export function rendererConfigFor(request: OpenSessionRequest): CliRendererConfig {
  const { capabilities } = request;
  return {
    // The default calls `renderer.destroy()` on Ctrl+C, which would bypass the
    // interrupt escalation in `src/application/interruption.ts` and the shutdown
    // coordinator entirely — a user's first interrupt would tear the renderer
    // down without draining, persisting, or checkpointing anything.
    exitOnCtrlC: false,
    // Signal handling belongs to `createProcessSignalPort` and
    // `createHostGovernance`. #22 measured that this leaves the process with
    // zero SIGINT and SIGTERM listeners of OpenTUI's own, and that the default
    // installs some.
    exitSignals: [],
    // Falryn's diagnostics go through the stderr boundary. An overlay capturing
    // `console.*` would be a second diagnostics path, reachable from code that
    // never asked for one.
    consoleMode: "disabled",
    // Preserve Command, Option, and Shift as modifiers wherever the terminal
    // supports Kitty keyboard reporting. Legacy aliases remain in the focused
    // controls for terminals that cannot report those modifiers directly.
    useKittyKeyboard: {},
    // Gated on the resolved setting rather than left at OpenTUI's default of
    // on, and decided here rather than after creation. #392 planned to enable
    // it later, once a refreshed record could say whether the terminal had a
    // mouse — and no such capability exists to wait for. See `usesMouse`.
    useMouse: usesMouse(capabilities, request.pointer),
    enableMouseMovement: false,
    // This is an intentional product choice rather than relying on OpenTUI's
    // current default. It gives every interactive run the full viewport and
    // lets `destroy()` restore the main-screen scrollback it borrowed.
    screenMode: "alternate-screen",
    // Capturing stdout is a split-footer-only OpenTUI feature. Falryn never
    // opens that mode, so stdout remains the process boundary's own handle.
    externalOutputMode: "passthrough",
    debounceDelay: RESIZE_DEBOUNCE_MS,
  };
}

/** The modes a configuration asks the terminal for. */
export function enabledModes(config: CliRendererConfig): readonly TerminalMode[] {
  const modes: TerminalMode[] = [
    // `setupTerminal()` puts stdin in raw mode and resumes it, unconditionally.
    "raw-input",
    "focus-events",
    "bracketed-paste",
    "cursor-visibility",
  ];
  modes.push("alternate-screen");
  if (config.useMouse === true) {
    modes.push("mouse");
  }
  return modes;
}

/** What a live renderer reports about the terminal it is attached to. */
export function observeRenderer(renderer: CliRenderer): RendererCapabilities {
  const reported = renderer.capabilities;
  return {
    screenMode: "alternate-screen",
    // The terminal's size. In Falryn's one screen mode it is also the drawable
    // region, but this record remains an observation rather than a layout input.
    columns: renderer.terminalWidth,
    rows: renderer.terminalHeight,
    mouse: renderer.useMouse,
    // A terminal that never answered the capability query leaves these false
    // rather than true: an unanswered question is not a yes.
    focusEvents: reported?.focus_tracking === true,
    bracketedPaste: reported?.bracketed_paste === true,
    kittyKeyboard: reported?.kitty_keyboard === true,
    hyperlinks: reported?.hyperlinks === true,
    synchronizedOutput: reported?.sync === true,
    themeMode: renderer.themeMode,
    remote: reported?.remote === true,
    multiplexer: reported?.multiplexer ?? null,
  };
}

/**
 * Opens the process's renderer.
 *
 * Failure is reported rather than thrown: a renderer that could not start is an
 * ordinary outcome on an unknown terminal, and the caller has to restore, emit a
 * plain diagnostic, and resolve an exit status — none of which it can do from
 * inside a stack unwind.
 */
export async function openRendererSession(
  request: OpenSessionRequest,
): Promise<Result<RendererSession, RendererFailure>> {
  if (open !== null) {
    return err({ code: "already-open", detail: null });
  }

  const config = rendererConfigFor(request);
  const modes = enabledModes(config);

  let renderer: CliRenderer;
  try {
    renderer = await (request.createRenderer ?? createCliRenderer)(config);
  } catch (thrown) {
    // `createCliRenderer` wraps `setupTerminal()` and calls `destroy()` itself
    // when it throws, so there is nothing left holding the terminal. The caller
    // still runs its restoration, which finds nothing to give back and says so.
    return err({ code: "initialization-failed", detail: safeDetail(thrown) });
  }

  let record = withRendererCapabilities(request.capabilities, observeRenderer(renderer));
  let restored = false;
  let failure: string | null = null;
  const listeners = new Set<(capabilities: ShellCapabilities) => void>();

  const onResize = (columns: number, rows: number): void => {
    // Through the domain's own bound, so a terminal reporting zero or an absurd
    // width produces "no size" rather than a size. Both are then carried into
    // the record, which is what pauses drawing without losing any state.
    record = withSize(record, terminalSize(columns), terminalSize(rows));
    for (const listener of listeners) {
      listener(record);
    }
  };
  renderer.on("resize", onResize);

  const session: RendererSession = {
    renderer,
    enabled: modes,

    capabilities: () => record,

    isRenderable: () => record.columns !== null && record.rows !== null,

    onResize(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    isRestored: () => restored,

    restore(): RestorationReport {
      if (restored) {
        return { modes, restoredNow: false, failure };
      }
      // Marked before the work, not after. A `destroy()` that throws partway has
      // still torn down whatever it reached, and a second attempt over
      // half-released native state is how a crash on the way out becomes a
      // crash the user sees instead of the diagnostic they needed.
      restored = true;
      open = null;
      try {
        renderer.off("resize", onResize);
        listeners.clear();
        renderer.destroy();
      } catch (thrown) {
        failure = safeDetail(thrown);
      }
      return { modes, restoredNow: true, failure };
    },
  };

  open = session;
  return ok(session);
}

/**
 * A restoration for a session that never opened.
 *
 * Returned so the failure path registers a participant like every other path
 * does. A participant that exists only on the success path is one that is
 * missing exactly when the terminal is most likely to be left broken.
 */
export function nothingToRestore(): RestorableTerminal {
  let restored = false;
  return {
    isRestored: () => restored,
    restore(): RestorationReport {
      const restoredNow = !restored;
      restored = true;
      return { modes: [], restoredNow, failure: null };
    },
  };
}
