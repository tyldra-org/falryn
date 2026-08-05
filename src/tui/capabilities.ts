/**
 * What this process knows about the terminal it might render into.
 *
 * The record *extends* the facts `src/domain/terminal.ts` already computes; it
 * recomputes none of them. Colour, character repertoire, TTY status, and size
 * are derived once, in the domain, from the environment and the handles — a
 * second derivation here would be a second answer to whether this terminal can
 * draw a character, and the two would disagree the first time one of them
 * learned about a new locale.
 *
 * What it adds is everything the domain has no business knowing: the hints that
 * say a session is remote, multiplexed, automated, or explicitly dumb, and — once
 * a renderer exists — the facts only a renderer can observe. Those two arrive at
 * different times, so the record carries a generation and says which source it
 * was built from. A consumer reading `renderer: null` knows the answer is
 * "not observed yet" rather than "not supported".
 *
 * Everything here is a fact or a declared hint. A hint is never promoted to a
 * fact, and the documented override exists precisely because detection can be
 * wrong on a terminal nobody has tried yet.
 *
 * This module imports no OpenTUI runtime value. It is reachable from the launch
 * decision, which has to be answerable on a run that must load no native
 * library at all.
 */

import type { ThemeMode } from "@opentui/core";
import { type EnvironmentPort, type TerminalCapabilities, terminalSize } from "../domain/index.ts";

/**
 * The variable that overrides detection.
 *
 * Documented rather than internal: the whole reason it exists is that a user on
 * a terminal Falryn has never been run against needs a way to refuse the shell
 * entirely without waiting for a release. Interactive runs otherwise have one
 * deliberate configuration: OpenTUI's alternate screen.
 */
export const SHELL_OVERRIDE_VARIABLE = "FALRYN_TUI";

/** The one value {@link SHELL_OVERRIDE_VARIABLE} accepts. */
export const SHELL_OVERRIDE_OFF = "off";

export type ShellOverride =
  /** Unset. The interactive shell opens in alternate-screen mode. */
  | { readonly kind: "none" }
  /** The shell is refused whatever the terminal reports. */
  | { readonly kind: "off" }
  /**
   * Set to something this build does not understand.
   *
   * Carried rather than silently discarded: a user who misspelled the value
   * would otherwise get default behavior and no way to tell that their override
   * did nothing.
   */
  | { readonly kind: "unrecognized"; readonly value: string };

/** Every legal value of the override, for a diagnostic that names them. */
export const SHELL_OVERRIDE_VALUES: readonly string[] = [SHELL_OVERRIDE_OFF];

export function readShellOverride(environment: EnvironmentPort): ShellOverride {
  const value = environment.get(SHELL_OVERRIDE_VARIABLE);
  if (value === null) {
    return { kind: "none" };
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === SHELL_OVERRIDE_OFF) {
    return { kind: "off" };
  }
  return { kind: "unrecognized", value: normalized };
}

export const MULTIPLEXERS = ["tmux", "screen", "zellij"] as const;

export type Multiplexer = (typeof MULTIPLEXERS)[number];

/**
 * Environment-derived hints about the session around the terminal.
 *
 * Hints, not facts, and the type name says so. Each is a strong signal that
 * something about rendering will behave differently — a multiplexer rewrites
 * escape sequences, a remote session adds latency to every capability query, an
 * automated run has no one at the keyboard — and none of them is a measurement.
 */
export type TerminalHints = {
  /** `TERM=dumb`: the terminal said it renders nothing beyond plain text. */
  readonly dumbTerminal: boolean;
  readonly multiplexer: Multiplexer | null;
  readonly remote: boolean;
  readonly ci: boolean;
};

/** Variables that name an automated run. `0` and `false` read as unset. */
const CI_VARIABLES = [
  "CI",
  "CONTINUOUS_INTEGRATION",
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
] as const;

/** Variables a remote shell sets. Any one of them is enough. */
const REMOTE_VARIABLES = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"] as const;

function isTruthy(value: string | null): boolean {
  if (value === null) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  // A CI variable exported as `false` is the ordinary way to say "not CI", and
  // reading a non-empty string as a yes would refuse the shell on a developer's
  // own machine.
  return normalized !== "0" && normalized !== "false";
}

function multiplexerIn(environment: EnvironmentPort): Multiplexer | null {
  if (environment.get("TMUX") !== null) {
    return "tmux";
  }
  if (environment.get("ZELLIJ") !== null) {
    return "zellij";
  }
  if (environment.get("STY") !== null) {
    return "screen";
  }
  // `TERM` is the fallback rather than the first check: a `screen-256color`
  // terminal outside a multiplexer is a real configuration, and the process
  // variables above are the ones the multiplexer itself sets.
  const term = environment.get("TERM") ?? "";
  if (term.startsWith("tmux")) {
    return "tmux";
  }
  return term.startsWith("screen") ? "screen" : null;
}

export function terminalHints(environment: EnvironmentPort): TerminalHints {
  return {
    dumbTerminal: environment.get("TERM") === "dumb",
    multiplexer: multiplexerIn(environment),
    remote: REMOTE_VARIABLES.some((variable) => environment.get(variable) !== null),
    ci: CI_VARIABLES.some((variable) => isTruthy(environment.get(variable))),
  };
}

/**
 * Facts only a live renderer can report.
 *
 * Every one of these is answered by the terminal replying to a query, so none
 * of them exists before a renderer has been created and none is guessed. A
 * terminal that never answered leaves the whole record `null` rather than
 * leaving each field with a default that would read as a measurement.
 */
