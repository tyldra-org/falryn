/**
 * Which renderer mode the shell runs in.
 *
 * Renderer mode is explicit application state rather than a constant chosen at
 * the call to `createCliRenderer`, because a mode change has to preserve
 * application state and the semantic event cursor — and something that is only
 * ever an argument cannot be changed and reasoned about.
 *
 * The delivered default is `split-footer`, and #22 is why it is allowed to be:
 * a compiled artifact created a real split-footer renderer, and the one thing
 * documentation could not answer — what its stdout capture does to the handle
 * `src/cli/streams.ts` owns — was measured rather than assumed. That measurement
 * is the reason {@link EXTERNAL_OUTPUT_MODE} is stated here with the reasoning
 * attached rather than left at a library default.
 *
 * `main-screen` still reserves a buffered render region. It is a conservative
 * mode, not a separate true inline backend, and nothing here may describe it as
 * one.
 *
 * Selection is pure and imports no OpenTUI runtime value.
 */

import type { ExternalOutputMode, ScreenMode } from "@opentui/core";
import type { ShellCapabilities } from "./capabilities.ts";

/**
 * Rows the live footer occupies in `split-footer`.
 *
 * Small on purpose: everything above it is the terminal's own scrollback, which
 * is the entire reason the transcript-first design prefers this mode.
 */
export const SPLIT_FOOTER_HEIGHT = 6;

/**
 * Every mode Falryn selects, documents, and must be able to start.
 *
 * Declared here rather than left implicit in a union, because a list is
 * something a test can iterate. #351 shipped with two of the three unable to
 * construct at all, and the reason nothing caught it is that no check ever
 * walked the modes — each was named individually, in the places somebody
 * remembered to name it.
 */
export const SCREEN_MODES: readonly ScreenMode[] = [
  "split-footer",
  "alternate-screen",
  "main-screen",
];

/**
 * Rows a terminal needs before a footer is worth reserving.
 *
 * A footer that leaves nothing above it is an alternate screen with extra
 * steps, so a terminal this short gets the mode that admits it.
 */
export const MIN_SPLIT_FOOTER_ROWS = SPLIT_FOOTER_HEIGHT + 4;

/**
 * How output written to stdout is treated while the renderer is alive.
 *
 * `capture-stdout` rather than `passthrough`, and it is the load-bearing half of
 * the stdout reconciliation in `renderer-session.ts`. In `split-footer` the
 * renderer intercepts `stdout.write` and replays what it takes above the footer;
 * `passthrough` would let a stray write land in the middle of a frame and tear
 * it. Capture is safe here only because the launch decision has already refused
 * every machine format, so no result record can be in flight — see
 * {@link ../launch.ts}.
 */
export const EXTERNAL_OUTPUT_MODE: ExternalOutputMode = "capture-stdout";

export type ScreenModeSelection = {
  readonly mode: ScreenMode;
  /**
   * Why this mode, in the vocabulary the record and the override speak.
   *
   * Carried so a diagnostic can say what decided rather than only what was
   * chosen, which is the difference between "split-footer" and "split-footer,
   * because you asked for it".
   */
  readonly reason: ScreenModeReason;
};

export const SCREEN_MODE_REASONS = [
  /** The documented override named it. */
  "override",
  /** The transcript-first default, qualified by #22. */
  "transcript-first",
  /** Too few rows to reserve a footer and still have something above it. */
  "insufficient-rows",
] as const;

export type ScreenModeReason = (typeof SCREEN_MODE_REASONS)[number];

/**
 * The mode this run should use.
 *
 * Only called after {@link ../launch.ts} decided to launch, so the record is
 * known to describe a terminal with a usable size. A record without one still
 * resolves rather than throwing — selection is not the layer that refuses a
 * terminal — and resolves to the mode that needs the least of it.
 */
export function selectScreenMode(capabilities: ShellCapabilities): ScreenModeSelection {
  if (capabilities.override.kind === "mode") {
    return { mode: capabilities.override.mode, reason: "override" };
  }

  const rows = capabilities.rows;
  if (rows === null || rows < MIN_SPLIT_FOOTER_ROWS) {
    // The full viewport, since there is not enough of it to share. Not
    // `main-screen`: a short terminal is exactly where a buffered region
    // overlapping the user's scrollback is most visible.
    return { mode: "alternate-screen", reason: "insufficient-rows" };
  }

  return { mode: "split-footer", reason: "transcript-first" };
}

/** Whether a mode reserves the footer, and so needs {@link SPLIT_FOOTER_HEIGHT}. */
export function reservesFooter(mode: ScreenMode): boolean {
  return mode === "split-footer";
}

/**
 * Whether the renderer takes ownership of stdout in this mode.
 *
 * Only `split-footer` intercepts it: the other two modes leave the handle alone
 * because they have nowhere to replay captured output to. Stated as a function
 * rather than inlined because the restoration contract and the tests that prove
 * it both need the same answer.
 */
export function capturesStdout(mode: ScreenMode): boolean {
  return mode === "split-footer" && EXTERNAL_OUTPUT_MODE === "capture-stdout";
}