export type RendererCapabilities = {
  /** Falryn's sole interactive renderer mode. */
  readonly screenMode: "alternate-screen";
  readonly columns: number;
  readonly rows: number;
  /** Whether the renderer currently has mouse reporting turned on. */
  readonly mouse: boolean;
  readonly focusEvents: boolean;
  readonly bracketedPaste: boolean;
  readonly kittyKeyboard: boolean;
  readonly hyperlinks: boolean;
  readonly synchronizedOutput: boolean;
  /** The terminal's reported light/dark preference, or `null` when it said nothing. */
  readonly themeMode: ThemeMode | null;
  /** The renderer's own view of the two hints the environment also suggests. */
  readonly remote: boolean;
  readonly multiplexer: string | null;
};

export const CAPABILITY_SOURCES = ["handles", "renderer"] as const;

/** Where a record's newest facts came from. Detection provenance, kept per record. */
export type CapabilitySource = (typeof CAPABILITY_SOURCES)[number];

export const FIRST_CAPABILITY_GENERATION = 1;

export type ShellCapabilities = {
  /**
   * Increments on every refresh.
   *
   * A consumer holding a stale record can tell it is stale without comparing
   * every field, which is what makes a resize or a capability reply something a
   * view can react to rather than something it has to poll for.
   */
  readonly generation: number;
  readonly source: CapabilitySource;
  /** The domain's answer, carried verbatim. Never recomputed here. */
  readonly handles: TerminalCapabilities;
  /** The usable size of the output handle, or `null` when it reports none. */
  readonly columns: number | null;
  readonly rows: number | null;
  readonly hints: TerminalHints;
  readonly override: ShellOverride;
  /** `null` until a renderer has observed them. Absent is absent. */
  readonly renderer: RendererCapabilities | null;
};

export type ShellCapabilitiesRequest = {
  readonly handles: TerminalCapabilities;
  readonly environment: EnvironmentPort;
};

/**
 * The record a run starts from, before any renderer exists.
 *
 * Size is read from the stdout handle — that is the handle the frames land on —
 * and put through the domain's own bound rather than trusted. The bound is
 * normally applied by the host adapter, but a capability value can also arrive
 * from a caller that assembled it by hand, and a zero or absurd width reaching
 * layout is the failure the bound exists to stop. Applying the domain's function
 * is using its answer, not computing a second one.
 */
export function shellCapabilities(request: ShellCapabilitiesRequest): ShellCapabilities {
  const { handles, environment } = request;
  return {
    generation: FIRST_CAPABILITY_GENERATION,
    source: "handles",
    handles,
    columns: terminalSize(handles.stdout.columns),
    rows: terminalSize(handles.stdout.rows),
    hints: terminalHints(environment),
    override: readShellOverride(environment),
    renderer: null,
  };
}

/** The record refreshed with what a live renderer observed. */
export function withRendererCapabilities(
  record: ShellCapabilities,
  renderer: RendererCapabilities,
): ShellCapabilities {
  return {
    ...record,
    generation: record.generation + 1,
    source: "renderer",
    // The renderer's own dimensions win once it has them: it is the thing
    // drawing, and a handle that changed size between startup and setup would
    // otherwise leave the record describing the terminal as it used to be.
    columns: renderer.columns,
    rows: renderer.rows,
    renderer,
  };
}

/**
 * The record refreshed after a resize.
 *
 * Zero or absurd dimensions are not written into the record as a size; a caller
 * that hands them over gets a record reporting none, which is what pauses
 * rendering rather than laying out against a terminal that does not exist.
 */
export function withSize(
  record: ShellCapabilities,
  columns: number | null,
  rows: number | null,
): ShellCapabilities {
  if (record.columns === columns && record.rows === rows) {
    return record;
  }
  return { ...record, generation: record.generation + 1, columns, rows };
}

/** Whether the record describes a terminal with a usable size. */
export function hasUsableSize(record: ShellCapabilities): boolean {
  return record.columns !== null && record.rows !== null;
}

/**
 * Whether to ask the terminal for mouse reporting.
 *
 * ## There is no terminal mouse capability to gate on
 *
 * #392 was planned around refreshing the record after a renderer exists and
 * reading whether the terminal has a mouse. It does not report one.
 * `TerminalCapabilities` in the installed OpenTUI declares kitty keyboard,
 * graphics, colour, unicode, focus tracking, sync, bracketed paste, hyperlinks,
 * OSC 52, notifications, remote, and multiplexer — and no mouse. Nor could it
 * usefully: mouse reporting is a *mode a program turns on*, not a property a
 * terminal answers a query about, and `observeRenderer` records
 * `mouse: renderer.useMouse`, which is this program's own setting reflected
 * back. Gating on it would have been circular — reporting can only be on if
 * reporting is already on — and the feature would never have enabled once.
 *
 * So the gate is the two things that are real. A dumb terminal is refused,
 * because a terminal that cannot address a cell cannot report a click in one.
 * And the user has to want it: #392 gave that its own key rather than inferring
 * it, because turning reporting on takes text selection away from the terminal
 * emulator — dragging selects inside Falryn, and the emulator's own selection
 * needs a modifier bypass that differs per emulator. That is a real cost paid by
 * every user of the default, so it is a setting rather than a consequence.
 *
 * Nothing else needs gating here. The launch decision has already refused every
 * run whose handles are not a terminal, so a renderer only exists where there is
 * one to report into.
 *
 * `wanted` is `boolean | undefined`, and `undefined` is off. A caller that
 * composed no service graph resolves no configuration — every rendered check
 * that mounts a shell directly is one — and an unanswered question is not a yes.
 */
export function usesMouse(record: ShellCapabilities, wanted: boolean | undefined): boolean {
  return wanted === true && !record.hints.dumbTerminal;
}

export const POINTER_KEY = "interface.pointer.enabled";
